import { BadRequestException } from '@nestjs/common';
import type { DocumentContentResponse } from '@knowledge/contracts';
import { formatPageRef, type LineSpan } from '@knowledge/editor-schema/markdown';
import { t } from '../i18n/t.js';

/** `?lines=40-52` or `?lines=40` (#708); anything else is a 400. */
export function parseLinesParam(raw: string): LineSpan {
  const match = /^(\d+)(?:-(\d+))?$/.exec(raw.trim());
  if (!match) throw new BadRequestException(t('error.document.linesInvalid', { lines: raw }));
  return { start: Number(match[1]), end: Number(match[2] ?? match[1]) };
}

/**
 * Lines `span` of a content read (#708): 1-based lines of `markdown` as
 * returned (frontmatter excluded), plus the passage link to cite — pinned to
 * the revision, so the lines it names never move. Out of range is a 400.
 */
export function contentLines(content: DocumentContentResponse, span: LineSpan, webBaseUrl: string): DocumentContentResponse {
  const lines = content.markdown.split('\n');
  if (span.start < 1 || span.end < span.start || span.end > lines.length) {
    throw new BadRequestException(
      t('error.document.linesOutOfRange', { start: span.start, end: span.end, total: lines.length }),
    );
  }
  const web = webBaseUrl.replace(/\/+$/, '');
  return {
    ...content,
    markdown: lines.slice(span.start - 1, span.end).join('\n'),
    startLine: span.start,
    endLine: span.end,
    totalLines: lines.length,
    reference: `${web}/documents/${content.documentId}?revision=${content.revisionId}#${formatPageRef(span)}`,
  };
}
