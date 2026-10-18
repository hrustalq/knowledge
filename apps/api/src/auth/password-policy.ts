/** Any ConfigService, typed or not: only two keys are read. */
type ConfigReader = { get<T>(key: string): T | undefined };

/**
 * Whether `email` may sign in with a password at all (#75).
 *
 * AUTH_PASSWORD_LOGIN_ENABLED is an instance ceiling; AUTH_BREAK_GLASS_EMAILS
 * is the way past it when the identity provider is down — and the only one,
 * so an SSO-only install is never one IdP outage from being locked out.
 * One predicate for login, signup, forgot-password and the login page's
 * discovery, so they cannot disagree about who sees a password field.
 */
export function passwordAllowedFor(email: string, config: ConfigReader): boolean {
  if (config.get<boolean>('AUTH_PASSWORD_LOGIN_ENABLED') !== false) return true;
  return breakGlassEmails(config).has(email.trim().toLowerCase());
}

export function breakGlassEmails(config: ConfigReader): Set<string> {
  const raw = config.get<string>('AUTH_BREAK_GLASS_EMAILS') ?? '';
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}
