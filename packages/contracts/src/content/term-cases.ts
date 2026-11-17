/**
 * The glossary matching table (#1210): every matcher that calls `termPattern` —
 * the web linker, the API's `countOccurrences` and `matchTerms` — runs these
 * same rows in its own spec, so the three cannot drift. Spec-only; no runtime
 * code imports this entry.
 *
 * `match` is the text the term must claim in `text`, or null for none.
 */
export interface TermMatchCase {
  term: string;
  caseSensitive?: boolean;
  text: string;
  match: string | null;
}

export const TERM_MATCH_CASES: readonly TermMatchCase[] = [
  // Russian case and number forms, every word of a multi-word term.
  { term: 'заморозка выкладок', text: 'перед заморозкой выкладок', match: 'заморозкой выкладок' },
  { term: 'заморозка выкладок', text: 'до заморозки выкладок', match: 'заморозки выкладок' },
  { term: 'заморозка выкладок', text: 'объявили заморозку выкладок', match: 'заморозку выкладок' },
  { term: 'Вега', text: 'у Веги нет', match: 'Веги' },
  { term: 'Вега', text: 'с Вегой', match: 'Вегой' },
  { term: 'Вега', text: 'о Веге', match: 'Веге' },
  { term: 'миграция', text: 'после миграции', match: 'миграции' },
  { term: 'сервисный контур', text: 'в сервисном контуре', match: 'сервисном контуре' },
  // A short stem never reaches a different word.
  { term: 'Вега', text: 'в Вегасе', match: null },
  // Never inside a longer word; a hyphenated part is a word of its own.
  { term: 'заморозка', text: 'разморозка', match: null },
  { term: 'заморозка', text: 'микро-заморозка', match: 'заморозка' },
  { term: 'Вега', text: 'Вега-сервис упал', match: 'Вега' },
  // Words split by spaces, a non-breaking space or a hyphen, each inflecting.
  { term: 'Вега-сервис', text: 'Вега сервис упал', match: 'Вега сервис' },
  { term: 'Вега-сервис', text: 'у Веги-сервиса', match: 'Веги-сервиса' },
  { term: 'code freeze', text: 'a code-freeze week', match: 'code-freeze' },
  { term: 'code freeze', text: 'two code freezes', match: 'code freezes' },
  { term: 'code freeze', text: 'the code freeze', match: 'code freeze' },
  // English plural and possessive, nothing more.
  { term: 'deploy freeze', text: 'no deploy freezes', match: 'deploy freezes' },
  { term: 'Orion', text: "Orion's queue", match: "Orion's" },
  { term: 'Orion', text: 'Orionx', match: null },
  { term: 'Order', text: 'reorder the queue', match: null },
  { term: 'Order', text: 'an orderly queue', match: null },
  // Code-like and case-sensitive spellings stay exact.
  { term: '.env', text: 'copy the .env file', match: '.env' },
  { term: '.env', text: 'copy the .envs', match: null },
  { term: 'C++', text: 'in C++ code', match: 'C++' },
  { term: '@Access', text: 'the @Access decorator', match: '@Access' },
  { term: '@Access', text: 'two @Accesses', match: null },
  { term: 'Customer', text: 'the customer_id column', match: null },
  { term: 'customer_id', text: 'the customer_ids column', match: null },
  { term: 'S3', text: 'two S3s', match: null },
  { term: 'IT', caseSensitive: true, text: 'IT team', match: 'IT' },
  { term: 'IT', caseSensitive: true, text: 'did it', match: null },
  { term: 'Deploy', caseSensitive: true, text: 'Deploys', match: null },
];
