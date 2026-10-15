import { createHash } from 'node:crypto';
import {
  AI_SKILL_INSTRUCTIONS_MAX,
  GUIDANCE_FILE_MAX_BYTES,
  GUIDANCE_MAX_FILES,
  guidancePaths,
  type RepoGuidanceImportResponse,
} from '@knowledge/contracts';

/**
 * The pure half of the repo guidance import (#70): which guidance files a
 * repository holds, and what each one does to the skills already imported
 * from it. No Prisma, no network — `RepoGuidanceService` applies the plan.
 */

/** One guidance file as read from the archive. */
export interface GuidanceFile {
  path: string;
  /** The whole file, decoded. */
  text: string;
  /** SHA-256 of the file's bytes — what decides "changed upstream". */
  sha: string;
}

export interface GuidanceRead {
  /** Every guidance path present upstream, read or not. Absence from here is what "removed" means. */
  present: Set<string>;
  files: GuidanceFile[];
  skipped: RepoGuidanceImportResponse['skipped'];
}

/** The columns of an imported skill the planner reads. */
export interface ImportedSkill {
  id: string;
  sourcePath: string | null;
  sourceSha: string | null;
  enabled: boolean;
  instructions: string;
  pendingInstructions: string | null;
  sourceRemovedAt: Date | null;
}

export type GuidanceOp =
  | { kind: 'create'; file: GuidanceFile; instructions: string }
  /** A disabled skill: nothing trusts its text yet, so the new upstream text replaces it. */
  | { kind: 'replace'; id: string; file: GuidanceFile; instructions: string }
  /** An enabled skill: the new text waits in `pending_instructions` for an admin. */
  | { kind: 'pending'; id: string; file: GuidanceFile; instructions: string }
  /** Upstream now says what the skill already says — record the sha, drop any pending text. */
  | { kind: 'settle'; id: string; file: GuidanceFile }
  /** The file came back unchanged after being removed. The skill stays disabled. */
  | { kind: 'restore'; id: string }
  | { kind: 'remove'; id: string };

/**
 * The guidance files among an archive's, at the repository root and at
 * `subdir`'s root. A file over `GUIDANCE_FILE_MAX_BYTES`, an empty one and
 * anything past `GUIDANCE_MAX_FILES` is reported, not read — but still counts
 * as present, so the skill it once became is not disabled for it.
 */
export function readGuidanceFiles(archive: ReadonlyMap<string, Uint8Array>, subdir: string): GuidanceRead {
  const paths = guidancePaths(archive.keys(), subdir);
  const decoder = new TextDecoder();
  const files: GuidanceFile[] = [];
  const skipped: GuidanceRead['skipped'] = [];
  for (const path of paths) {
    const bytes = archive.get(path)!;
    if (bytes.byteLength > GUIDANCE_FILE_MAX_BYTES) {
      skipped.push({ path, reason: 'oversize' });
      continue;
    }
    const text = decoder.decode(bytes).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
    if (!text) {
      skipped.push({ path, reason: 'empty' });
      continue;
    }
    if (files.length >= GUIDANCE_MAX_FILES) {
      skipped.push({ path, reason: 'limit' });
      continue;
    }
    files.push({ path, text, sha: createHash('sha256').update(bytes).digest('hex') });
  }
  return { present: new Set(paths), files, skipped };
}

/**
 * The file's text as a skill can hold it: whole when it fits the skill budget,
 * otherwise cut at the last line break before it. A skill over the budget
 * would never join a turn (`AiSkillsService.forTurn` skips it), so storing the
 * whole of a long `CLAUDE.md` would import something that silently does nothing.
 */
export function clipInstructions(text: string): { instructions: string; truncated: boolean } {
  if (text.length <= AI_SKILL_INSTRUCTIONS_MAX) return { instructions: text, truncated: false };
  const head = text.slice(0, AI_SKILL_INSTRUCTIONS_MAX);
  const lineEnd = head.lastIndexOf('\n');
  // A cut far back from the budget would throw away most of it; past that, mid-line it is.
  const cut = lineEnd > AI_SKILL_INSTRUCTIONS_MAX * 0.75 ? lineEnd : AI_SKILL_INSTRUCTIONS_MAX;
  return { instructions: head.slice(0, cut).trimEnd(), truncated: true };
}

/**
 * What one import does to the skills already imported from this connector.
 *
 * The rule the whole feature rests on: **an enabled skill's live text never
 * changes because of a commit.** Enabling an imported file is the act that
 * makes fetched bytes trusted, so new upstream text goes to `pending` and an
 * admin accepts it. A disabled skill is trusted by nobody yet and simply
 * follows upstream.
 */
export function planGuidanceImport(existing: readonly ImportedSkill[], read: GuidanceRead): GuidanceOp[] {
  const byPath = new Map(existing.filter((s) => s.sourcePath).map((s) => [s.sourcePath!, s]));
  const ops: GuidanceOp[] = [];

  for (const file of read.files) {
    const skill = byPath.get(file.path);
    const { instructions } = clipInstructions(file.text);
    if (!skill) {
      ops.push({ kind: 'create', file, instructions });
      continue;
    }
    if (skill.sourceSha === file.sha) {
      if (skill.sourceRemovedAt) ops.push({ kind: 'restore', id: skill.id });
      continue;
    }
    if (!skill.enabled) ops.push({ kind: 'replace', id: skill.id, file, instructions });
    else if (instructions === skill.instructions) ops.push({ kind: 'settle', id: skill.id, file });
    else ops.push({ kind: 'pending', id: skill.id, file, instructions });
  }

  for (const skill of existing) {
    if (skill.sourcePath && !read.present.has(skill.sourcePath) && !skill.sourceRemovedAt) {
      ops.push({ kind: 'remove', id: skill.id });
    }
  }
  return ops;
}

/**
 * A skill name for an imported file, unique in the workspace: `<connector>/<path>`,
 * then ` (2)`, ` (3)`… when a skill already holds it. Within the DTO's 120.
 */
export function guidanceSkillName(connectorName: string, path: string, taken: ReadonlySet<string>): string {
  const base = `${connectorName}/${path}`.slice(0, 112);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const name = `${base} (${n})`;
    if (!taken.has(name)) return name;
  }
}
