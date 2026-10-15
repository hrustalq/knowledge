// Shared by both apps' i18n: the app (i18n/index.ts) and the public reader
// (public-main.ts), which draws some of the same plural strings (#205).

/**
 * Russian plural selection.
 *
 * vue-i18n's default rule is English (two forms). Russian needs four choices —
 * `нет страниц | 1 страница | 2 страницы | 5 страниц` — and 11–14 are "many"
 * despite ending in 1–4, which is exactly the case a naive `n === 1` gets wrong.
 * The teen test is on `n % 100`, not `n`: 111 and 212 are "many" too.
 */
export function russianPluralRule(choice: number, choicesLength: number): number {
  if (choice === 0) return 0
  const mod100 = choice % 100
  const teen = mod100 >= 11 && mod100 <= 19
  const endsWithOne = choice % 10 === 1
  if (!teen && endsWithOne) return 1
  if (!teen && choice % 10 >= 2 && choice % 10 <= 4) return 2
  return choicesLength < 4 ? 2 : 3
}
