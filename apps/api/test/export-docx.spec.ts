import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { I18nJsonLoader, I18nModule } from 'nestjs-i18n';
import { strFromU8, unzipSync } from 'fflate';
import { decodeEntities, htmlPieces, imageInfo, writeDocx, type DocxExportInput, type DocxPage } from '../src/export/export-docx.js';

/**
 * The Word export's token → docx mapping (docs/features/45, #162), one case
 * per block the rich editor writes (docs/features/03), asserted on the
 * produced file's word/document.xml. The markdown below is spelled the way
 * the editor's serializer stores it, so these are the shapes real pages have.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OUT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const IMG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PDF = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const WEBP = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const GONE = '12121212-1212-4121-8121-121212121212';
const att = (id: string) => `/v1/documents/${A}/attachments/${id}/content`;

/** A PNG header that says `width × height`: all the writer reads. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return bytes;
}

const LABELS: DocxExportInput['labels'] = {
  contents: 'Contents',
  meta: 'Exported 20 October 2026 · 2 pages',
  onThisPage: 'On this page',
  noHeadings: 'No headings',
  diagramSource: 'Diagram (mermaid source)',
  drawing: 'A drawing — open the page to see it',
  attachment: 'Attachment: {name}',
  panel: { note: 'Info', tip: 'Success', important: 'Note', warning: 'Warning', caution: 'Error' },
};

async function files(pages: DocxPage[]): Promise<Record<string, Uint8Array>> {
  const bytes = await writeDocx({
    title: 'Guide',
    pages,
    images: new Map([
      [IMG, { bytes: png(1200, 600), filename: 'shot.png' }],
      [WEBP, { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), filename: 'photo.webp' }],
    ]),
    labels: LABELS,
  });
  return unzipSync(bytes);
}

/** document.xml of a one-page export of `markdown`. */
async function xmlOf(markdown: string, pages: DocxPage[] = []): Promise<string> {
  const zip = await files([{ documentId: A, title: 'Руководство', depth: 0, markdown }, ...pages]);
  return strFromU8(zip['word/document.xml']);
}

/** The `<w:p>` holding `text`. */
function paragraph(xml: string, text: string): string {
  const found = xml.split(/(?=<w:p>|<w:p )/).find((p) => p.includes(text));
  if (!found) throw new Error(`no paragraph with ${text}`);
  return found.slice(0, found.indexOf('</w:p>') + 6);
}

describe('writeDocx — document shape', () => {
  it('writes one page as itself: its title Heading 1, no title page, one section', async () => {
    const xml = await xmlOf('Body');
    expect(paragraph(xml, 'Руководство')).toContain('<w:pStyle w:val="Heading1"/>');
    expect(paragraph(xml, 'Руководство')).toContain('w:name="kn_p0"');
    expect(xml).not.toContain('w:val="Title"');
    expect(xml.match(/<w:sectPr/g)).toHaveLength(1);
  });

  it('gives several pages a title page and contents linked to each page, and a section (a new sheet) per page', async () => {
    const zip = await files([
      { documentId: A, title: 'Guide', depth: 0, markdown: 'One' },
      { documentId: B, title: 'Установка', depth: 1, markdown: 'Two' },
    ]);
    const xml = strFromU8(zip['word/document.xml']);
    expect(paragraph(xml, '>Guide<')).toContain('w:val="Title"');
    expect(xml).toContain('Exported 20 October 2026 · 2 pages');
    expect(paragraph(xml, '>Contents<')).toBeTruthy();
    expect(xml).toMatch(/<w:hyperlink[^>]*w:anchor="kn_p1"[^>]*>.*?Установка/);
    expect(xml.match(/<w:sectPr/g)).toHaveLength(3);
    // Page numbers in the footer of every sheet.
    expect(strFromU8(zip['word/footer1.xml'])).toContain('PAGE');
    expect(xml.indexOf('One')).toBeLessThan(xml.indexOf('Two'));
  });

  it('keeps Cyrillic as written, in the body and in the core properties', async () => {
    const zip = await files([{ documentId: A, title: 'Руководство по установке', depth: 0, markdown: 'Привет, мир — ёлка' }]);
    expect(strFromU8(zip['word/document.xml'])).toContain('Привет, мир — ёлка');
    expect(strFromU8(zip['word/document.xml'])).toContain('Руководство по установке');
  });
});

