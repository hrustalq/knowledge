import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ApiTestEnvironment as Row } from '@prisma/client';
import type { ApiTestEnvironment, SaveApiTestEnvironmentRequest } from '@knowledge/contracts';
import { MissingEncryptionKeyError, decryptSecret, encryptSecret, parseKey } from '../ai/secret-box.js';
import { slots } from '../ai/secret-slots.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import type { AccessScope } from '../permissions/access-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** A plan's value name: `input.currency`, `secret.qaPassword`, `TOKEN`. */
const VALUE_NAME = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/u;
const MAX_VALUES = 50;
const MAX_ORIGINS = 20;

/**
 * Test environments for the QA server runner (#483, phase 5): a server URL,
 * non-secret inputs, and secrets in one `ai/secret-box.ts` envelope. Secrets
 * are write-only over the API — set, replaced, removed by name, never read
 * back. Only the worker decrypts them (`values`), when a run executes.
 *
 * A run sends a secret only to the environment's own server or to an origin in
 * `secretOrigins`. Adding either is a new place for the stored secrets to go,
 * so such a change keeps only the secrets it sets itself: whoever points an
 * environment somewhere new has to know its secrets, not just inherit them.
 *
 * An environment may belong to one project (#925): then only suites of that
 * project's documents may run with it. `usableBy` is that rule, read by the
 * list, by a run's start and again by the worker when it opens the secrets.
 * Widening who may use it (project → shared, or another project) is "somewhere
 * new" too. An environment of a project the caller cannot open is not found.
 */
export interface ApiTestEnvironmentValues {
  name: string;
  server: string | null;
  /** Non-secret values, by plan name. */
  values: Record<string, string>;
  secrets: Record<string, string>;
  /** Every origin a secret may be sent to: the server's and the listed ones. */
  secretOrigins: string[];
}

@Injectable()
export class ApiTestEnvironmentsService {
  private readonly key: Buffer | null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.key = parseKey(config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
  }

  /**
   * Every environment the caller may see; narrowed to the ones a suite of one
   * project may use (shared + its own) when `for` names the project or one of
   * its documents. An unknown document narrows to the shared ones.
   */
  async list(scope: AccessScope, usedBy: { projectId?: string; documentId?: string } = {}): Promise<ApiTestEnvironment[]> {
    const { workspaceId } = scope;
    const narrowed = usedBy.projectId !== undefined || usedBy.documentId !== undefined;
    const projectId =
      usedBy.projectId ??
      (usedBy.documentId
        ? (await this.prisma.document.findFirst({ where: { id: usedBy.documentId, workspaceId }, select: { projectId: true } }))?.projectId
        : undefined);
    const rows = await this.prisma.apiTestEnvironment.findMany({
      where: { workspaceId, ...(narrowed ? { OR: [{ projectId: null }, ...(projectId ? [{ projectId }] : [])] } : {}) },
      orderBy: { name: 'asc' },
    });
    return rows.filter((row) => seesProject(scope, row.projectId)).map(toInfo);
  }

  async byName(workspaceId: string, name: string): Promise<ApiTestEnvironment | null> {
    const row = await this.prisma.apiTestEnvironment.findUnique({ where: { workspaceId_name: { workspaceId, name: name.trim() } } });
    return row ? toInfo(row) : null;
  }

  // ponytail: environment writes are not audited; add an AUDIT_ACTIONS value when credential changes need a trail.
  async create(scope: AccessScope, dto: SaveApiTestEnvironmentRequest, userId: string): Promise<ApiTestEnvironment> {
    const { workspaceId } = scope;
    const name = checkName(dto.name);
    const secrets = mergeSecrets({}, dto.secrets);
    const projectId = await this.checkProject(scope, dto.projectId ?? null);
    try {
      const id = randomUUID();
      const row = await this.prisma.apiTestEnvironment.create({
        data: {
          id,
          workspaceId,
          name,
          server: checkServer(dto.server ?? null),
          inputs: checkValues(dto.inputs ?? {}),
          secretOrigins: checkOrigins(dto.secretOrigins ?? []),
          projectId,
          ...this.seal(secrets, { id, workspaceId }),
          createdBy: userId,
          updatedBy: userId,
        },
      });
      return toInfo(row);
    } catch (e) {
      throw duplicate(e, name);
    }
  }

