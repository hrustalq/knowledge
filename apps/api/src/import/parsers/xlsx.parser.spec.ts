import ExcelJS from 'exceljs';
import { importFormatFor } from '@knowledge/contracts';
import { TabularParser } from './tabular.parser.js';
import { XlsxParser } from './xlsx.parser.js';
import type { ParseContext } from './parser.types.js';

// Outside a Nest app `t()` returns the key, so warnings are asserted by key.
const ctx = (filename: string): ParseContext => ({
  workspaceId: 'ws',
  importId: 'imp',
  userId: 'u',
  filename,
  contentType: '',
  onStage: async () => undefined,
});

async function workbook(build: (wb: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('XlsxParser (#707)', () => {
  it('routes .xlsx to the Excel parser', () => {
    expect(importFormatFor('report.xlsx')?.parser).toBe('xlsx');
    expect(
      importFormatFor('report', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')?.parser,
    ).toBe('xlsx');
  });

  it('imports each visible sheet as a section of displayed values', async () => {
    const bytes = await workbook((wb) => {
      const people = wb.addWorksheet('People');
      people.addRow(['Name', 'Score', 'Double', 'Joined']);
      people.addRow(['Ann', 21, { formula: 'B2*2', result: 42 }, new Date(Date.UTC(2026, 0, 15))]);
      people.getCell('D2').numFmt = 'yyyy-mm-dd';
      people.addRow([{ richText: [{ text: 'Bo' }, { text: 'b', font: { bold: true } }] }, 0.1 + 0.2, { error: '#REF!' }]);
      people.addRow([{ text: 'Site', hyperlink: 'https://example.com/a b' }, 'x|y', { formula: 'SUM(B2:B3)' }]);
      people.addRow(['Merged']);
      people.mergeCells('A5:B5');
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
      people.addImage(wb.addImage({ buffer: png, extension: 'png' }), 'F1:G3');

      wb.addWorksheet('Secret', { state: 'hidden' }).addRow(['hidden', 'value']);
      wb.addWorksheet('Blank');
      wb.addWorksheet('Notes').addRows([['Note'], [{ formula: '1+1', result: 2 }]]);
    });

    const out = await new XlsxParser().parse(bytes, ctx('report.xlsx'));

    expect(out.markdown).toBe(
      [
        '# report',
        '',
        '## People',
        '',
        '| Name | Score | Double | Joined |',
        '| --- | --- | --- | --- |',
        '| Ann | 21 | 42 | 2026-01-15 |',
        '| Bob | 0.3 | #REF! |  |',
        '| [Site](https://example.com/a%20b) | x\\|y | =SUM(B2:B3) |  |',
        '| Merged |  |  |  |',
        '',
        '## Notes',
        '',
        '| Note |',
        '| --- |',
        '| 2 |',
      ].join('\n'),
    );
    expect(out.title).toBe('report');
    expect(out.meta.sections).toBe(2);
    expect(out.warnings).toEqual([
      'import.warning.inSheet', // People: 1 image not carried over
      'import.warning.hiddenSheets',
      'import.warning.formulasWithoutValue',
      'import.warning.sheetFormattingDropped',
    ]);
  });

  it('keeps the first 2000 rows of a long sheet and says how many there were', async () => {
    const bytes = await workbook((wb) => {
      const ws = wb.addWorksheet('Log');
      ws.addRow(['n']);
      for (let i = 1; i <= 2500; i++) ws.addRow([i]);
    });

    const out = await new XlsxParser().parse(bytes, ctx('log.xlsx'));
    const lines = out.markdown.split('\n');

    expect(lines.filter((l) => l.startsWith('| ')).length).toBe(2 + 2000);
    expect(lines.at(-1)).toBe('| 2000 |');
    expect(out.warnings).toContain('import.warning.inSheet');
  });

  it('reports an empty workbook rather than an empty page', async () => {
    const out = await new XlsxParser().parse(await workbook((wb) => wb.addWorksheet('Empty')), ctx('e.xlsx'));
    expect(out.markdown).toBe('');
    expect(out.warnings[0]).toBe('import.warning.emptyWorkbook');
  });
});

describe('TabularParser after the table helper was lifted out', () => {
  it('builds the same CSV table as before', async () => {
    const csv = new TextEncoder().encode('a,b,c\n1,"x|y"\n\n3,4,5,6\n');
    const out = await new TabularParser().parse(csv, ctx('data.csv'));
    expect(out.markdown).toBe(
      ['# data', '', '| a | b | c |  |', '| --- | --- | --- | --- |', '| 1 | x\\|y |  |  |', '| 3 | 4 | 5 | 6 |'].join('\n'),
    );
    expect(out.warnings).toEqual([]);
  });
});
