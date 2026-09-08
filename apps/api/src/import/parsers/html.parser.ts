import { Injectable } from '@nestjs/common';
import type { ImportParserId } from '@knowledge/contracts';
import { htmlTitle, htmlToMarkdown } from './html-to-markdown.js';
import {
  countSections,
  countWords,
  inferTitle,
  type DocumentParser,
  type ParseContext,
  type ParseResult,
} from './parser.types.js';

/**
 * HTML → markdown. Saved articles, exported wikis, anything a browser produced.
 *
 * Remote images are left as absolute URLs rather than fetched: pulling every
 * `<img>` an arbitrary HTML file references would turn an import into a
 * crawler, and the reviewer can see exactly which ones survived.
 */
@Injectable()
export class HtmlParser implements DocumentParser {
  readonly id: ImportParserId = 'html';

  async parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParseResult> {
    await ctx.onStage('Converting to markdown', 0.4);
    const html = new TextDecoder().decode(bytes);
    const markdown = htmlToMarkdown(html);

    const warnings: string[] = [];
    const remote = [...markdown.matchAll(/!\[[^\]]*\]\((https?:[^)\s]+)/g)].length;
    if (remote > 0) {
      warnings.push(
        `${remote} ${remote === 1 ? 'image is' : 'images are'} linked from their original address rather than attached — they will break if that site goes away.`,
      );
    }
    if (/<style|<script/i.test(html)) {
      warnings.push('Scripts, styles and page furniture (nav, header, footer) were dropped.');
    }

    return {
      markdown,
      title: htmlTitle(html) ?? inferTitle(markdown, ctx.filename),
      warnings,
      meta: { sections: countSections(markdown), words: countWords(markdown), images: remote },
    };
  }
}