describe('writeDocx — blocks', () => {
  it('maps headings to Word heading styles one level under the page title, with outline levels for the navigation pane', async () => {
    const zip = await files([{ documentId: A, title: 'T', depth: 0, markdown: '# One\n\n## Two\n\n### Three\n\n#### Four' }]);
    const xml = strFromU8(zip['word/document.xml']);
    expect(paragraph(xml, '>One<')).toContain('w:val="Heading2"');
    expect(paragraph(xml, '>Two<')).toContain('w:val="Heading3"');
    expect(paragraph(xml, '>Three<')).toContain('w:val="Heading4"');
    expect(paragraph(xml, '>Four<')).toContain('w:val="Heading5"');
    const styles = strFromU8(zip['word/styles.xml']);
    expect(styles).toMatch(/w:styleId="Heading2".*?<w:outlineLvl w:val="1"\/>/s);
  });

  it('writes paragraphs with their inline marks', async () => {
    const xml = await xmlOf(
      'line\nwrapped **bold** *em* ~~gone~~ `code` <u>under</u> <mark>marked</mark> x<sup>2</sup> H<sub>2</sub>O Tom &amp; Jerry',
    );
    const p = paragraph(xml, 'bold');
    expect(p).toContain('line wrapped');
    expect(p).toMatch(/<w:b\/>.*?bold/);
    expect(p).toMatch(/<w:i\/>.*?em/);
    expect(p).toMatch(/<w:strike\/>.*?gone/);
    expect(p).toMatch(/w:ascii="Courier New".*?code/);
    expect(p).toMatch(/<w:u w:val="single"\/>.*?under/);
    expect(p).toMatch(/<w:highlight w:val="yellow"\/>.*?marked/);
    expect(p).toMatch(/superscript.*?>2</);
    expect(p).toMatch(/subscript.*?>2</);
    // An entity is the character it names, escaped once by the XML writer.
    expect(p).toContain('Tom &amp; Jerry');
    expect(p).not.toContain('&amp;amp;');
  });

  it('writes bullet, ordered (restarting at its own start), nested and task lists', async () => {
    const zip = await files([
      { documentId: A, title: 'T', depth: 0, markdown: '- one\n- two\n  - nested\n\n3. three\n4. four\n\nBetween\n\n1. again\n\n- [x] done\n- [ ] todo' },
    ]);
    const xml = strFromU8(zip['word/document.xml']);
    expect(paragraph(xml, '>one<')).toMatch(/<w:numPr><w:ilvl w:val="0"\/>/);
    expect(paragraph(xml, '>nested<')).toMatch(/<w:numPr><w:ilvl w:val="1"\/>/);
    const numId = (text: string) => /<w:numId w:val="(\d+)"\/>/.exec(paragraph(xml, text))?.[1];
    expect(numId('>three<')).toBe(numId('>four<'));
    expect(numId('>again<')).not.toBe(numId('>three<'));
    expect(strFromU8(zip['word/numbering.xml'])).toContain('<w:start w:val="3"/>');
    expect(paragraph(xml, '>done<')).toContain('☑ ');
    expect(paragraph(xml, '>todo<')).toContain('☐ ');
    expect(paragraph(xml, '>todo<')).not.toContain('<w:numPr>');
  });

  it('writes a table with a repeating header row and column alignment', async () => {
    const xml = await xmlOf('| Name | Size |\n| :- | -: |\n| Ключ | 42 |');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toMatch(/<w:tblHeader\/>.*?Name/s);
    expect(paragraph(xml, '>Size<')).toContain('<w:b/>');
    expect(paragraph(xml, '>42<')).toContain('<w:jc w:val="right"/>');
    expect(xml).toContain('Ключ');
  });

  it('writes a code block monospace, one line break per line, indentation kept', async () => {
    const zip = await files([{ documentId: A, title: 'T', depth: 0, markdown: '```ts\n  const x = 1\nreturn x\n```' }]);
    const xml = strFromU8(zip['word/document.xml']);
    const p = paragraph(xml, 'const x');
    expect(p).toContain('<w:pStyle w:val="KnCode"/>');
    expect(p).toContain('<w:t xml:space="preserve">  const x = 1</w:t>');
    expect(p).toMatch(/<w:br\/><w:t xml:space="preserve">return x/);
    expect(strFromU8(zip['word/styles.xml'])).toMatch(/w:styleId="KnCode".*?Courier New/s);
  });

  it('keeps a mermaid diagram as its source under a label, and names a drawing instead of printing its scene', async () => {
    const xml = await xmlOf('```mermaid\ngraph TD; a-->b\n```\n\n```drawing\n{"elements":[{"id":"x"}]}\n```');
    expect(xml).toContain('Diagram (mermaid source)');
    expect(paragraph(xml, 'graph TD')).toContain('KnCode');
    expect(xml).toContain('graph TD; a--&gt;b');
    expect(xml).toContain('A drawing — open the page to see it');
    expect(xml).not.toContain('elements');
  });

  it.each([
    ['NOTE', 'Info', '2563EB'],
    ['TIP', 'Success', '16A34A'],
    ['IMPORTANT', 'Note', '7C3AED'],
    ['WARNING', 'Warning', 'D97706'],
    ['CAUTION', 'Error', 'DC2626'],
  ])('writes a %s callout as a labelled, ruled and shaded block without its marker', async (kind, label, color) => {
    const xml = await xmlOf(`> [!${kind}]\n> Careful **here**\n>\n> - point`);
    expect(paragraph(xml, `>${label}<`)).toContain(`w:color="${color}"`);
    expect(paragraph(xml, 'Careful')).toContain(`<w:left w:val="single" w:color="${color}"`);
    expect(paragraph(xml, '>point<')).toContain(`w:color="${color}"`);
    expect(xml).not.toContain(`[!${kind}]`);
  });

  it('writes a plain quote as a ruled, indented block', async () => {
    const xml = await xmlOf('> quoted words');
    expect(paragraph(xml, 'quoted words')).toMatch(/<w:left w:val="single" w:color="D1D5DB"/);
  });

  it('writes an expand as its summary line over a framed body, and nothing after it framed', async () => {
    const xml = await xmlOf('<details>\n<summary>More info</summary>\n\nHidden body\n\n</details>\n\nAfter');
    expect(paragraph(xml, 'More info')).toContain('▸ More info');
    expect(paragraph(xml, 'More info')).toContain('<w:b/>');
    expect(paragraph(xml, 'Hidden body')).toContain('w:fill="F9FAFB"');
    expect(paragraph(xml, '>After<')).not.toContain('w:pBdr');
    expect(xml).not.toContain('details');
  });

  it('flows a layout’s columns one after another', async () => {
    const xml = await xmlOf(
      '<div data-kn-layout="2">\n<div data-kn-col>\n\nLeft col\n\n</div>\n<div data-kn-col>\n\nRight col\n\n</div>\n</div>',
    );
    expect(xml.indexOf('Left col')).toBeLessThan(xml.indexOf('Right col'));
    expect(xml).not.toContain('data-kn');
  });

  it('writes an API contract block as its heading and sections', async () => {
    const xml = await xmlOf(
      '<div data-kn-api="GET" data-kn-path="/v1/items">\n\n### GET /v1/items\n\n<div data-kn-api-section="params">\n\n#### Parameters\n\n| Name | In |\n| --- | --- |\n| id | path |\n\n</div>\n\n</div>',
    );
    expect(paragraph(xml, 'GET /v1/items')).toContain('Heading4');
    expect(paragraph(xml, 'Parameters')).toContain('Heading5');
    expect(xml).toContain('<w:tbl>');
    expect(xml).not.toContain('data-kn');
  });

  it('turns the contents macro into this page’s headings, linked to their bookmarks', async () => {
    // An h4 is not in the contents and takes no bookmark, as in the reader.
    const xml = await xmlOf('<div data-kn-toc="1"></div>\n\n# Установка\n\n#### Deep\n\n## Проверка');
    expect(xml).not.toMatch(/w:anchor="[^"]*"[^>]*>(?:(?!<\/w:hyperlink>).)*Deep/);
    expect(xml).toContain('On this page');
    expect(xml).toMatch(/<w:hyperlink[^>]*w:anchor="kn_p0_h0"[^>]*>.*?Установка/);
    expect(xml).toMatch(/<w:hyperlink[^>]*w:anchor="kn_p0_h1"[^>]*>.*?Проверка/);
    expect(paragraph(xml, 'w:name="kn_p0_h1"')).toMatch(/Heading3.*Проверка/);
  });

  it('names a file embed, and shows one that is an image the export carries', async () => {
    const xml = await xmlOf(
      `<div data-kn-file="${PDF}" data-kn-name="spec.pdf" data-kn-mime="application/pdf"><a href="${att(PDF)}">spec.pdf</a></div>\n\n` +
        `<div data-kn-file="${IMG}" data-kn-name="shot.png" data-kn-mime="image/png"><a href="${att(IMG)}">shot.png</a></div>`,
    );
    expect(paragraph(xml, 'spec.pdf')).toContain('Attachment: spec.pdf');
    expect(xml).toContain('<w:drawing>');
  });

  it('draws an embedded design as its snapshot and caption, and an item with no snapshot as its caption (#470)', async () => {
    const xml = await xmlOf(`<figure data-kn-embed="grid"><a data-kn-item="${IMG}">Sign-in</a><a>Elsewhere</a><figcaption>Flow</figcaption></figure>`);
    expect(xml).toContain('<w:drawing>');
    expect(xml).toContain('Sign-in');
    expect(xml).toContain('Elsewhere');
    expect(xml).toContain('Flow');
    expect(xml).not.toContain('figma.com');
  });

  it('draws a horizontal rule as a bottom border', async () => {
    const xml = await xmlOf('Above\n\n---\n\nBelow');
    expect(xml).toMatch(/<w:bottom w:val="single" w:color="D1D5DB"/);
  });
});

