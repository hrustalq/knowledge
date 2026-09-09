import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import type { ImportParserId } from '@knowledge/contracts';
import { AgentRegistryService } from '../../agents/agent-registry.service.js';
import { AiUsageService } from '../../ai/ai-usage.service.js';
import {
  countSections,
  countWords,
  inferTitle,
  type DocumentParser,
  type ParseContext,
  type ParseResult,
} from './parser.types.js';
import { t } from '../../i18n/t.js';

// The prompt now lives on the `transcriber` agent (docs/features/20), so an
// admin can adapt it to their documents. It is still deliberately NOT localized
// (docs/features/18): this is a transcription, the prompt forbids translating,
// and the output must match the language of the image rather than the language
// of whoever started the import.
//
// That exemption is also why this parser keeps its own OpenAI client instead of
// going through AssistantClient: `create`/`createStream` append the locale
// directive centrally and unconditionally, which is exactly wrong here.

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
    private readonly agents: AgentRegistryService,
    private readonly usage: AiUsageService,
  ) {}

  async parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParseResult> {
    await ctx.onStage(t('import.stage.checking-vision'), 0.1);
    // The transcriber agent declares `review` as its routing bucket — the same
    // one the glossary suggester uses — so a workspace that configured one
    // provider still gets OCR without configuring a second thing.
    const agent = await this.agents.resolve(ctx.workspaceId, 'transcriber');
    const resolved = agent.config;

    // The capability gate (docs/features/20): refuse rather than transcribe with
    // a model that cannot see. A blind model given an image does not fail — it
    // invents a plausible page, and nothing downstream can tell that apart from
    // a real transcription.
    if (!agent.enabled || !resolved.enabled || !resolved.model || agent.missing.length > 0) {
      throw new Error(
        t('error.import.needsVisionModel'),
      );
    }

    await ctx.onStage(t('import.stage.reading-image'), 0.4);
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
        { role: 'system', content: agent.instructions },
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

    await ctx.onStage(t('import.stage.formatting'), 0.85);

    const warnings = [
      `Text was read from the image by ${resolved.model}. Machine transcription makes mistakes — check names, numbers and anything technical before submitting.`,
    ];
    if (!markdown) {
      warnings.push(t('import.warning.noLegibleText'));
    }

    return {
      markdown,
      title: markdown ? inferTitle(markdown, ctx.filename) : ctx.filename.replace(/\.[^.]+$/, ''),
      warnings,
      meta: { images: 1, sections: countSections(markdown), words: countWords(markdown) },
    };
  }
}
