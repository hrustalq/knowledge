/**
 * A URL that carries a login: `scheme://user[:token]@host…`. A token belongs in
 * the credential store; connector config is returned to every viewer of the
 * connector list (#1114). Greedy up to the last `@` before the path, so a
 * password holding an `@` is cut whole.
 */
const URL_LOGIN = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i;

export function hasUrlLogin(value: string): boolean {
  return URL_LOGIN.test(value.trim());
}

/** Config as a reader may see it: every URL-shaped value without its login (#1142, rows saved before #1138). */
export function stripUrlLogins(config: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, typeof value === 'string' && hasUrlLogin(value) ? value.trim().replace(URL_LOGIN, '$1') : value]),
  );
}
