/** One login session as the rows read it: the shape of `SessionView` in @knowledge/contracts, which the kit cannot import. */
export interface SessionRow {
  id: string
  /** `password`, `oidc`, `saml` or `ldap`; anything else reads as a password session. */
  authMethod: string
  providerName: string | null
  ip: string | null
  userAgent: string | null
  createdAt: string
  lastSeenAt: string | null
  /** The browser reading the list: no Sign out button. */
  current: boolean
}
