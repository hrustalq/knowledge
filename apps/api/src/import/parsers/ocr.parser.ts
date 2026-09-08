import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import type { ImportParserId } from '@knowledge/contracts';
import { AiConfigService } from '../../ai/ai-config.service.js';
import { AiUsageService } from '../../ai/ai-usage.service.js';
import {
  countSections,
  countWords,
  inferTitle,
  type DocumentParser,
  type ParseContext,
  type ParseResult,
} from './parser.types.js';

const SYSTEM_PROMPT = `You transcribe documents from images into GitHub-flavoured markdown.
Reproduce the text exactly as written — do not summarise, translate, correct or add commentary.
Use # / ## / ### for headings the layout implies, - for bullets, and | tables | for tabular data.
Return only the markdown. If the image contains no legible text, return an empty response.`;

/**
 * Images → markdown, by asking a vision model to transcribe them.
 *
 * This is the one parser that cannot be guaranteed: it needs a vision-capable
 * provider configured for the workspace (docs/features/12), and when there is
 * none it fails with an instruction rather than a stack trace — the review step
 * turns that into "configure a provider", which is the only useful next move.
 *
 * The model is asked to transcribe, never to summarise. An import that quietly
 * paraphrased the document it was given would poison the knowledge base with
 * text nobody wrote.
 */
@Injectable()
export class OcrParser implements DocumentParser {
  readonly id: ImportParserId = 'ocr';
  private readonly logger = new Logger(OcrParser.name);

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly usage: AiUsageService,
  ) {}

  async parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParseResult> {
    await ctx.onStage('Checking for a vision model', 0.1);
    // 'review' is the purpose the glossary suggester already routes at, so a
    // workspace that configured one provider gets OCR without configuring a
    // second thing.
    const resolved = await this.aiConfig.resolveFor(ctx.workspaceId, 'review');

    if (!resolved.enabled || !resolved.model) {
      throw new Error(
        'Reading text from images needs an AI provider with vision support. Configure one under Settings → AI, then run this import again.',
      );
    }

    await ctx.onStage('Reading the image', 0.4);
    const client = new OpenAI({
      apiKey: resolved.apiKey || 'unset',
      baseURL: resolved.baseUrl || undefined,
      timeout: Math.max(resolved.timeoutMs, 60_000),
    });

    const dataUri = `data:${ctx.contentType};base64,${Buffer.from(bytes).toString('base64')}`;
    const started = Date.now();
    const completion = await client.chat.completions.create({
      model: resolved.model,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Transcribe this document image (${ctx.filename}).` },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ],
    });

    const markdown = (completion.choices[0]?.message?.content ?? '').trim();

    // Billed like every other upstream call, so an import shows up in the
    // workspace's AI usage rather than being invisible spend. Fire-and-forget,
    // exactly like ActivityService.record: accounting must never fail a parse.
    const promptTokens = completion.usage?.prompt_tokens ?? 0;
    const completionTokens = completion.usage?.completion_tokens ?? 0;
    void this.usage
      .record({
        config: resolved,
        userId: ctx.userId,
        operation: 'import',
        tokens: {
          promptTokens,
          completionTokens,
          totalTokens: completion.usage?.total_tokens ?? promptTokens + completionTokens,
          estimated: !completion.usage,
        },
        durationMs: Date.now() - started,
        ok: true,
      })
      .catch((e: unknown) => this.logger.warn(`Usage not recorded: ${(e as Error).message}`));

    await ctx.onStage('Formatting', 0.85);

    const warnings = [
      `Text was read from the image by ${resolved.model}. Machine transcription makes mistakes — check names, numbers and anything technical before submitting.`,
    ];
    if (!markdown) {
      warnings.push('No legible text was found in this image.');
    }

    return {
      markdown,
      title: markdown ? inferTitle(markdown, ctx.filename) : ctx.filename.replace(/\.[^.]+$/, ''),
      warnings,
      meta: { images: 1, sections: countSections(markdown), words: countWords(markdown) },
    };
  }
}