  async update(scope: AccessScope, id: string, dto: SaveApiTestEnvironmentRequest, userId: string): Promise<ApiTestEnvironment> {
    const row = await this.find(scope, id);
    const name = dto.name === undefined ? row.name : checkName(dto.name);
    const data: Prisma.ApiTestEnvironmentUpdateInput = { name, updatedBy: userId };
    if (dto.server !== undefined) data.server = checkServer(dto.server);
    if (dto.inputs !== undefined) data.inputs = checkValues(dto.inputs);
    if (dto.secretOrigins !== undefined) data.secretOrigins = checkOrigins(dto.secretOrigins);
    const projectId = dto.projectId === undefined ? row.projectId : await this.checkProject(scope, dto.projectId);
    data.projectId = projectId;
    const before = secretDestinations(row.server, row.secretOrigins);
    const after = secretDestinations(
      dto.server !== undefined ? (data.server as string | null) : row.server,
      dto.secretOrigins !== undefined ? (data.secretOrigins as string[]) : row.secretOrigins,
    );
    // Binding a shared environment narrows who may use it; any other change of project widens.
    const shared = projectId !== row.projectId && row.projectId !== null;
    const widened = shared || [...after].some((origin) => !before.has(origin));
    if (widened) Object.assign(data, this.seal(mergeSecrets({}, dto.secrets), row));
    else if (dto.secrets !== undefined) Object.assign(data, this.seal(mergeSecrets(this.open(row), dto.secrets), row));
    try {
      return toInfo(await this.prisma.apiTestEnvironment.update({ where: { id }, data }));
    } catch (e) {
      throw duplicate(e, name);
    }
  }

  async remove(scope: AccessScope, id: string): Promise<void> {
    await this.find(scope, id);
    await this.prisma.apiTestEnvironment.delete({ where: { id } });
  }

  /**
   * The environment a suite of `documentId` may run with (#925): in the same
   * workspace, and shared or bound to that document's project. Anything else
   * is "not found" — a foreign project's environment is not named, let alone
   * opened. Checked when a run is started and again when its secrets are read.
   */
  async usableBy(workspaceId: string, id: string, documentId: string): Promise<Row | null> {
    const row = await this.prisma.apiTestEnvironment.findFirst({ where: { id, workspaceId } });
    if (!row || row.projectId === null) return row;
    const document = await this.prisma.document.findFirst({ where: { id: documentId, workspaceId }, select: { projectId: true } });
    return document?.projectId === row.projectId ? row : null;
  }

  /**
   * What a run sends with: the server, the inputs by plan name, and the
   * secrets with the origins they may go to. A secret wins over an input of
   * the same name, so that input is left out. Null when the environment is
   * gone, or no longer usable by the suite's document. A secret envelope that
   * no longer decrypts (a rotated key) refuses rather than running without it.
   */
  async values(workspaceId: string, id: string, documentId: string): Promise<ApiTestEnvironmentValues | null> {
    const row = await this.usableBy(workspaceId, id, documentId);
    if (!row) return null;
    const secrets = this.open(row);
    const inputs = Object.fromEntries(Object.entries(row.inputs as Record<string, string>).filter(([name]) => !(name in secrets)));
    return { name: row.name, server: row.server, values: inputs, secrets, secretOrigins: [...secretDestinations(row.server, row.secretOrigins)] };
  }

  private async find(scope: AccessScope, id: string): Promise<Row> {
    const row = await this.prisma.apiTestEnvironment.findFirst({ where: { id, workspaceId: scope.workspaceId } });
    if (!row || !seesProject(scope, row.projectId)) throw new NotFoundException(t('error.apiTestEnvironment.notFound', { id }));
    return row;
  }

  /** A project of this workspace that the caller may open, or null for shared. */
  private async checkProject(scope: AccessScope, projectId: string | null): Promise<string | null> {
    if (!projectId) return null;
    const project = await this.prisma.project.findFirst({ where: { id: projectId, workspaceId: scope.workspaceId }, select: { id: true } });
    if (!project || !seesProject(scope, projectId)) throw new NotFoundException(t('error.project.notFound', { id: projectId }));
    return projectId;
  }