describe('writeDocx — images', () => {
  it('embeds an attachment the export carries, scaled to the page width', async () => {
    const zip = await files([{ documentId: A, title: 'T', depth: 0, markdown: `![shot](${att(IMG)})` }]);
    const xml = strFromU8(zip['word/document.xml']);
    expect(Object.keys(zip).some((k) => k.startsWith('word/media/'))).toBe(true);
    // 1200×600 px → 600×300 px = 5715000×2857500 EMU.
    expect(xml).toContain('<wp:extent cx="5715000" cy="2857500"/>');
    expect(paragraph(xml, '<w:drawing>')).toContain('<w:jc w:val="center"/>');
  });

  it('keeps the width a person resized an image to', async () => {
    const xml = await xmlOf(`<img src="${att(IMG)}" alt="shot" width="300" />`);
    expect(xml).toContain('<wp:extent cx="2857500" cy="1428750"/>');
  });

  it('keeps a web image as a link to its address', async () => {
    const zip = await files([{ documentId: A, title: 'T', depth: 0, markdown: '![remote](https://example.com/x.png)' }]);
    expect(strFromU8(zip['word/document.xml'])).toMatch(/<w:hyperlink[^>]*r:id=[^>]*>.*?remote/);
    expect(strFromU8(zip['word/_rels/document.xml.rels'])).toContain('Target="https://example.com/x.png" TargetMode="External"');
    expect(Object.keys(zip).some((k) => k.startsWith('word/media/'))).toBe(false);
  });

  it('names an attachment Word cannot embed, and leaves out one the export does not carry', async () => {
    const xml = await xmlOf(`![photo](${att(WEBP)})\n\n![missing](${att(GONE)})`);
    expect(xml).toContain('[photo]');
    expect(xml).not.toContain('missing');
    expect(xml).not.toContain('<w:drawing>');
  });
});

