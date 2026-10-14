import { createHash } from 'node:crypto';
import { JSON_SCHEMA, load } from 'js-yaml';
import { z } from 'zod';
import {
  WIKI_CONFIG_PATH,
  WIKI_EFFORT_LEVELS,
  WIKI_MAX_FLOWS,
  WIKI_MAX_GLOB_LENGTH,
  WIKI_MAX_GLOBS,
  WIKI_SECTIONS,
  type WikiSteeringConfig,
} from '@knowledge/contracts';
import { globToRegExp } from '../../common/glob.js';

/**
 * `.knowledge/wiki.yml` — how a repository steers its own wiki (docs/features/46).
 *
 * The file is repository bytes: anyone who can push can write it. So it is read
 * the way every other untrusted input here is — capped before it is parsed,
 * parsed under the JSON schema (no `!!js/*` tags, no custom constructors), and
 * validated field by field. A file that fails any of that is *reported*, never
 * fatal: the run carries a warning naming the path that failed and the code
 * defaults apply, because a typo in a steering file must not stop the pages a
 * repository already had.
 */

/** Before parsing. An alias bomb or a pasted log is refused by size, not by a parser running out of memory. */
export const WIKI_CONFIG_MAX_BYTES = 64 * 1024;

const globList = z
  .array(z.string().trim().min(1).max(WIKI_MAX_GLOB_LENGTH))
  .max(WIKI_MAX_GLOBS);

const steeringSchema = z.object({
  version: z.literal(1).optional(),
  effort: z.enum(WIKI_EFFORT_LEVELS).optional(),
  include: globList.optional(),
  exclude: globList.optional(),
  sections: z.array(z.enum(WIKI_SECTIONS)).max(WIKI_SECTIONS.length).optional(),
  modules: z
    .object({
      max: z.number().int().min(1).max(200).optional(),
      titles: z.record(z.string().max(300), z.string().trim().min(1).max(120)).optional(),
    })
    .optional(),
  diagrams: z
    .object({
      architecture: z.boolean().optional(),
      class: z.boolean().optional(),
      sequence: z.boolean().optional(),
      maxNodes: z.number().int().min(4).max(200).optional(),
    })
    .optional(),
  flows: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        entry: z.string().trim().min(1).max(300),
        symbol: z.string().trim().min(1).max(120).optional(),
      }),
    )
    .max(WIKI_MAX_FLOWS)
    .optional(),
  focus: z.string().max(2_000).optional(),
  changelog: z
    .object({
      tagPattern: z.string().trim().min(1).max(100).optional(),
      breaking: z
        .object({
          conventional: z.boolean().optional(),
          labels: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
          apiSurface: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});

export interface WikiSteering {
  /** The parsed file, or null when it is absent or invalid — defaults apply either way. */
  config: WikiSteeringConfig | null;
  source: 'repo-file' | 'default';
  /** Why the file was rejected, one line per failure (`flows.0.entry: …`). Empty when it was fine. */
  errors: string[];
  /**
   * Mixed into every wiki unit's version, so editing the file re-derives the
   * pages it can affect. Hashes the bytes, not the parse: a file that went from
   * invalid to valid must move the hash even when both fall back to defaults.
   */
  hash: string;
}

const DEFAULT_STEERING: WikiSteering = { config: null, source: 'default', errors: [], hash: 'default' };

/** Reads the steering file out of a downloaded archive. Never throws. */
export function readWikiSteering(files: Map<string, Uint8Array>): WikiSteering {
  const bytes = files.get(WIKI_CONFIG_PATH);
  if (!bytes) return DEFAULT_STEERING;
  return steeringFromBytes(bytes);
}

/** The same reading, from text fetched on its own (the Wiki tab). Null text = no file. */
export function steeringFromText(text: string | null): WikiSteering {
  return text === null ? DEFAULT_STEERING : steeringFromBytes(Buffer.from(text, 'utf8'));
}

function steeringFromBytes(bytes: Uint8Array): WikiSteering {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  if (bytes.length > WIKI_CONFIG_MAX_BYTES) {
    return { config: null, source: 'default', errors: [`file is larger than ${WIKI_CONFIG_MAX_BYTES} bytes`], hash };
  }

  const parsed = parseWikiSteering(Buffer.from(bytes).toString('utf8'));
  return parsed.config
    ? { config: parsed.config, source: 'repo-file', errors: [], hash }
    : { config: null, source: 'default', errors: parsed.errors, hash };
}

export function parseWikiSteering(text: string): { config: WikiSteeringConfig | null; errors: string[] } {
  // An empty file is a file that says nothing, not an invalid one.
  if (text.trim() === '') return { config: {}, errors: [] };

  let raw: unknown;
  try {
    // JSON_SCHEMA: plain scalars, sequences and maps. `yes` stays a string and
    // a date stays a string, which is what every field here expects anyway.
    raw = load(text, { schema: JSON_SCHEMA, maxAliases: 50 });
  } catch (err) {
    return { config: null, errors: [`not valid YAML: ${(err as Error).message.split('\n')[0]}`] };
  }
  if (raw === null || raw === undefined) return { config: {}, errors: [] };

  const result = steeringSchema.safeParse(raw);
  if (!result.success) {
    return {
      config: null,
      errors: result.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  return { config: result.data as WikiSteeringConfig, errors: [] };
}

/**
 * The path filter `include` / `exclude` describe, or null when neither is set.
 *
 * Compiled with the glob translator the code tools already use (docs/features/31),
 * so a pattern means the same thing to `code_search` as it does here. An empty
 * `include` means "everything" — the filter only ever narrows.
 */
export function wikiPathFilter(include: string[], exclude: string[]): ((path: string) => boolean) | null {
  if (include.length === 0 && exclude.length === 0) return null;
  const inc = include.map(globToRegExp);
  const exc = exclude.map(globToRegExp);
  return (path) => (inc.length === 0 || inc.some((re) => re.test(path))) && !exc.some((re) => re.test(path));
}
