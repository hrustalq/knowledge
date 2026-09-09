import { BadRequestException } from '@nestjs/common';
import type { ReviewThreadAnchor } from '@knowledge/contracts';
import type { ThreadAnchorDto } from './dto/merge-requests.dto.js';
import { t } from '../i18n/t.js';

/**
 * Whitespace as rendered is layout, not content: the same passage yields
 * different runs of spaces and newlines depending on where the line broke.
 * Collapsing it is what lets a quote captured in one viewport resolve in
 * another (and in the plain-text projection the reader's browser builds).
 */
export function normalizeQuote(raw: string | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The per-type shape of an anchor, enforced here rather than in the DTO — a
 * polymorphic nested validator buys nothing over one switch, and both the
 * merge-request review threads and the page comments (feature 15) need exactly
 * this check, on exactly the same wire shape.
 */
export function validateThreadAnchor(dto: ThreadAnchorDto): ReviewThreadAnchor {
  switch (dto.type) {
    case 'line':
      if (!dto.revisionId || dto.line === undefined) {
        throw new BadRequestException(t('error.anchor.line'));
      }
      return {
        type: 'line',
        revisionId: dto.revisionId,
        line: dto.line,
        ...(dto.excerpt ? { excerpt: dto.excerpt } : {}),
      };
    case 'text': {
      // A comment on the rendered page. The quote is normalized here — the
      // browser hands over whatever whitespace the layout produced, and the
      // resolver on the read side normalizes the same way, so an anchor
      // written by one client resolves in every other.
      const quote = normalizeQuote(dto.quote);
      if (!dto.revisionId || !quote) {
        throw new BadRequestException(t('error.anchor.text'));
      }
      return {
        type: 'text',
        revisionId: dto.revisionId,
        quote,
        ...(normalizeQuote(dto.prefix) ? { prefix: normalizeQuote(dto.prefix) } : {}),
        ...(normalizeQuote(dto.suffix) ? { suffix: normalizeQuote(dto.suffix) } : {}),
      };
    }
    case 'section':
      if (!dto.heading) throw new BadRequestException(t('error.anchor.section'));
      return { type: 'section', heading: dto.heading };
    case 'entity':
      if (!dto.entityKey) throw new BadRequestException(t('error.anchor.entity'));
      return { type: 'entity', entityKey: dto.entityKey };
  }
}