describe('writeDocx — links', () => {
  it('links the web, a page in the export and a heading on the page; a page outside the export keeps its text', async () => {
    const zip = await files([
      {
        documentId: A,
        title: 'T',
        depth: 0,
        markdown: `# Установка\n\n[web](https://example.com) [inside](/documents/${B}) [outside](/documents/${OUT}) [up](#установка) [app](/settings)`,
      },
      { documentId: B, title: 'Other', depth: 0, markdown: 'B' },
    ]);
    const xml = strFromU8(zip['word/document.xml']);
    expect(xml).toMatch(/<w:hyperlink w:history="1" r:id="[^"]+"><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr><w:t[^>]*>web/);
    expect(strFromU8(zip['word/_rels/document.xml.rels'])).toContain('Target="https://example.com" TargetMode="External"');
    expect(xml).toMatch(/w:anchor="kn_p1"[^>]*>.*?inside/);
    expect(xml).toMatch(/w:anchor="kn_p0_h0"[^>]*>.*?>up</);
    const p = paragraph(xml, 'outside');
    expect(p).not.toMatch(/<w:hyperlink[^>]*>(?:(?!<\/w:hyperlink>).)*outside/);
    expect(p).not.toMatch(/<w:hyperlink[^>]*>(?:(?!<\/w:hyperlink>).)*>app</);
  });

  it('colours status lozenges and mentions without losing their text', async () => {
    const xml = await xmlOf(
      'State <span data-kn-status="green">Done</span> by <span data-kn-user="u1">@Ada</span> and <span data-kn-agent="reviewer">@reviewer</span>',
    );
    const p = paragraph(xml, 'Done');
    expect(p).toMatch(/<w:color w:val="166534"\/><w:shd w:fill="DCFCE7"[^>]*\/><\/w:rPr><w:t[^>]*>Done/);
    expect(p).toMatch(/<w:color w:val="2563EB"\/><\/w:rPr><w:t[^>]*>@Ada/);
    expect(p).toContain('@reviewer');
    expect(p).not.toContain('data-kn');
  });
});

