import { Injectable } from '@nestjs/common';
import { unzipSync } from 'fflate';
import type { ImportParserId } from '@knowledge/contracts';
import { extensionFor, imagePath } from './docx.parser.js';
import {
  countWords,
  tidy,
  type DocumentParser,
  type ParseContext,
  type ParsedImage,
  type ParseResult,
} from './parser.types.js';

/**
 * PPTX → markdown.
 *
 * A .pptx is a zip of XML, and the parts that matter are few enough that
 * unzipping and reading them directly beats pulling in an Office suite: slide
 * text lives in `<a:t>` runs, its outline level in `<a:pPr lvl>`, its pictures
 * in the slide's relationship file. So this reads exactly those.
 *
 * The shape it produces is the shape a deck actually has: one `##` section per
 * slide, its bullets nested by their real outline level, its diagrams attached,
 * and its speaker notes kept as quotes — in a knowledge base the notes are
 * frequently the only prose in the file.
 */
@Injectable()
export class PptxParser implements DocumentParser {
  readonly id: ImportParserId = 'pptx';

  async parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParseResult> {
    await ctx.onStage('Unpacking the deck', 0.15);
    const zip = unzipSync(bytes);

    const slideNames = Object.keys(zip)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => slideNumber(a) - slideNumber(b));

    if (slideNames.length === 0) {
      return {
        markdown: '',
        warnings: ['No slides were found in this file.'],
        meta: { slides: 0, words: 0 },
      };
    }

    const decoder = new TextDecoder();
    const images: ParsedImage[] = [];
    const out: string[] = [];
    let notesImported = 0;

    await ctx.onStage(`Reading ${slideNames.length} slides`, 0.3);

    for (let i = 0; i < slideNames.length; i++) {
      const name = slideNames[i];
      const n = slideNumber(name);
      const xml = decoder.decode(zip[name]);

      const { title, body } = readSlide(xml);
      out.push(`## ${title || `Slide ${n}`}`);
      if (body.length) out.push(body.join('\n'));

      // Pictures are resolved through the slide's own rels file, so a diagram
      // lands under the slide it belongs to rather than in a heap at the end.
      const rels = zip[`ppt/slides/_rels/slide${n}.xml.rels`];
      if (rels) {
        for (const target of embeddedImages(xml, decoder.decode(rels))) {
          const media = zip[target];
          if (!media) continue;
          const contentType = contentTypeFor(target);
          const index = images.length;
          images.push({
            index,
            filename: `slide-${n}-image-${index + 1}${extensionFor(contentType)}`,
            contentType,
            bytes: media,
          });
          out.push(`![Slide ${n}](${imagePath(ctx.importId, index)})`);
        }
      }

      const notes = zip[`ppt/notesSlides/notesSlide${n}.xml`];
      if (notes) {
        const text = paragraphs(decoder.decode(notes))
          .map((p) => p.text)
          .filter((t) => t && !/^\d+$/.test(t));
        if (text.length) {
          notesImported++;
          out.push(text.map((t) => `> ${t}`).join('\n> \n'));
        }
      }

      if (i % 5 === 4) {
        await ctx.onStage(`Reading ${slideNames.length} slides`, 0.3 + 0.5 * ((i + 1) / slideNames.length));
      }
    }

    const markdown = tidy(out.join('\n\n'));
    const warnings: string[] = [];
    if (images.length > 0) {
      warnings.push(
        `${images.length} ${images.length === 1 ? 'image was' : 'images were'} imported and will be attached to the page.`,
      );
    }
    if (notesImported > 0) {
      warnings.push(
        `Speaker notes from ${notesImported} ${notesImported === 1 ? 'slide' : 'slides'} were imported as quotes.`,
      );
    }
    warnings.push('Slide layout, animation and theming are not carried over — only the content is.');

    return {
      markdown,
      title: deckTitle(zip, decoder) ?? firstHeading(markdown) ?? ctx.filename.replace(/\.[^.]+$/, ''),
      warnings,
      meta: {
        slides: slideNames.length,
        sections: slideNames.length,
        words: countWords(markdown),
        images: images.length,
      },
      images,
    };
  }
}

const slideNumber = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

interface SlidePara {
  text: string;
  level: number;
  isTitle: boolean;
}

/**
 * Shape-by-shape, because the title placeholder is identified by `<p:ph>` on
 * the shape, not by anything on the text inside it.
 */
function readSlide(xml: string): { title: string; body: string[] } {
  const shapes = xml.split('<p:sp>').slice(1);
  let title = '';
  const body: string[] = [];

  for (const shape of shapes) {
    const isTitle = /<p:ph[^>]*type="(?:ctrTitle|title)"/.test(shape);
    for (const para of paragraphs(shape)) {
      if (!para.text) continue;
      if (isTitle && !title) {
        title = para.text;
        continue;
      }
      // PowerPoint body text is a bulleted outline; its `lvl` is the nesting
      // the author actually chose, so it becomes real list indentation.
      body.push(`${'  '.repeat(Math.min(para.level, 3))}- ${para.text}`);
    }
  }
  return { title, body };
}

function paragraphs(xml: string): SlidePara[] {
  const out: SlidePara[] = [];
  for (const block of xml.split('<a:p>').slice(1)) {
    const runs = [...block.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    const text = runs.join('').replace(/\s+/g, ' ').trim();
    const level = Number(/<a:pPr[^>]*\blvl="(\d+)"/.exec(block)?.[1] ?? 0);
    out.push({ text, level, isTitle: false });
  }
  return out;
}

/** `r:embed="rId3"` in slide order → the media path that relationship points at. */
function embeddedImages(slideXml: string, relsXml: string): string[] {
  const rels = new Map<string, string>();
  for (const m of relsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    const target = m[2].startsWith('../') ? `ppt/${m[2].slice(3)}` : m[2];
    if (target.startsWith('ppt/media/')) rels.set(m[1], target);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of slideXml.matchAll(/r:embed="([^"]+)"/g)) {
    const target = rels.get(m[1]);
    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

function deckTitle(zip: Record<string, Uint8Array>, decoder: TextDecoder): string | undefined {
  const core = zip['docProps/core.xml'];
  if (!core) return undefined;
  const m = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(decoder.decode(core));
  const text = m ? decodeXml(m[1]).trim() : '';
  return text ? text.slice(0, 200) : undefined;
}

function firstHeading(markdown: string): string | undefined {
  return /^##\s+(.+)$/m.exec(markdown)?.[1]?.trim();
}

function contentTypeFor(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  const known: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    emf: 'image/x-emf',
    wmf: 'image/x-wmf',
  };
  return known[ext] ?? 'application/octet-stream';
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}
