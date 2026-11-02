import { createRequire } from 'node:module';
import { Injectable } from '@nestjs/common';
import { strFromU8, Unzip, UnzipInflate, unzipSync } from 'fflate';
import type { ImportParserId } from '@knowledge/contracts';
import { countWords, type DocumentParser, type ParseContext, type ParseResult } from './parser.types.js';
import { decodeXml } from './pptx.parser.js';
import { MAX_ROWS, markdownTable } from './tabular.parser.js';
import { t } from '../../i18n/t.js';

/**
 * exceljs's streaming sheet parser and its style table, reached directly.
 *
 * Its `WorkbookReader` is not used: a sheet that precedes `sharedStrings.xml`
 * in the zip (exceljs's own writer orders it so) is parked in a temp file, and
 * that path intermittently ends the zip read early and every string cell comes
 * back as `{ sharedString: n }` — 120 of 150 runs in a loop. Feeding
 * `WorksheetReader` the sheet's bytes ourselves has no such path.
 *
 * ponytail: deep imports of exceljs 4.4 internals (version pinned in
 * package.json); re-check both files before upgrading it.
 */
const require = createRequire(import.meta.url);
const WorksheetReader = require('exceljs/lib/stream/xlsx/worksheet-reader.js') as new (opts: {
  workbook: { sharedStrings: string[]; styles: StyleManager; properties: { model: { date1904: boolean } } };
  id: number;
  iterator: AsyncIterable<Uint8Array>;
  options: { worksheets: 'emit'; hyperlinks: 'emit' };
}) => { parse(): AsyncIterable<Array<{ eventType: string; value: unknown }>> };
const StyleManager = require('exceljs/lib/xlsx/xform/style/styles-xform.js') as new () => StyleManager;

interface StyleManager {
  init(): void;
  parseStream(chunks: Iterable<string>): Promise<unknown>;
}

interface StreamCell {
  value: unknown;
  numFmt?: string;
}

interface StreamRow {
  number: number;
  cellCount: number;
  getCell(col: number): StreamCell;
}

/**
 * XLSX → markdown: one `##` section per visible sheet, in tab order, each a
 * table built by the CSV parser's `markdownTable`, so a sheet and its CSV
 * export import alike.
 *
 * A sheet is inflated chunk by chunk as its rows are parsed, so a 50k-row
 * sheet costs the rows kept, not the sheet: past `MAX_ROWS` a row is counted
 * and dropped. The shared-strings table is the one part held whole — every
 * sheet indexes into it. Hyperlink targets, charts, images, pivots and comments
 * live in each sheet's relationship files, read alongside (`readPackage`).
 */
@Injectable()
export class XlsxParser implements DocumentParser {
  readonly id: ImportParserId = 'xlsx';

