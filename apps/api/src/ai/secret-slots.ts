import { secretSlot, type SecretSlot } from './secret-box.js';

/**
 * Every place a secret-box envelope may live (#1106), one builder per column,
 * so the writer and every reader of a column spell its slot the same way. A
 * leaf module: services on both sides of an import import it, never each other.
 *
 * A row's slot is fixed for its life: its table, column, owning workspace (null
 * for a row that has none) and primary key. A create therefore picks its id
 * before it seals the secret.
 */
type Row = { id: string; workspaceId: string };

export const slots = {
  aiSettingsKey: (workspaceId: string): SecretSlot => secretSlot('ai_settings', 'api_key_cipher', workspaceId, workspaceId),
  aiProviderKey: (row: Row): SecretSlot => secretSlot('ai_providers', 'api_key_cipher', row.workspaceId, row.id),
  aiPluginAuth: (row: Row): SecretSlot => secretSlot('ai_plugins', 'auth_value_cipher', row.workspaceId, row.id),
  agentTriggerWebhook: (row: Row): SecretSlot => secretSlot('agent_triggers', 'webhook_secret', row.workspaceId, row.id),
  chatIntegration: (row: Row, column: 'credential' | 'signing_secret'): SecretSlot =>
    secretSlot('chat_integrations', column, row.workspaceId, row.id),
  publishedSiteVisitor: (row: Row): SecretSlot => secretSlot('published_sites', 'visitor_secret_cipher', row.workspaceId, row.id),
  shareLinkToken: (row: Row): SecretSlot => secretSlot('share_links', 'token_cipher', row.workspaceId, row.id),
  identityProviderSecret: (row: Row): SecretSlot => secretSlot('identity_providers', 'secret_cipher', row.workspaceId, row.id),
  connectorWebhook: (row: Row): SecretSlot => secretSlot('connectors', 'webhook_secret', row.workspaceId, row.id),
  apiTestEnvironmentSecrets: (row: Row): SecretSlot => secretSlot('api_test_environments', 'secrets_cipher', row.workspaceId, row.id),
  /** A person's or a workspace's sign-in: no workspace column, the row id alone places it. */
  credential: (row: { id: string }, column: 'secret' | 'refresh_secret'): SecretSlot => secretSlot('credentials', column, null, row.id),
  /** A PKCE verifier carried in a signed OAuth state, never in a row: the state's nonce places it. */
  oauthStatePkce: (provider: 'plaud' | 'figma', state: { workspaceId: string; nonce: string }): SecretSlot =>
    secretSlot(`oauth_state:${provider}`, 'pkce', state.workspaceId, state.nonce),
};