describe('helpers', () => {
  it('reads image sizes from PNG, GIF and JPEG headers, and refuses anything else', () => {
    expect(imageInfo(png(10, 20))).toEqual({ type: 'png', width: 10, height: 20 });
    expect(imageInfo(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 3, 0, 4, 0]))).toEqual({ type: 'gif', width: 3, height: 4 });
    // SOI, an APP0 segment of 4 bytes, then SOF0: height 0x0102, width 0x0304.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 1, 2, 3, 4, 3, 0, 0]);
    expect(imageInfo(jpeg)).toEqual({ type: 'jpg', width: 0x0304, height: 0x0102 });
    expect(imageInfo(new TextEncoder().encode('<svg/>'))).toBeNull();
  });

  it('decodes entities and reads the serializer’s tags', () => {
    expect(decodeEntities('a &amp; b &#x41; &#66; &laquo;x&raquo; &bogus;')).toBe('a & b A B «x» &bogus;');
    expect(htmlPieces('<div data-kn-file="x" data-kn-name="a &amp; b"><a href="/y">n</a></div>')).toEqual([
      { tag: 'div', closing: false, attrs: { 'data-kn-file': 'x', 'data-kn-name': 'a & b' } },
      { tag: 'a', closing: false, attrs: { href: '/y' } },
      { attrs: {}, text: 'n' },
      { tag: 'a', closing: true, attrs: {} },
      { tag: 'div', closing: true, attrs: {} },
    ]);
  });
});

describe('the labels, through the real catalogs', async () => {
  const { t, I18nRegistry } = await import('../src/i18n/t.js');
  const moduleRef = await Test.createTestingModule({
    imports: [
      I18nModule.forRoot({
        fallbackLanguage: 'en',
        loader: I18nJsonLoader,
        loaderOptions: { path: join(import.meta.dirname, '../src/i18n'), watch: false },
      }),
    ],
    providers: [I18nRegistry],
  }).compile();
  await moduleRef.init();

  it('declines the page count and keeps the attachment placeholder for the writer', () => {
    expect(t('export.docx.pageCount', { count: 1 }, 'en')).toBe('1 page');
    expect(t('export.docx.pageCount', { count: 5 }, 'ru')).toBe('5 страниц');
    expect(t('export.docx.pageCount', { count: 3 }, 'ru')).toBe('3 страницы');
    expect(t('export.docx.attachment', { name: '{name}' }, 'ru')).toBe('Вложение: {name}');
    expect(t('export.docx.panel.warning', undefined, 'ru')).toBe('Предупреждение');
  });
});