  async parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParseResult> {
    await ctx.onStage(t('import.stage.reading-workbook'), 0.1);
    const pkg = readPackage(bytes);
    const styles = new StyleManager();
    if (pkg.styles) await styles.parseStream([pkg.styles]);
    else styles.init();
    const workbook = { sharedStrings: pkg.sharedStrings, styles, properties: { model: { date1904: pkg.date1904 } } };

    const sections: { name: string; lines: string[] }[] = [];
    const warnings: string[] = [];
    const hidden: string[] = [];
    let formulasWithoutValue = 0;

    for (const sheet of pkg.sheets) {
      if (sheet.state === 'hidden' || sheet.state === 'veryHidden') {
        hidden.push(sheet.name);
        continue;
      }
      if (!sheet.path) continue;
      await ctx.onStage(t('import.stage.reading-sheet', { sheet: sheet.name }), null);

      const reader = new WorksheetReader({
        workbook,
        id: sheet.id,
        iterator: entryChunks(bytes, sheet.path),
        options: { worksheets: 'emit', hyperlinks: 'emit' },
      });
      const rows: string[][] = [];
      const rowNumbers: number[] = [];
      const links: { ref: string; rId: string }[] = [];
      let total = 0;
      for await (const events of reader.parse()) {
        for (const { eventType, value } of events) {
          if (eventType === 'hyperlink') {
            links.push(value as { ref: string; rId: string });
            continue;
          }
          if (eventType !== 'row') continue;
          const row = value as StreamRow;
          const cells: string[] = [];
          for (let c = 1; c <= row.cellCount; c++) {
            const shown = cellText(row.getCell(c), pkg.date1904);
            if (shown.formulaOnly) formulasWithoutValue++;
            cells.push(shown.text);
          }
          if (!cells.some((c) => c.trim())) continue;
          total++;
          // ponytail: rows past the cap are still parsed and counted, never kept;
          // stop the read early if a sheet's parse time (not memory) ever matters.
          if (rows.length <= MAX_ROWS) {
            rows.push(cells);
            rowNumbers.push(row.number);
          }
        }
      }
      if (rows.length === 0) continue;

      for (const link of links) {
        const url = sheet.hyperlinks.get(link.rId);
        const at = cellAddress(link.ref.split(':')[0]);
        const i = rowNumbers.indexOf(at.row);
        if (!url || i < 0 || !rows[i][at.col]) continue;
        rows[i][at.col] = `[${rows[i][at.col].replace(/[[\]]/g, '\\$&')}](${url.replace(/[\s()|]/g, encodeURIComponent)})`;
      }

      const table = markdownTable(rows, total - 1);
      const lost = [
        ...table.warnings,
        sheet.charts && t('import.warning.lostCharts', { count: sheet.charts }),
        sheet.images && t('import.warning.lostImages', { count: sheet.images }),
        sheet.pivots && t('import.warning.lostPivots', { count: sheet.pivots }),
        sheet.comments && t('import.warning.lostComments'),
      ].filter((x): x is string => Boolean(x));
      for (const text of lost) warnings.push(t('import.warning.inSheet', { sheet: sheet.name, text }));
      sections.push({ name: sheet.name, lines: table.lines });
    }

    if (hidden.length) warnings.push(t('import.warning.hiddenSheets', { count: hidden.length, names: hidden.join(', ') }));
    if (formulasWithoutValue) warnings.push(t('import.warning.formulasWithoutValue', { count: formulasWithoutValue }));
    if (sections.length === 0) {
      return { markdown: '', warnings: [t('import.warning.emptyWorkbook'), ...warnings], meta: { sections: 0, words: 0 } };
    }
    warnings.push(t('import.warning.sheetFormattingDropped'));

    const title = ctx.filename.replace(/\.[^.]+$/, '');
    const markdown = [`# ${title}`, ...sections.flatMap((s) => ['', `## ${s.name}`, '', ...s.lines])].join('\n');
    return { markdown, title, warnings, meta: { sections: sections.length, words: countWords(markdown) } };
  }
}

/** A cell's displayed value. `formulaOnly`: a formula with no cached result, shown as its text. */
function cellText(cell: StreamCell, date1904 = false): { text: string; formulaOnly?: boolean } {
  const v = cell.value;
  if (v === null || v === undefined) return { text: '' };
  if (v instanceof Date) return { text: formatDate(v) };
  if (typeof v === 'number') return { text: isDateFmt(cell.numFmt) ? formatDate(excelDate(v, date1904)) : formatNumber(v) };
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE' };
  if (typeof v === 'string') return { text: v };
  const o = v as { formula?: string; result?: unknown; error?: string };
  if (o.error) return { text: o.error };
  if ('formula' in o) {
    // An error result is cached as text the reader parses as a number: NaN.
    if (o.result === undefined || Number.isNaN(o.result)) return { text: `=${o.formula ?? ''}`, formulaOnly: true };
    return cellText({ value: o.result, numFmt: cell.numFmt }, date1904);
  }
  return { text: String(v) };
}

// Excel shows 15 significant digits: 0.1 + 0.2 reads 0.3 there, so it does here.
const formatNumber = (n: number) => String(Number(n.toPrecision(15)));

/** Same test exceljs applies to a non-formula cell (its `utils.isDateFmt`). */
const isDateFmt = (fmt?: string) =>
  Boolean(fmt) && /[ymdhMsb]+/.test(fmt!.replace(/\[[^\]]*]/g, '').replace(/"[^"]*"/g, ''));

const excelDate = (serial: number, date1904: boolean) =>
  new Date(Math.round((serial - 25569 + (date1904 ? 1462 : 0)) * 86_400_000));

/** `YYYY-MM-DD`, with ` HH:MM` when the cell holds a time too; a bare time (serial < 1) is `HH:MM`. */
function formatDate(d: Date): string {
  const iso = d.toISOString();
  const time = iso.slice(11, 16);
  if (d.getUTCFullYear() < 1900) return time;
  return time === '00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${time}`;
}

/** `B12` → row 12, column index 1 (0-based, as the parsed row array is). */
function cellAddress(ref: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref) ?? ['', 'A', '0'];
  const col = [...m[1].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return { row: Number(m[2]), col };
}

// --- reading the package ---------------------------------------------------

