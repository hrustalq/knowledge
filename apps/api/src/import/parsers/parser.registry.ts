import { Injectable } from '@nestjs/common';
import { importFormatFor, type ImportParserId } from '@knowledge/contracts';
import { DocxParser } from './docx.parser.js';
import { HtmlParser } from './html.parser.js';
import { OcrParser } from './ocr.parser.js';
import { PdfParser } from './pdf.parser.js';
import { PlaintextParser } from './plaintext.parser.js';
import { PptxParser } from './pptx.parser.js';
import { StructuredParser } from './structured.parser.js';
import { TabularParser } from './tabular.parser.js';
import type { DocumentParser } from './parser.types.js';

/**
 * Filename + content type → the parser that handles it.
 *
 * The routing itself lives in `importFormatFor` in the contracts package, so
 * the drop zone in the browser and the guard on `POST /v1/imports` and this
 * registry all decide the same way. A file the picker accepts can therefore
 * never be one the worker turns out to have no parser for.
 */
@Injectable()
export class ParserRegistry {
  private readonly byId: Record<ImportParserId, DocumentParser>;

  constructor(
    pdf: PdfParser,
    docx: DocxParser,
    pptx: PptxParser,
    html: HtmlParser,
    tabular: TabularParser,
    structured: StructuredParser,
    plaintext: PlaintextParser,
    ocr: OcrParser,
  ) {
    this.byId = { pdf, docx, pptx, html, tabular, structured, plaintext, ocr };
  }

  /** Null when nothing handles the file — the caller turns that into a 415. */
  resolve(filename: string, contentType: string): DocumentParser | null {
    const format = importFormatFor(filename, contentType);
    return format ? this.byId[format.parser] : null;
  }
}
