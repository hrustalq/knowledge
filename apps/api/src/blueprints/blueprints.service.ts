import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BUILT_IN_BLUEPRINT_KEYS,
  isBuiltInBlueprintKey,
  type Blueprint,
  type BlueprintEntry,
  type ListBlueprintsResponse,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { t } from '../i18n/t.js';
import { parseBlueprint } from './blueprint.schema.js';
import { BUILT_IN_BLUEPRINTS } from './built-in/index.js';

const BLUEPRINTS_MAX_PER_WORKSPACE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const withCurrent = { versions: { orderBy: { version: 'desc' }, take: 1 } } as const;
type Row = Prisma.ProjectBlueprintGetPayload<{ include: typeof withCurrent }>;

/**
 * Saved blueprints (#716), on the template model: built-ins are code, a row
 * either adds a blueprint or overrides a built-in (new content, or
 * `enabled = false` to hide it), and every content change appends an
 * immutable version. Nothing pins a blueprint — a scaffold copies it — so a
 * saved one is deleted outright, and deleting an override resets the built-in.
 */
@Injectable()
export class BlueprintsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, includeDisabled = false): Promise<ListBlueprintsResponse> {
    const rows = await this.prisma.projectBlueprint.findMany({
      where: { workspaceId },
      include: withCurrent,
      orderBy: { createdAt: 'desc' },
    });
    const overrides = new Map(rows.filter((r) => r.builtInKey).map((r) => [r.builtInKey!, r]));
    const entries: BlueprintEntry[] = [
      ...BUILT_IN_BLUEPRINT_KEYS.map((key) => this.builtInEntry(key, overrides.get(key))),
      ...rows.filter((r) => !r.builtInKey).map((r) => this.entry(r)),
    ];
    return { blueprints: entries.filter((e) => includeDisabled || e.enabled) };
  }

  /**
   * The blueprint `key` names in this workspace, as scaffold takes it: a
   * built-in key (with its override applied) or a saved blueprint's id. A
   * hidden or unknown one is a 404 — a key the list does not offer is not one.
   */
  async resolve(workspaceId: string, key: string): Promise<Blueprint> {
    const notFound = () => new NotFoundException(t('error.blueprint.notFound', { key }));
    if (isBuiltInBlueprintKey(key)) {
      const row = await this.prisma.projectBlueprint.findFirst({ where: { workspaceId, builtInKey: key }, include: withCurrent });
      const entry = this.builtInEntry(key, row ?? undefined);
      if (!entry.enabled) throw notFound();
      return entry.blueprint;
    }
    if (!UUID_RE.test(key)) throw notFound();
    const row = await this.prisma.projectBlueprint.findFirst({
      where: { id: key, workspaceId, builtInKey: null, enabled: true },
      include: withCurrent,
    });
    // Re-parsed: a version stored under an older schema must not skip today's checks.
    if (!row?.versions[0]) throw notFound();
    return parseBlueprint(row.versions[0].blueprint);
  }

  /** A saved blueprint, or (with `builtInKey`) the workspace's one override of a built-in. */
  async create(
    workspaceId: string,
    input: { builtInKey?: string; blueprint?: unknown; enabled?: boolean },
    userId: string,
  ): Promise<BlueprintEntry> {
    const total = await this.prisma.projectBlueprint.count({ where: { workspaceId } });
    if (total >= BLUEPRINTS_MAX_PER_WORKSPACE) {
      throw new ConflictException(t('error.blueprint.limitReached', { max: BLUEPRINTS_MAX_PER_WORKSPACE }));
    }
    if (input.builtInKey !== undefined) {
      if (!isBuiltInBlueprintKey(input.builtInKey)) throw new NotFoundException(t('error.blueprint.notFound', { key: input.builtInKey }));
      // App-side uniqueness, the template override's rule: a race can insert
      // two; the list reads one, and a reset of it lets the other take over.
      const existing = await this.prisma.projectBlueprint.findFirst({ where: { workspaceId, builtInKey: input.builtInKey }, select: { id: true } });
      if (existing) throw new ConflictException({ statusCode: 409, message: t('error.blueprint.alreadyCustomized'), blueprintId: existing.id });
    }
    const blueprint = input.blueprint === undefined ? null : parseBlueprint(input.blueprint);
    if (!blueprint && input.builtInKey === undefined) throw new BadRequestException(t('error.blueprint.contentRequired'));
    const row = await this.prisma.projectBlueprint.create({
      data: {
        workspaceId,
        builtInKey: input.builtInKey ?? null,
        currentVersion: blueprint ? 1 : 0,
        enabled: input.enabled ?? true,
        createdBy: userId,
        ...(blueprint ? { versions: { create: { version: 1, blueprint: json(blueprint), createdBy: userId } } } : {}),
      },
      include: withCurrent,
    });
    return this.entryOf(row);
  }

  /** A changed blueprint appends a version; `enabled` does not. */
  async update(id: string, input: { blueprint?: unknown; enabled?: boolean }, userId: string): Promise<BlueprintEntry> {
    const row = await this.requireRow(id);
    const blueprint = input.blueprint === undefined ? null : parseBlueprint(input.blueprint);
    // jsonb stores keys in its own order, so compare a key-sorted form.
    const changed = blueprint && canonical(blueprint) !== canonical(row.versions[0]?.blueprint ?? null);
    const version = row.currentVersion + 1;
    const updated = await this.prisma.projectBlueprint.update({
      where: { id },
      data: {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(changed ? { currentVersion: version, versions: { create: { version, blueprint: json(blueprint), createdBy: userId } } } : {}),
      },
      include: withCurrent,
    });
    return this.entryOf(updated);
  }

  /** One guarded statement: a second delete (or a race) is a 404, not a 500. */
  async remove(id: string): Promise<void> {
    const { count } = await this.prisma.projectBlueprint.deleteMany({ where: { id } });
    if (!count) throw new NotFoundException(t('error.blueprint.notFound', { key: id }));
  }

  private async requireRow(id: string): Promise<Row> {
    const row = await this.prisma.projectBlueprint.findUnique({ where: { id }, include: withCurrent });
    if (!row) throw new NotFoundException(t('error.blueprint.notFound', { key: id }));
    return row;
  }

  private entryOf(row: Row): BlueprintEntry {
    return row.builtInKey && isBuiltInBlueprintKey(row.builtInKey) ? this.builtInEntry(row.builtInKey, row) : this.entry(row);
  }

  private builtInEntry(key: (typeof BUILT_IN_BLUEPRINT_KEYS)[number], row: Row | undefined): BlueprintEntry {
    const own = row?.versions[0];
    return {
      key,
      builtIn: true,
      id: row?.id ?? null,
      enabled: row?.enabled ?? true,
      version: own ? row.currentVersion : 0,
      blueprint: own ? (own.blueprint as unknown as Blueprint) : BUILT_IN_BLUEPRINTS[key],
    };
  }

  private entry(row: Row): BlueprintEntry {
    return {
      key: row.id,
      builtIn: false,
      id: row.id,
      enabled: row.enabled,
      version: row.currentVersion,
      blueprint: row.versions[0]!.blueprint as unknown as Blueprint,
    };
  }
}

const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
const json = (blueprint: Blueprint) => blueprint as unknown as Prisma.InputJsonValue;
