import { Injectable } from '@nestjs/common';
import type { ImportParserId } from '@knowledge/contracts';
import {
  countWords,
  inferTitle,
  type DocumentParser,
  type ParseContext,
  type ParseResult,
} from './parser.types.js';
import { t } from '../../i18n/t.js';

/** Past this a markdown table stops being readable and starts being a wall. */
const WIDE_COLUMNS = 12;
/** Rows beyond this are dropped: the point of importing a CSV here is prose context, not a database. */
const MAX_ROWS = 2000;

/**
 * CSV/TSV → a markdown table.
 *
 * Quote-aware by hand rather than by dependency: the format is small enough
 * that RFC 4180's three rules (quoted fields, escaped quotes, newlines inside
 * quotes) fit in thirty lines, and a parser we own cannot surprise us on a file
 * someone exported from a spreadsheet in 2011.
 */
@Injectable()
export class TabularParser implements DocumentParser {
  readonly id: ImportParserId = 'tabular';

  async parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParseResult> {
    await ctx.onStage(t('import.stage.reading-rows'), 0.3);
    const text = new TextDecoder().decode(bytes).replace(/^﻿/, '');
    const delimiter = ctx.filename.toLowerCase().endsWith('.tsv') || countChar(text, '\t') > countChar(text, ',') ? '\t' : ',';

    const rows = parseDelimited(text, delimiter);
    const warnings: string[] = [];

    if (rows.length === 0) {
      return { markdown: '', warnings: ['The file had no rows.'], meta: { words: 0 } };
    }

    let body = rows.slice(1);
    if (body.length > MAX_ROWS) {
      warnings.push(t('import.warning.rowsTruncated', { kept: MAX_ROWS, total: body.length }));
      body = body.slice(0, MAX_ROWS);
    }

    const width = Math.max(...rows.map((r) => r.length));
    if (width > WIDE_COLUMNS) {
      warnings.push(t('import.warning.wideTable', { count: width }));
    }

    await ctx.onStage(t('import.stage.building-table'), 0.7);
    const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill('')].map(escapeCell);
    const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
    const header = pad(rows[0]);
    const title = ctx.filename.replace(/\.[^.]+$/, '');

    const markdown = [
      `# ${title}`,
      '',
      line(header),
      `| ${Array(width).fill('---').join(' | ')} |`,
      ...body.map((r) => line(pad(r))),
    ].join('\n');

    return {
      markdown,
      title: inferTitle(markdown, ctx.filename),
      warnings,
      meta: { sections: 1, words: countWords(markdown) },
    };
  }
}

const countChar = (text: string, ch: string) => text.split(ch).length - 1;
const escapeCell = (value: string) => value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else if (ch !== '\r') field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}