/** Input fed to the inflater per step: what bounds the decompressed bytes held at once. */
const STEP = 64 * 1024;

/**
 * One zip entry's bytes, inflated a step at a time as the consumer pulls them.
 * Entries other than `path` are skipped without being inflated.
 */
async function* entryChunks(bytes: Uint8Array, path: string): AsyncGenerator<Uint8Array> {
  const out: Uint8Array[] = [];
  let done = false;
  const unzip = new Unzip((file) => {
    if (file.name !== path) return;
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      out.push(chunk);
      done = final;
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let i = 0; i < bytes.length && !done; i += STEP) {
    unzip.push(bytes.subarray(i, i + STEP), i + STEP >= bytes.length);
    while (out.length) yield out.shift()!;
  }
  while (out.length) yield out.shift()!;
}

interface Sheet {
  id: number;
  name: string;
  state?: string;
  /** Zip path of the sheet's XML; absent when the index names a part that is not there. */
  path?: string;
  /** Relationship id → external URL. */
  hyperlinks: Map<string, string>;
  charts: number;
  images: number;
  pivots: number;
  comments: number;
}

interface Package {
  /** Tab order. */
  sheets: Sheet[];
  sharedStrings: string[];
  date1904: boolean;
  styles?: string;
}

const RELS = /^xl\/(?:_rels\/workbook\.xml|worksheets\/_rels\/sheet\d+\.xml|drawings\/_rels\/drawing\d+\.xml)\.rels$/;
const SMALL = new Set(['xl/workbook.xml', 'xl/styles.xml', 'xl/sharedStrings.xml']);

const attrs = (tag: string): Record<string, string> =>
  Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], decodeXml(m[2])]));

const tags = (xml: string | undefined, name: string) =>
  [...(xml ?? '').matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => attrs(m[0]));

/** Every `<si>` as plain text: rich-text runs joined, phonetic guides (`<rPh>`) dropped. */
function sharedStrings(xml: string | undefined): string[] {
  return [...(xml ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
    [...si[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((m) => decodeXml(m[1]))
      .join(''),
  );
}

/**
 * Everything but the sheets' cells: the workbook index, styles, shared strings
 * and relationship files — unzipped on their own — and per sheet its zip path,
 * hyperlink targets and the counts of what will not carry over.
 */
function readPackage(bytes: Uint8Array): Package {
  const zip = unzipSync(bytes, { filter: (f) => SMALL.has(f.name) || RELS.test(f.name) });
  const files: Record<string, string> = Object.fromEntries(Object.entries(zip).map(([n, d]) => [n, strFromU8(d)]));

  // Targets are relative to xl/ or absolute ("/xl/worksheets/sheet1.xml").
  const targets = new Map(
    tags(files['xl/_rels/workbook.xml.rels'], 'Relationship').map((r) => [r.Id, r.Target.replace(/^\/?(xl\/)?/, '')]),
  );
  const sheets = tags(files['xl/workbook.xml'], 'sheet').map((s): Sheet => {
    const target = targets.get(s['r:id']); // worksheets/sheet3.xml
    const sheet: Sheet = {
      id: Number(s.sheetId),
      name: s.name,
      state: s.state,
      path: target && `xl/${target}`,
      hyperlinks: new Map(),
      charts: 0,
      images: 0,
      pivots: 0,
      comments: 0,
    };
    const rels = tags(target && files[`xl/${target.replace(/([^/]+)$/, '_rels/$1')}.rels`], 'Relationship');
    for (const rel of rels) {
      const type = rel.Type?.split('/').pop();
      if (type === 'hyperlink' && rel.TargetMode === 'External') sheet.hyperlinks.set(rel.Id, rel.Target);
      else if (type === 'pivotTable') sheet.pivots++;
      else if (type === 'comments' || type === 'threadedComment') sheet.comments++;
      else if (type === 'drawing') {
        const drawing = rel.Target.split('/').pop();
        for (const d of tags(files[`xl/drawings/_rels/${drawing}.rels`], 'Relationship')) {
          const kind = d.Type?.split('/').pop();
          if (kind === 'chart') sheet.charts++;
          else if (kind === 'image') sheet.images++;
        }
      }
    }
    return sheet;
  });

  const pr = tags(files['xl/workbook.xml'], 'workbookPr')[0];
  return {
    sheets,
    sharedStrings: sharedStrings(files['xl/sharedStrings.xml']),
    date1904: pr?.date1904 === '1' || pr?.date1904 === 'true',
    styles: files['xl/styles.xml'],
  };
}