  private open(row: Row): Record<string, string> {
    if (!row.secretsCipher) return {};
    const plain = decryptSecret(row.secretsCipher, this.key, slots.apiTestEnvironmentSecrets(row));
    if (plain === null) throw new BadRequestException(t('error.apiTestEnvironment.unreadable', { name: row.name }));
    return JSON.parse(plain) as Record<string, string>;
  }

  private seal(secrets: Record<string, string>, row: { id: string; workspaceId: string }): { secretsCipher: string | null; secretNames: string[] } {
    const names = Object.keys(secrets).sort();
    if (!names.length) return { secretsCipher: null, secretNames: [] };
    try {
      return { secretsCipher: encryptSecret(JSON.stringify(secrets), this.key, slots.apiTestEnvironmentSecrets(row)), secretNames: names };
    } catch (e) {
      if (e instanceof MissingEncryptionKeyError) throw new BadRequestException(t('error.apiTestEnvironment.keyMissing'));
      throw e;
    }
  }
}

function toInfo(row: Row): ApiTestEnvironment {
  return {
    id: row.id,
    name: row.name,
    server: row.server,
    inputs: row.inputs as Record<string, string>,
    secrets: row.secretNames,
    secretOrigins: row.secretOrigins,
    projectId: row.projectId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A restricted project the caller holds no grant on hides its environments; shared ones are everyone's. */
function seesProject(scope: AccessScope, projectId: string | null): boolean {
  return projectId === null || scope.bypass || !scope.denied.has(projectId);
}

function checkName(raw: string | undefined): string {
  const name = raw?.trim() ?? '';
  if (!name || name.length > 80) throw new BadRequestException(t('error.apiTestEnvironment.name'));
  return name;
}

/** An absolute http(s) URL with no credentials in it; the runner still sends only to a server the spec declares. */
function checkServer(raw: string | null): string | null {
  const value = raw?.trim() ?? '';
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException(t('error.apiTestEnvironment.server', { url: value }));
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new BadRequestException(t('error.apiTestEnvironment.server', { url: value }));
  }
  return value.replace(/\/+$/u, '');
}

/** Each an absolute http(s) URL with no credentials, kept as its origin. */
function checkOrigins(raw: string[]): string[] {
  if (raw.length > MAX_ORIGINS) throw new BadRequestException(t('error.apiTestEnvironment.tooMany', { max: MAX_ORIGINS }));
  const origins = raw.map((value) => new URL(checkServer(value) ?? fail(value)).origin);
  return [...new Set(origins)].sort();
}

function fail(value: string): never {
  throw new BadRequestException(t('error.apiTestEnvironment.server', { url: value }));
}

/** The origins a run may send this environment's secrets to. */
export function secretDestinations(server: string | null, origins: readonly string[]): Set<string> {
  return new Set([...(server ? [new URL(server).origin] : []), ...origins]);
}

function checkValues(values: Record<string, unknown>): Record<string, string> {
  const entries = Object.entries(values);
  if (entries.length > MAX_VALUES) throw new BadRequestException(t('error.apiTestEnvironment.tooMany', { max: MAX_VALUES }));
  for (const [name, value] of entries) {
    if (!VALUE_NAME.test(name)) throw new BadRequestException(t('error.apiTestEnvironment.valueName', { name }));
    if (typeof value !== 'string' || value.length > 4000) throw new BadRequestException(t('error.apiTestEnvironment.value', { name }));
  }
  return values as Record<string, string>;
}

/** The stored secrets with a patch applied: a string sets or replaces, null removes. */
function mergeSecrets(current: Record<string, string>, patch: Record<string, string | null> | undefined): Record<string, string> {
  const next = { ...current };
  for (const [name, value] of Object.entries(patch ?? {})) {
    if (value === null) delete next[name];
    else next[name] = value;
  }
  return checkValues(next);
}

function duplicate(e: unknown, name: string): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    return new ConflictException(t('error.apiTestEnvironment.duplicate', { name }));
  }
  return e;
}
