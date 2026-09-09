import { Injectable } from '@nestjs/common';
import { dump as dumpYaml, load as parseYaml } from 'js-yaml';
import type { ImportParserId } from '@knowledge/contracts';
import {
  countSections,
  countWords,
  inferTitle,
  type DocumentParser,
  type ParseContext,
  type ParseResult,
} from './parser.types.js';
import { t } from '../../i18n/t.js';

/** Below this, a config file is more readable as prose sections than as one fence. */
const FLATTEN_LIMIT = 40_000;

/**
 * JSON / YAML → markdown.
 *
 * Two shapes, deliberately. A small object becomes real sections — one `##` per
 * top-level key — because that is the version the chunker can retrieve against
 * and a person can read. Anything large, or anything that is a bare array,
 * stays as one fenced block: reshaping a 5 MB export into headings produces a
 * document nobody wants and a graph nobody asked for.
 */
@Injectable()
export class StructuredParser implements DocumentParser {
  readonly id: ImportParserId = 'structured';

  async parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParseResult> {
    await ctx.onStage(t('import.stage.parsing'), 0.4);
    const text = new TextDecoder().decode(bytes);
    const isYaml = /\.ya?ml$/i.test(ctx.filename) || /yaml/i.test(ctx.contentType);
    const lang = isYaml ? 'yaml' : 'json';
    const title = ctx.filename.replace(/\.[^.]+$/, '');
    const warnings: string[] = [];

    let parsed: unknown;
    try {
      parsed = isYaml ? parseYaml(text) : JSON.parse(text);
    } catch (e) {
      // A file that will not parse is still worth importing — as its own text.
      warnings.push(t('import.warning.invalidStructured', { lang: lang.toUpperCase(), reason: (e as Error).message }));
      const markdown = `# ${title}\n\n\`\`\`${lang}\n${text}\n\`\`\``;
      return { markdown, title, warnings, meta: { sections: 1, words: countWords(text) } };
    }

    const flat =
      text.length <= FLATTEN_LIMIT && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);

    if (!flat) {
      if (text.length > FLATTEN_LIMIT) {
        warnings.push(t('import.warning.singleCodeBlock'));
      }
      const markdown = `# ${title}\n\n\`\`\`${lang}\n${text.trimEnd()}\n\`\`\``;
      return { markdown, title, warnings, meta: { sections: 1, words: countWords(text) } };
    }

    await ctx.onStage(t('import.stage.building-sections'), 0.7);
    const out: string[] = [`# ${title}`];
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out.push(`## ${key}`);
      out.push(renderValue(value, lang));
    }
    const markdown = out.join('\n\n');

    return {
      markdown,
      title: inferTitle(markdown, ctx.filename),
      warnings,
      meta: { sections: countSections(markdown), words: countWords(markdown) },
    };
  }
}

function renderValue(value: unknown, lang: string): string {
  if (value === null || value === undefined) return '_empty_';
  if (typeof value === 'string') return value.includes('\n') ? `\`\`\`\n${value}\n\`\`\`` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v !== 'object' || v === null)) {
    return value.map((v) => `- ${String(v)}`).join('\n');
  }
  const serialized = lang === 'yaml' ? dumpYaml(value, { lineWidth: 100 }) : JSON.stringify(value, null, 2);
  return `\`\`\`${lang}\n${serialized.trimEnd()}\n\`\`\``;
}
