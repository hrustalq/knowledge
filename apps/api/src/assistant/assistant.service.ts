import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AssistantAskResponse,
  AssistantAskSource,
  AssistantIssue,
  AssistantRelatedResponse,
  AssistantReviewResponse,
  AssistantSuggestResponse,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { SearchService } from '../search/search.service.js';
import type { AssistantAskDto, AssistantRelatedDto, AssistantReviewDto, AssistantSuggestDto } from './assistant.dto.js';

const SEVERITIES = ['error', 'warning', 'suggestion'] as const;

/**
 * Feature 09 (docs/features/09): AI assistant behind an env switch, mirroring
 * the embeddings/extractor pattern. `none` keeps the endpoints alive but
 * degraded (`enabled: false`) so the UI can hint instead of erroring.
 * `related` needs no LLM at all — it reuses hybrid search.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly search: SearchService,
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
  ) {
    this.enabled = config.get('ASSISTANT_PROVIDER', { infer: true }) === 'openai-compatible';
    this.baseUrl = config.get('ASSISTANT_BASE_URL', { infer: true }).replace(/\/$/, '');
    this.model = config.get('ASSISTANT_MODEL', { infer: true });
    this.apiKey = config.get('ASSISTANT_API_KEY', { infer: true });
  }

  async review(dto: AssistantReviewDto): Promise<AssistantReviewResponse> {
    if (!this.enabled) {
      return { enabled: false, issues: [], summary: 'Assistant is disabled (ASSISTANT_PROVIDER=none).' };
    }
    const raw = await this.chat(
      'You review technical documentation. Respond with a single JSON object: ' +
        '{"summary": string, "issues": [{"severity": "error"|"warning"|"suggestion", "message": string, "section": string?}]}. ' +
        'Issues cover factual gaps, contradictions, unclear structure, missing sections and broken references. ' +
        'Be specific and concise; at most 15 issues. Respond with JSON only.',
      `Title: ${dto.title || '(untitled)'}\n\nDocument (markdown):\n\n${dto.markdown.slice(0, 60_000)}`,
    );
    const parsed = this.parseJson(raw);
    const issues: AssistantIssue[] = Array.isArray(parsed?.issues)
      ? (parsed.issues as Array<Record<string, unknown>>)
          .filter((i) => typeof i?.message === 'string')
          .slice(0, 15)
          .map((i) => ({
            severity: SEVERITIES.includes(i.severity as (typeof SEVERITIES)[number])
              ? (i.severity as AssistantIssue['severity'])
              : 'suggestion',
            message: String(i.message),
            ...(typeof i.section === 'string' && i.section ? { section: i.section } : {}),
          }))
      : [];
    const summary = typeof parsed?.summary === 'string' ? parsed.summary : raw.slice(0, 500);
    return { enabled: true, issues, summary };
  }

  async suggest(dto: AssistantSuggestDto): Promise<AssistantSuggestResponse> {
    if (!this.enabled) {
      return { enabled: false, suggestion: '' };
    }
    const suggestion = await this.chat(
      'You help write technical documentation in markdown. Follow the instruction; ' +
        'respond with markdown only — no preamble, no code fences around the whole answer.',
      `Instruction: ${dto.instruction}\n\nTitle: ${dto.title || '(untitled)'}\n\nCurrent draft:\n\n${dto.markdown.slice(0, 60_000)}`,
    );
    return { enabled: true, suggestion: suggestion.trim() };
  }


  /**
   * Chat about one document: the answer is grounded in the page's head-revision
   * content plus related excerpts from hybrid search (+1 graph hop).
   */
  async ask(dto: AssistantAskDto): Promise<AssistantAskResponse> {
    // AclGuard checked dto.workspaceId — make sure the page actually belongs to it
    // (before any other branch, so disabled mode behaves identically).
    const document = await this.prisma.document.findUnique({ where: { id: dto.documentId } });
    if (!document || document.workspaceId !== dto.workspaceId) {
      throw new NotFoundException(`Document ${dto.documentId} not found in workspace`);
    }
    if (!this.enabled) {
      return { enabled: false, answer: 'Assistant is disabled (ASSISTANT_PROVIDER=none).', sources: [] };
    }

    let markdown = '';
    try {
      markdown = (await this.documents.getContent(dto.documentId)).markdown;
    } catch {
      // Draft-only / unreadable revision — answer from related context alone.
    }

    const searchRes = await this.search.search({
      workspaceId: dto.workspaceId,
      query: dto.question.slice(0, 2_000),
      mode: 'hybrid',
      limit: 6,
      expandGraph: { depth: 1 },
    });
    const seen = new Set<string>([dto.documentId]);
    const relatedChunks = searchRes.results.filter((r) => {
      if (seen.has(r.documentId)) return false;
      seen.add(r.documentId);
      return true;
    }).slice(0, 4);

    const context = [
      `# Current page: ${document.title}\n\n${markdown.slice(0, 40_000) || '(no readable content yet)'}`,
      ...relatedChunks.map((r) => `# Related page: ${r.title}\n\n…${r.snippet}…`),
    ].join('\n\n---\n\n');

    const history = (dto.history ?? []).slice(-8).map((t) => ({
      role: t.role,
      content: t.content.slice(0, 4_000),
    }));

    const answer = await this.chatMessages([
      {
        role: 'system',
        content:
          'You answer questions about a documentation page in a team knowledge base. ' +
          'Ground every answer in the provided page content and related excerpts; when the context does not ' +
          'cover the question, say so plainly instead of guessing. Answer in concise markdown.\n\n' +
          `Context:\n\n${context}`,
      },
      ...history,
      { role: 'user', content: dto.question },
    ]);

    const sources: AssistantAskSource[] = [
      { documentId: document.id, title: document.title },
      ...relatedChunks.map((r) => ({ documentId: r.documentId, title: r.title, snippet: r.snippet })),
    ];
    return { enabled: true, answer: answer.trim(), sources };
  }

  /** Relevant-document lookup — plain hybrid search over a draft excerpt; always available. */
  async related(dto: AssistantRelatedDto): Promise<AssistantRelatedResponse> {
    const res = await this.search.search({
      workspaceId: dto.workspaceId,
      query: dto.text.slice(0, 2_000),
      mode: 'hybrid',
      limit: dto.limit ?? 5,
      expandGraph: { depth: 1 },
    });
    return { results: res.results, related: res.related };
  }

  private chat(system: string, user: string): Promise<string> {
    return this.chatMessages([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
  }

  private async chatMessages(messages: Array<{ role: string; content: string }>): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, temperature: 0.2, messages }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.warn(`Assistant upstream ${res.status}: ${body.slice(0, 300)}`);
      throw new ServiceUnavailableException(`Assistant provider responded ${res.status}`);
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? '';
  }

  private parseJson(raw: string): Record<string, unknown> | null {
    const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try {
      return JSON.parse(stripped) as Record<string, unknown>;
    } catch {
      const start = stripped.indexOf('{');
      const end = stripped.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
        } catch {
          /* fall through */
        }
      }
      return null;
    }
  }
}
