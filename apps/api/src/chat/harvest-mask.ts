import { SECRET_PATTERNS } from '../captures/secret-scan.js';

/**
 * What a harvest (#82) masks before any model reads a chat thread: emails,
 * RU identity numbers (#342), phone numbers, card numbers that pass Luhn, and
 * the credential shapes the capture secret scan knows. Regex and checksums
 * only — no named-entity detection. `findSecret` stays the backstop on each
 * capture.
 *
 * One masker per harvest: the same value gets the same placeholder in every
 * message it is called on, so "[EMAIL_1] asked [EMAIL_2]" still reads as two
 * people. The values themselves are never kept past the call that made it.
 */
type Kind = 'SECRET' | 'EMAIL' | 'PASSPORT' | 'SNILS' | 'INN' | 'CARD' | 'PHONE';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/**
 * A RU passport has no checksum, so ten digits alone prove nothing. Either a
 * context word comes first (`паспорт…`, `серия`, `passport`, within 20
 * non-digit characters) and the series and number may be written any common
 * way (`4509 123456`, `45 09 № 123456`, `4509 номер 123456`, `4509123456`),
 * or there is no context and only the printed `45 09 123456` form counts.
 */
const PASSPORT_RE =
  /(?<=(?:паспорт|серия|серии|passport)[^\d\n]{0,20})(?<!\d)\d{2} ?\d{2}[^\d\n]{0,10}\d{6}(?!\d)|(?<!\d[ -]?)\d{2} \d{2} \d{6}(?![ -]?\d)/gi;
/** `112-233-445 95`, `112 233 445 95` or eleven bare digits; the checksum decides. */
const SNILS_RE = /(?<![\w+-])\d{3}([ -]?)\d{3}\1\d{3}[ -]?\d{2}(?![\w-])/g;
/** Ten or twelve bare digits; the check digits decide. */
const INN_RE = /(?<![\w+-])\d{10}(?:\d{2})?(?![\w-])/g;
/** 13–19 digits, spaces or dashes between them; Luhn decides. */
const CARD_RE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
/**
 * `+7 999 123-45-67`, `8 (999) 123 45 67`, `(555) 123-4567`, `89991234567`.
 * Three-three-two-two, so a date or a time (`2026-10-19 14:30`) never fits.
 */
const PHONE_RE = /(?<![\w+])(?:(?:\+\d{1,3}|8)[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?!\w)/g;

const digitsOf = (m: string) => m.replace(/\D/g, '');

const PATTERNS: ReadonlyArray<readonly [Kind, RegExp, ((match: string) => boolean)?]> = [
  // Secrets first: a token can contain what looks like a card or a phone.
  ...SECRET_PATTERNS.map(([, re]) => ['SECRET', new RegExp(re.source, 'g')] as const),
  ['EMAIL', EMAIL_RE],
  // Identity numbers before phones: bare ten or eleven digits are also a phone
  // shape, and a checksum (or a passport's context) is the stronger claim.
  ['PASSPORT', PASSPORT_RE],
  ['SNILS', SNILS_RE, (m) => snils(digitsOf(m))],
  ['INN', INN_RE, inn],
  ['CARD', CARD_RE, (m) => luhn(digitsOf(m))],
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

/** SNILS: the first nine digits weighted 9…1, mod 101, with 100 read as 00. */
export function snils(digits: string): boolean {
  if (digits.length !== 11) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * (9 - i);
  return (sum % 101) % 100 === Number(digits.slice(9));
}

const INN_WEIGHTS = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
/** The weighted check digit over `digits`, using the tail of the INN weights. */
const innCheck = (digits: string) =>
  ([...digits].reduce((s, d, i) => s + Number(d) * INN_WEIGHTS[INN_WEIGHTS.length - digits.length + i]!, 0) % 11) % 10;

/** INN: one check digit for ten digits (an organisation), two for twelve (a person). */
export function inn(digits: string): boolean {
  if (digits.length === 10) return innCheck(digits.slice(0, 9)) === Number(digits[9]);
  if (digits.length !== 12) return false;
  return innCheck(digits.slice(0, 10)) === Number(digits[10]) && innCheck(digits.slice(0, 11)) === Number(digits[11]);
}

function keyOf(kind: Kind, match: string): string {
  if (kind === 'EMAIL') return match.toLowerCase();
  if (kind === 'PASSPORT' || kind === 'SNILS' || kind === 'INN') return digitsOf(match);
  return match.replace(/[\s().-]/g, '');
}

export function createMasker(): (text: string) => string {
  const seen = new Map<string, string>();
  const counts: Record<Kind, number> = { SECRET: 0, EMAIL: 0, PASSPORT: 0, SNILS: 0, INN: 0, CARD: 0, PHONE: 0 };
  return (text) => {
    let out = text;
    for (const [kind, re, accept] of PATTERNS) {
      out = out.replace(re, (match) => {
        if (accept && !accept(match)) return match;
        const key = `${kind}\0${keyOf(kind, match)}`;
        let placeholder = seen.get(key);
        if (!placeholder) seen.set(key, (placeholder = `[${kind}_${++counts[kind]}]`));
        return placeholder;
      });
    }
    return out;
  };
}
