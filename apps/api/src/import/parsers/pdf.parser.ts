import { Injectable } from '@nestjs/common';
import type { ImportParserId } from '@knowledge/contracts';
import {
  inferTitle,
  type DocumentParser,
  type ParseContext,
  type ParseResult,
} from './parser.types.js';
import { pdfToMarkdown } from './pdf-text.js';

/**
 * The registry's PDF entry.
 *
 * The reconstruction itself lives in `pdf-text.ts`, because `web_fetch` reads
 * PDFs too (docs/features/29) and a parser may only be reached through the
 * registry. What stays here is everything an *import* adds and a fetch has no
 * use for: the filename title fallback, and the `ImportMeta` shape the review
 * step renders.
 */
@Injectable()
export class PdfParser implements DocumentParser {
  readonly id: ImportParserId = 'pdf';

  async parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParseResult> {
    const out = await pdfToMarkdown(bytes, (stage, progress) =>
      ctx.onStage(stage, progress),
    );
    return {
      markdown: out.markdown,
      // The file's own declared title, else the first thing in the text that
      // reads like one, else the filename — which only an import has.
      title: out.title ?? inferTitle(out.markdown, ctx.filename),
      warnings: out.warnings,
      meta: {
        pages: out.pages,
        sections: out.sections,
        words: out.words,
        needsOcr: out.needsOcr,
      },
    };
  }
}
