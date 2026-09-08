import { Module } from '@nestjs/common';
import { AiCoreModule } from '../../ai/ai-core.module.js';
import { DocxParser } from './docx.parser.js';
import { HtmlParser } from './html.parser.js';
import { OcrParser } from './ocr.parser.js';
import { ParserRegistry } from './parser.registry.js';
import { PdfParser } from './pdf.parser.js';
import { PlaintextParser } from './plaintext.parser.js';
import { PptxParser } from './pptx.parser.js';
import { StructuredParser } from './structured.parser.js';
import { TabularParser } from './tabular.parser.js';

/**
 * The parsing half of the import feature. Worker-only: nothing in the API
 * process should ever be able to start a parse, and keeping the module out of
 * `AppModule` is what guarantees it.
 *
 * AiCoreModule is imported for the OCR parser alone, and is the worker-safe
 * slice of the AI layer — the same one `ExtractorFactory` depends on.
 */
@Module({
  imports: [AiCoreModule],
  providers: [
    PdfParser,
    DocxParser,
    PptxParser,
    HtmlParser,
    TabularParser,
    StructuredParser,
    PlaintextParser,
    OcrParser,
    ParserRegistry,
  ],
  exports: [ParserRegistry],
})
export class ParsersModule {}
