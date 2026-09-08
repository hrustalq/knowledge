import { Injectable } from '@nestjs/common';
import mammoth from 'mammoth';
import type { ImportParserId } from '@knowledge/contracts';
import { htmlToMarkdown } from './html-to-markdown.js';
import {
  asBullet,
  countSections,
  countWords,
  inferTitle,
  type DocumentParser,
  type ParseContext,
  type ParsedImage,
  type ParseResult,
} from './parser.types.js';

/**
 * DOCX → markdown, via mammoth's semantic HTML.
 *
 * mammoth is used rather than a raw XML walk because it maps Word's *styles*
 * ("Heading 2", "List Paragraph") onto semantic HTML instead of onto the
 * formatting they happen to produce — which is why a heading imported this way
 * is an `##` and not a bold paragraph.
 *
 * Images are lifted out rather than inlined as data URIs: a base64 blob in the
 * markdown would bloat every revision, break the structural diff and defeat
 * deduplication. They are written to import staging, shown in the review step
 * from there, and promoted to real page attachments on submit.
 */
@Injectable()
export class DocxParser implements DocumentParser {
  readonly id: ImportParserId = 'docx';

  async parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParseResult> {
    await ctx.onStage('Reading the document', 0.2);

    const images: ParsedImage[] = [];
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes) },
      {
        // Word's own heading styles carry the outline; without this map a
        // "Title" paragraph would arrive as ordinary prose.
        styleMap: [
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Subtitle'] => h2:fresh",
          "p[style-name='Quote'] => blockquote:fresh",
          "p[style-name='Intense Quote'] => blockquote:fresh",
        ],
        convertImage: mammoth.images.imgElement(async (image) => {
          const index = images.length;
          const buffer = await image.readAsBuffer();
          const ext = extensionFor(image.contentType);
          images.push({
            index,
            filename: `image-${index + 1}${ext}`,
            contentType: image.contentType,
            bytes: new Uint8Array(buffer),
          });
          // A staging path the review step can actually render; submit rewrites
          // it to the attachment that replaces it.
          return { src: imagePath(ctx.importId, index) };
        }),
      },
    );

    await ctx.onStage('Converting to markdown', 0.7);
    const markdown = normalizeGlyphBullets(htmlToMarkdown(result.value));

    // mammoth reports what it could not represent (unsupported styles, dropped
    // fields). Those are exactly the losses a reviewer needs to know about, so
    // they are passed through rather than logged and forgotten.
    const warnings = dedupe(
      result.messages
        .filter((m) => m.type === 'warning' || m.type === 'error')
        .map((m) => m.message),
    ).slice(0, 8);
    if (images.length > 0) {
      warnings.unshift(
        `${images.length} ${images.length === 1 ? 'image was' : 'images were'} imported and will be attached to the page.`,
      );
    }

    return {
      markdown,
      title: inferTitle(markdown, ctx.filename),
      warnings,
      meta: {
        sections: countSections(markdown),
        words: countWords(markdown),
        images: images.length,
      },
      images,
    };
  }
}

/** The route the markdown points at while the import is still staged. */
export function imagePath(importId: string, index: number): string {
  return `/v1/imports/${importId}/images/${index}`;
}

export function extensionFor(contentType: string): string {
  const known: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/x-emf': '.emf',
    'image/x-wmf': '.wmf',
  };
  return known[contentType] ?? '.bin';
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Word documents round-tripped through another tool routinely lose their list
 * numbering and keep only the glyph, so "• item" arrives as an ordinary
 * paragraph and markdown renders it as prose with a stray dot. Turning those
 * back into a list costs one pass and is unambiguous — nobody opens a sentence
 * with a bullet character.
 */
function normalizeGlyphBullets(markdown: string): string {
  const out: string[] = [];
  for (const line of markdown.split('\n')) {
    const bullet = asBullet(line);
    // A blank line between two items splits one list into several.
    if (bullet && out.at(-1) === '' && out.at(-2)?.startsWith('- ')) out.pop();
    out.push(bullet ?? line);
  }
  return out.join('\n');
}
