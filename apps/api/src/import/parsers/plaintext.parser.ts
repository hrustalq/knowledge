import { Injectable } from '@nestjs/common';
import matter from 'gray-matter';
import type { ImportParserId } from '@knowledge/contracts';
import {
  countSections,
  countWords,
  inferTitle,
  tidy,
  type DocumentParser,
  type ParseContext,
  type ParseResult,
} from './parser.types.js';
import { t } from '../../i18n/t.js';

/**
 * Markdown and plain text.
 *
 * Markdown is passed through untouched — it is already the storage format, and
 * "improving" it on the way in would mean the file you imported is not the file
 * that arrived. Its frontmatter is read only to find a title, and is left in
 * place so the ingestion worker still derives relations from it exactly as it
 * would for a page written by hand.
 *
 * Plain text gets the one transformation it needs: hard-wrapped lines rejoined
 * into paragraphs, because 78-column text pasted into a proportional renderer
 * is unreadable and chunks badly.
 */
@Injectable()
export class PlaintextParser implements DocumentParser {
  readonly id: ImportParserId = 'plaintext';

  async parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParseResult> {
    await ctx.onStage(t('import.stage.reading-file'), 0.5);
    const text = new TextDecoder().decode(bytes).replace(/^﻿/, '');
    const isMarkdown = /\.(md|markdown)$/i.test(ctx.filename) || /markdown/i.test(ctx.contentType);
    const warnings: string[] = [];

    if (isMarkdown) {
      const parsed = matter(text);
      const frontTitle = typeof parsed.data?.title === 'string' ? parsed.data.title.trim() : '';
      if (Object.keys(parsed.data ?? {}).length > 0) {
        warnings.push(t('import.warning.frontmatterKept'));
      }
      return {
        markdown: text.trim(),
        title: frontTitle || inferTitle(parsed.content, ctx.filename),
        warnings,
        meta: { sections: countSections(parsed.content), words: countWords(parsed.content) },
      };
    }

    const markdown = rejoinHardWraps(text);
    if (markdown !== tidy(text)) {
      warnings.push(t('import.warning.rejoinedLines'));
    }
    return {
      markdown,
      title: inferTitle(markdown, ctx.filename),
      warnings,
      meta: { sections: countSections(markdown), words: countWords(markdown) },
    };
  }
}

/**
 * Blank lines separate paragraphs; single newlines inside one are wrapping.
 * Lines that already look like structure — bullets, numbering, indented code —
 * are left exactly as they are.
 */
function rejoinHardWraps(text: string): string {
  return tidy(
    text
      .replace(/\r\n?/g, '\n')
      .split(/\n{2,}/)
      .map((block) => {
        const lines = block.split('\n');
        const structured = lines.some((l) => /^\s{2,}\S/.test(l) || /^\s*([-*+•]|\d+[.)])\s/.test(l));
        return structured ? block : lines.map((l) => l.trim()).filter(Boolean).join(' ');
      })
      .join('\n\n'),
  );
}
