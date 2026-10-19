import { SECRET_PATTERNS } from '../captures/secret-scan.js';

/**
 * What a harvest (#82) masks before any model reads a chat thread: emails,
 * phone numbers, card numbers that pass Luhn, and the credential shapes the
 * capture secret scan knows. Regex only — no named-entity detection (#342
 * adds RU identity numbers). `findSecret` stays the backstop on each capture.
 *
 * One masker per harvest: the same value gets the same placeholder in every
 * message it is called on, so "[EMAIL_1] asked [EMAIL_2]" still reads as two
 * people. The values themselves are never kept past the call that made it.
 */
type Kind = 'SECRET' | 'EMAIL' | 'CARD' | 'PHONE';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** 13–19 digits, spaces or dashes between them; Luhn decides. */
const CARD_RE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
/**
 * `+7 999 123-45-67`, `8 (999) 123 45 67`, `(555) 123-4567`, `89991234567`.
 * Three-three-two-two, so a date or a time (`2026-10-19 14:30`) never fits.
 */
const PHONE_RE = /(?<![\w+])(?:(?:\+\d{1,3}|8)[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?!\w)/g;

const PATTERNS: ReadonlyArray<readonly [Kind, RegExp, ((match: string) => boolean)?]> = [
  // Secrets first: a token can contain what looks like a card or a phone.
  ...SECRET_PATTERNS.map(([, re]) => ['SECRET', new RegExp(re.source, 'g')] as const),
  ['EMAIL', EMAIL_RE],
  ['CARD', CARD_RE, (m) => luhn(m.replace(/\D/g, ''))],
  ['PHONE', PHONE_RE],
];

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

export function createMasker(): (text: string) => string {
  const seen = new Map<string, string>();
  const counts: Record<Kind, number> = { SECRET: 0, EMAIL: 0, CARD: 0, PHONE: 0 };
  return (text) => {
    let out = text;
    for (const [kind, re, accept] of PATTERNS) {
      out = out.replace(re, (match) => {
        if (accept && !accept(match)) return match;
        const key = `${kind}\0${kind === 'EMAIL' ? match.toLowerCase() : match.replace(/[\s().-]/g, '')}`;
        let placeholder = seen.get(key);
        if (!placeholder) seen.set(key, (placeholder = `[${kind}_${++counts[kind]}]`));
        return placeholder;
      });
    }
    return out;
  };
}
