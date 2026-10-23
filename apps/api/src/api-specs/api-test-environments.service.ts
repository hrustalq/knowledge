import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ApiTestEnvironment as Row } from '@prisma/client';
import type { ApiTestEnvironment, SaveApiTestEnvironmentRequest } from '@knowledge/contracts';
import { MissingEncryptionKeyError, decryptSecret, encryptSecret, parseKey } from '../ai/secret-box.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** A plan's value name: `input.currency`, `secret.qaPassword`, `TOKEN`. */
const VALUE_NAME = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/u;
const MAX_VALUES = 50;

/**
 * Test environments for the QA server runner (#483, phase 5): a server URL,
 * non-secret inputs, and secrets in one `ai/secret-box.ts` envelope. Secrets
 * are write-only over the API — set, replaced, removed by name, never read
 * back. Only the worker decrypts them (`values`), when a run executes.
 */
@Injectable()
export class ApiTestEnvironmentsService {
  private readonly key: Buffer | null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.key = parseKey(config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
  }

  async list(workspaceId: string): Promise<ApiTestEnvironment[]> {
    const rows = await this.prisma.apiTestEnvironment.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } });
    return rows.map(toInfo);
  }

  async byName(workspaceId: string, name: string): Promise<ApiTestEnvironment | null> {
    const row = await this.prisma.apiTestEnvironment.findUnique({ where: { workspaceId_name: { workspaceId, name: name.trim() } } });
    return row ? toInfo(row) : null;
  }

  async create(workspaceId: string, dto: SaveApiTestEnvironmentRequest, userId: string): Promise<ApiTestEnvironment> {
    const name = checkName(dto.name);
    const secrets = mergeSecrets({}, dto.secrets);
    try {
      const row = await this.prisma.apiTestEnvironment.create({
        data: {
          workspaceId,
          name,
          server: checkServer(dto.server ?? null),
          inputs: checkValues(dto.inputs ?? {}),
          ...this.seal(secrets),
          createdBy: userId,
          updatedBy: userId,
        },
      });
      return toInfo(row);
    } catch (e) {
      throw duplicate(e, name);
    }
  }

  async update(workspaceId: string, id: string, dto: SaveApiTestEnvironmentRequest, userId: string): Promise<ApiTestEnvironment> {
    const row = await this.find(workspaceId, id);
    const name = dto.name === undefined ? row.name : checkName(dto.name);
    const data: Prisma.ApiTestEnvironmentUpdateInput = { name, updatedBy: userId };
    if (dto.server !== undefined) data.server = checkServer(dto.server);
    if (dto.inputs !== undefined) data.inputs = checkValues(dto.inputs);
    if (dto.secrets !== undefined) Object.assign(data, this.seal(mergeSecrets(this.open(row), dto.secrets)));
    try {
      return toInfo(await this.prisma.apiTestEnvironment.update({ where: { id }, data }));
    } catch (e) {
      throw duplicate(e, name);
    }
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.find(workspaceId, id);
    await this.prisma.apiTestEnvironment.delete({ where: { id } });
  }

  /**
   * What a run sends with: the server, and every value by plan name — inputs,
   * then secrets. Null when the environment is gone. A secret envelope that no
   * longer decrypts (a rotated key) refuses rather than running without it.
   */
  async values(workspaceId: string, id: string): Promise<{ name: string; server: string | null; values: Record<string, string> } | null> {
    const row = await this.prisma.apiTestEnvironment.findFirst({ where: { id, workspaceId } });
    if (!row) return null;
    return { name: row.name, server: row.server, values: { ...(row.inputs as Record<string, string>), ...this.open(row) } };
  }

  private async find(workspaceId: string, id: string): Promise<Row> {
    const row = await this.prisma.apiTestEnvironment.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException(t('error.apiTestEnvironment.notFound', { id }));
    return row;
  }

  private open(row: Row): Record<string, string> {
    if (!row.secretsCipher) return {};
    const plain = decryptSecret(row.secretsCipher, this.key);
    if (plain === null) throw new BadRequestException(t('error.apiTestEnvironment.unreadable', { name: row.name }));
    return JSON.parse(plain) as Record<string, string>;
  }

  private seal(secrets: Record<string, string>): { secretsCipher: string | null; secretNames: string[] } {
    const names = Object.keys(secrets).sort();
    if (!names.length) return { secretsCipher: null, secretNames: [] };
    try {
      return { secretsCipher: encryptSecret(JSON.stringify(secrets), this.key), secretNames: names };
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
    updatedAt: row.updatedAt.toISOString(),
  };
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
