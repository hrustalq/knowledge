import type { DocumentCategory } from '@knowledge/contracts/documents';
import type { ApiSpecKind } from '@knowledge/contracts/api';
import { FIGMA_ALLOWLIST_CONFIG_KEY, FIGMA_TOKEN_EXPIRES_CONFIG_KEY } from '@knowledge/contracts/embeds';

// configured sources and destinations. A connector is one configured
// connection; a link is the recorded identity between an external item and a
// page; a run is one sync execution, polled by the client.
// ---------------------------------------------------------------------------

/**
 * The closed catalogue of adapters. Routed by `connectorKindInfo` below, which
 * the settings UI, the create guard and the worker registry all read, so they
 * cannot disagree about what exists.
 */
export const CONNECTOR_KINDS = [
  'confluence',
  'confluence-server',
  'jira',
  'notion',
  'markdown-git',
  'codebase',
  'google-drive',
  'linear',
  'zendesk',
  'intercom',
  'figma',
  // A source-backed page's source (#674): one URL, fetched and replaced whole.
  'web',
] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/** 'pull' | 'push' | 'both' — what a connector is allowed to do. */
export type ConnectorDirection = 'pull' | 'push' | 'both';
/** One sync execution only ever moves one way. */
export type ConnectorRunDirection = 'pull' | 'push';
export type ConnectorTrigger = 'manual' | 'schedule' | 'webhook';
/**
 * What to do when the external item and the page both changed since the last
 * sync. 'manual' overwrites nothing: it opens a merge request.
 */
export type ConnectorConflictPolicy = 'manual' | 'external-wins' | 'local-wins';
export type ConnectorRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'awaiting-review'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

/**
 * How much of a run happens without a person (docs/features/26).
 *
 * `auto` is the default and reproduces the pre-feature behaviour exactly: items
 * are staged and applied in the same pass. The other two exist because a pull
 * from a wiki is not a transfer, it is an edit to somebody's knowledge base.
 */
export type ConnectorSyncMode = (typeof CONNECTOR_SYNC_MODES)[number];

/** Which part of its work a run is in. Distinct from `status`: a run can be paused while discovering. */
export type ConnectorRunPhase = 'discovering' | 'fetching' | 'awaiting-review' | 'applying' | 'reverting';

/** What an adapter can actually do. `push: false` is how Jira says it is pull-only. */
export interface ConnectorCapabilities {
  pull: boolean;
  push: boolean;
  webhook: boolean;
  /**
   * The adapter implements `children()` and can reproduce the external
   * hierarchy. False adapters take the flat `list()` path, unchanged.
   */
  tree: boolean;
  /**
   * The external system carries units of work — issues, pull requests — that a
   * page can be attached to (docs/features/32).
   *
   * Optional rather than required, unlike the four above: they describe how
   * content moves and every adapter has an answer, while this describes a
   * second kind of object most connectors do not have at all. `undefined` reads
   * as false everywhere, so declaring it only where it is true keeps the six
   * adapters that have no work items from claiming a capability by boilerplate.
   */
  tasks?: boolean;
  /**
   * The adapter can read who may open an item upstream and mirror it as a page
   * restriction (#76). Optional for the reason `tasks` is. An adapter without
   * it can still be restricted, as a whole, to one workspace group: the
   * connector-level audience (`aclAudienceGroupId`).
   */
  acl?: boolean;
  /**
   * A resolved item can be harvested into reviewed captures (#382–#384, doc
   * 59). Such a kind moves no content — `pull` and `push` are false — and is
   * fed by its webhook alone. Optional for the reason `tasks` is.
   */
  harvest?: boolean;
  /**
   * The source's items can be embedded in pages (#470, doc 64): a token and an
   * allowlist, no content moved either way. Optional for the reason `tasks` is.
   */
  embeds?: boolean;
}

/** The label a harvest connector looks for when `config.harvestLabel` is empty. */
export const DEFAULT_HARVEST_LABEL = 'knowledge';

/**
 * The JSON body a Zendesk trigger's webhook action sends (#383). Zendesk
 * sends what the trigger says, so the admin pastes exactly this, the setup
 * dialog shows it, and the adapter reads that shape.
 */
export const ZENDESK_TRIGGER_BODY =
  '{"ticket_id":"{{ticket.id}}","status":"{{ticket.status}}","updated_by_id":"{{current_user.id}}","updated_by_name":"{{current_user.name}}","updated_by_email":"{{current_user.email}}"}';

// ---------------------------------------------------------------------------
// Access mirroring (#76, phase 6)
// ---------------------------------------------------------------------------

/**
 * How a connector carries upstream permissions onto the pages it writes.
 *
 * - `off` — nothing. The default, and the pre-milestone behaviour.
 * - `mirror` — a page restricted upstream is restricted here to the mapped
 *   people and mirrored groups. Principals with no mapped person are dropped
 *   and listed on the connector page.
 * - `mirror_strict` — `mirror`, failing closed: a page with any unmapped
 *   principal also admits the connector's owner (and admins, as always), so it
 *   cannot end up readable by nobody who could fix the mapping.
 *
 * Either mode restricts a page whose upstream ACL could not be read to the
 * owner, rather than leaving it open.
 */
export const CONNECTOR_ACL_MODES = ['off', 'mirror', 'mirror_strict'] as const;
export type ConnectorAclMode = (typeof CONNECTOR_ACL_MODES)[number];

/** `source-wide`: everyone who can see the connector's scope upstream. `restricted`: only the listed principals. */
export const EXTERNAL_ACL_AUDIENCES = ['source-wide', 'restricted'] as const;
export type ExternalAclAudience = (typeof EXTERNAL_ACL_AUDIENCES)[number];

/**
 * How an upstream identity got its person here, strongest first: an admin
 * said so, the provider account is linked (GitHub), or a verified email
 * matched. Null while unmapped.
 */
export const EXTERNAL_IDENTITY_MAPPINGS = ['manual', 'provider', 'email'] as const;
export type ExternalIdentityMapping = (typeof EXTERNAL_IDENTITY_MAPPINGS)[number];

export interface ExternalIdentityEntry {
  id: string;
  externalId: string;
  /** Upstream's name for them — a login, a display name. Rendered as text. */
  displayName: string | null;
  email: string | null;
  userId: string | null;
  /** The mapped person's name here, when there is one. */
  userDisplayName: string | null;
  mappedBy: ExternalIdentityMapping | null;
  lastSeenAt: string;
}

// GET /v1/connectors/:id/acl
export interface ConnectorAclResponse {
  connectorId: string;
  mode: ConnectorAclMode;
  /** Minutes between ACL-only refreshes; null = the server default. */
  syncIntervalMinutes: number | null;
  /** The default that applies when `syncIntervalMinutes` is null. */
  defaultSyncIntervalMinutes: number;
  /** One workspace group every page is restricted to, for adapters that cannot read upstream ACLs. */
  audienceGroupId: string | null;
  /** Whether this kind reads per-item ACLs; false means only the audience group applies. */
  perItem: boolean;
  syncedAt: string | null;
  /** Pages this connector currently restricts. */
  restrictedPages: number;
  /** Groups mirrored from the source, read-only in the groups tab. */
  groupCount: number;
  identities: ExternalIdentityEntry[];
}

// PUT /v1/connectors/:id/acl
export interface UpdateConnectorAclRequest {
  mode: ConnectorAclMode;
  syncIntervalMinutes?: number | null;
  audienceGroupId?: string | null;
}

// PUT /v1/connectors/:id/acl/identities/:identityId
export interface MapExternalIdentityRequest {
  /** A workspace member, or null to clear a manual mapping (it re-resolves on the next sync). */
  userId: string | null;
}

/** One configurable, non-secret setting an adapter needs (drives the settings form). */
export interface ConnectorConfigField {
  key: string;
  label: string;
  /** `text` renders an input, `select` a dropdown over `options`. */
  kind: 'text' | 'select';
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
}

export interface ConnectorKindInfo {
  kind: ConnectorKind;
  label: string;
  capabilities: ConnectorCapabilities;
  /** What to paste into the credential box, e.g. 'email:api-token'. */
  credentialLabel: string;
  fields: readonly ConnectorConfigField[];
}

/**
 * Adapter catalogue. Kept in contracts rather than the API so the settings form
 * can render a connector's fields without a round trip, exactly as
 * `IMPORT_FORMATS` lets the drop zone and the reserve guard agree (feature 16).
 */
export const CONNECTOR_KIND_INFO: readonly ConnectorKindInfo[] = [
  {
    kind: 'confluence',
    label: 'Confluence',
    capabilities: { pull: true, push: true, webhook: true, tree: true, acl: true },
    credentialLabel: 'email:api-token',
    fields: [
      {
        key: 'baseUrl',
        label: 'Site URL',
        kind: 'text',
        required: true,
        placeholder: 'https://your-team.atlassian.net/wiki',
      },
      { key: 'spaceKey', label: 'Space key', kind: 'text', required: true, placeholder: 'ENG' },
      {
        key: 'rootPageId',
        label: 'Root page ID',
        kind: 'text',
        required: false,
        placeholder: '123456',
        help: 'Sync only this page and everything under it. Leave empty for the whole space.',
      },
    ],
  },
  {
    // Confluence Server / Data Center is a different product behind the same
    // name: no /api/v2 at all, a PAT over Bearer instead of `email:api-token`
    // over Basic, and spaces addressed by key rather than by a numeric id. A
    // second kind rather than a variant flag on the first, because the
    // credential hint and the setup questions both differ — and a variant would
    // be enforced by nothing, where a kind is checked against every
    // Record<ConnectorKind, ...> in the API and the web.
    kind: 'confluence-server',
    label: 'Confluence (Server / Data Center)',
    capabilities: { pull: true, push: true, webhook: true, tree: true, acl: true },
    credentialLabel: 'Personal access token',
    fields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        kind: 'text',
        required: true,
        placeholder: 'https://confluence.example.com',
        help: 'Self-hosted Confluence. Cloud sites (*.atlassian.net) use the Confluence connector instead.',
      },
      { key: 'spaceKey', label: 'Space key', kind: 'text', required: true, placeholder: 'ENG' },
      {
        key: 'rootPageId',
        label: 'Root page ID',
        kind: 'text',
        required: false,
        placeholder: '123456',
        help: 'Sync only this page and everything under it. Leave empty for the whole space.',
      },
    ],
  },
  {
    kind: 'jira',
    label: 'Jira',
    // `tasks` since #424: a Jira connector is a tracker that knowledge objects
    // are handed off to, with or without pulling issues in as pages.
    capabilities: { pull: true, push: false, webhook: true, tree: false, tasks: true },
    credentialLabel: 'email:api-token',
    fields: [
      {
        key: 'baseUrl',
        label: 'Site URL',
        kind: 'text',
        required: true,
        placeholder: 'https://your-team.atlassian.net',
      },
      {
        key: 'jql',
        label: 'JQL',
        kind: 'text',
        required: false,
        placeholder: 'project = ENG AND issuetype = Epic',
        help: 'Which issues become pages. Leave empty to use this connector only as a tracker.',
      },
      {
        key: 'projectKey',
        label: 'Default project key',
        kind: 'text',
        required: false,
        placeholder: 'ENG',
        help: "Where handed-off tickets go when the knowledge project's tracker route names no Jira project.",
      },
    ],
  },
  {
    kind: 'notion',
    label: 'Notion',
    capabilities: { pull: true, push: true, webhook: true, tree: false },
    credentialLabel: 'Internal integration secret',
    fields: [
      {
        key: 'databaseId',
        label: 'Database or page id',
        kind: 'text',
        required: false,
        help: 'Leave empty to sync everything the integration can see.',
      },
    ],
  },
  {
    kind: 'markdown-git',
    label: 'Markdown / Git',
    capabilities: { pull: true, push: true, webhook: true, tree: false, tasks: true, acl: true },
    credentialLabel: 'Personal access token',
    fields: [
      {
        key: 'repoUrl',
        label: 'Repository URL',
        kind: 'text',
        required: true,
        placeholder: 'https://github.com/acme/runbooks',
        help: 'GitHub and GitLab can be pushed to; other hosts are pull-only.',
      },
      { key: 'branch', label: 'Branch', kind: 'text', required: false, placeholder: 'main' },
      {
        key: 'subdir',
        label: 'Subdirectory',
        kind: 'text',
        required: false,
        placeholder: 'docs',
        help: 'Only markdown under this path is synced. An Obsidian vault is just a folder.',
      },
      {
        // #78: spec files sync as API reference documents beside the pages.
        // A comma- or newline-separated string, because config values are
        // strings; `apiSpecGlobs` is the one reader.
        key: 'apiSpecs',
        label: 'API specs',
        kind: 'text',
        required: false,
        placeholder: 'openapi.yaml, specs/**/*.json',
        help: 'OpenAPI or AsyncAPI files to sync as API reference pages, matched from the repository root. A changed spec arrives as a merge request.',
      },
      {
        key: 'driftCheck',
        label: 'Drift check',
        kind: 'select',
        required: false,
        help: 'When a pull or merge request opens or gets new commits, check the pages it may make wrong. Needs a webhook.',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'report', label: 'Report on the pull request' },
          { value: 'propose', label: 'Report and propose page updates' },
        ],
      },
    ],
  },
  {
    // The repository as a subject rather than as a folder of pages
    // (docs/features/27). `markdown-git` mirrors files that are already prose;
    // this reads the code and derives pages that exist nowhere upstream. Same
    // archive download underneath — the difference is that the unit keys are
    // ours, so there is nothing on the far side to push back to.
    kind: 'codebase',
    label: 'Codebase',
    // Pull only. A push event names *files*, and which module a file belongs to
    // is not knowable until the archive has been read — so a webhook does not
    // guess units (every wrong guess would seed an identity-map key for a page
    // that does not exist). Since the repo wiki (docs/features/46) a push queues
    // an *unscoped* run instead, debounced, and the input-hash check skips
    // every unit whose inputs did not move before anything is fetched.
    capabilities: { pull: true, push: false, webhook: true, tree: false, tasks: true, acl: true },
    credentialLabel: 'Personal access token',
    fields: [
      {
        key: 'repoUrl',
        label: 'Repository URL',
        kind: 'text',
        required: true,
        placeholder: 'https://github.com/acme/service',
        help: 'The repository to document. A private repository needs a token with read access.',
      },
      { key: 'branch', label: 'Branch', kind: 'text', required: false, placeholder: 'main' },
      {
        key: 'subdir',
        label: 'Subdirectory',
        kind: 'text',
        required: false,
        placeholder: 'src',
        help: 'Only code under this path is read. Leave empty for the whole repository.',
      },
      {
        // #78: spec files sync as API reference documents beside the pages.
        // A comma- or newline-separated string, because config values are
        // strings; `apiSpecGlobs` is the one reader.
        key: 'apiSpecs',
        label: 'API specs',
        kind: 'text',
        required: false,
        placeholder: 'openapi.yaml, specs/**/*.json',
        help: 'OpenAPI or AsyncAPI files to sync as API reference pages, matched from the repository root. A changed spec arrives as a merge request.',
      },
      {
        key: 'maxModules',
        label: 'Module limit',
        kind: 'text',
        required: false,
        placeholder: '24',
        help: 'At most this many module pages, largest first. Defaults to 24.',
      },
      {
        key: 'wiki',
        label: 'Repo wiki',
        kind: 'select',
        required: false,
        help: 'Add architecture, data-flow and API pages with diagrams. A .knowledge/wiki.yml file in the repository steers which sections exist.',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ],
      },
      {
        key: 'wikiEffort',
        label: 'Wiki effort',
        kind: 'select',
        required: false,
        help: 'Overrides the effort in .knowledge/wiki.yml. Low makes no AI calls; the server may cap it.',
        options: [
          { value: '', label: 'From the repository' },
          { value: 'low', label: 'Low — facts and diagrams only' },
          { value: 'medium', label: 'Medium — plus a written summary' },
          { value: 'high', label: 'High — plus reading the code' },
        ],
      },
      {
        key: 'changelog',
        label: 'Release notes',
        kind: 'select',
        required: false,
        help: 'One page per release tag plus Unreleased, from commits and merged pull requests, with breaking changes called out.',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ],
      },
      {
        key: 'wikiAutoRegenerate',
        label: 'Regenerate on push',
        kind: 'select',
        required: false,
        help: 'Re-derive the wiki when the branch is pushed to. Needs the GitHub App or this connector’s webhook.',
        options: [
          { value: 'off', label: 'Off — scheduled and manual syncs only' },
          { value: 'on-push', label: 'On push to the branch' },
        ],
      },
      {
        key: 'wikiDelivery',
        label: 'Wiki delivery',
        kind: 'select',
        required: false,
        help: 'How a regenerated page reaches readers. A merge request lets someone review it first.',
        options: [
          { value: 'direct', label: 'Update the page directly' },
          { value: 'merge-request', label: 'Open a merge request' },
        ],
      },
      {
        key: 'driftCheck',
        label: 'Drift check',
        kind: 'select',
        required: false,
        help: 'When a pull or merge request opens or gets new commits, check the pages it may make wrong. Needs a webhook.',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'report', label: 'Report on the pull request' },
          { value: 'propose', label: 'Report and propose page updates' },
        ],
      },
    ],
  },
  {
    // A folder tree of files rather than a wiki (#338). Pull only: a page here
    // is a conversion of a Doc, a PDF or a Word file, and none of those can be
    // rebuilt from markdown without losing what the conversion dropped. No
    // webhook either — Drive push notifications need a verified domain, so
    // change detection is the Changes API, polled by scheduled syncs.
    kind: 'google-drive',
    label: 'Google Drive',
    capabilities: { pull: true, push: false, webhook: false, tree: true, acl: true },
    credentialLabel: 'Service account JSON key',
    fields: [
      {
        key: 'folderId',
        label: 'Folder or shared drive ID',
        kind: 'text',
        required: true,
        placeholder: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
        help: 'The last part of the folder URL. Share the folder (or add the service account to the shared drive) so it can read it.',
      },
      {
        key: 'subject',
        label: 'Act as user',
        kind: 'text',
        required: false,
        placeholder: 'docs-reader@example.com',
        help: 'Domain-wide delegation: read Drive as this person instead of as the service account. Also needed to read Google Groups when access is mirrored.',
      },
    ],
  },
  {
    // A harvest source (#382, doc 59): a resolved, labelled issue becomes
    // reviewed captures in the name of whoever resolved it. Nothing is synced
    // either way, so there is no destination tree and no runs.
    kind: 'linear',
    label: 'Linear',
    capabilities: { pull: false, push: false, webhook: true, tree: false, harvest: true },
    credentialLabel: 'Personal API key',
    fields: [
      {
        key: 'harvestLabel',
        label: 'Harvest label',
        kind: 'text',
        required: false,
        placeholder: DEFAULT_HARVEST_LABEL,
        help: 'An issue carrying this label is harvested when it is completed. Leave empty for "knowledge".',
      },
    ],
  },
  {
    // A harvest source (#383, doc 59): a solved ticket carrying the tag, in
    // the name of the agent who solved it. Fed by a trigger's webhook.
    kind: 'zendesk',
    label: 'Zendesk',
    capabilities: { pull: false, push: false, webhook: true, tree: false, harvest: true },
    credentialLabel: 'email:api-token',
    fields: [
      { key: 'baseUrl', label: 'Zendesk URL', kind: 'text', required: true, placeholder: 'https://your-team.zendesk.com' },
      {
        key: 'harvestLabel',
        label: 'Harvest tag',
        kind: 'text',
        required: false,
        placeholder: DEFAULT_HARVEST_LABEL,
        help: 'A ticket carrying this tag is harvested when it is solved. Leave empty for "knowledge".',
      },
    ],
  },
  {
    // A harvest source (#384, doc 59): a conversation an admin closes while
    // it carries the tag, in that admin's name. Fed by the app's webhook.
    kind: 'intercom',
    label: 'Intercom',
    capabilities: { pull: false, push: false, webhook: true, tree: false, harvest: true },
    credentialLabel: 'Access token',
    fields: [
      {
        key: 'region',
        label: 'Data region',
        kind: 'select',
        required: false,
        options: [
          { value: 'us', label: 'United States' },
          { value: 'eu', label: 'Europe' },
          { value: 'au', label: 'Australia' },
        ],
        help: 'Where your Intercom workspace is hosted. Leave on United States unless it is in Europe or Australia.',
      },
      {
        key: 'harvestLabel',
        label: 'Harvest tag',
        kind: 'text',
        required: false,
        placeholder: DEFAULT_HARVEST_LABEL,
        help: 'A conversation carrying this tag is harvested when an admin closes it. Leave empty for "knowledge".',
      },
    ],
  },
  {
    // An embed source (#470, doc 64): frames from the allowlisted teams and
    // projects can be embedded in pages. Nothing syncs either way; the
    // connector's tick checks whether pinned frames changed.
    kind: 'figma',
    label: 'Figma',
    capabilities: { pull: false, push: false, webhook: false, tree: false, embeds: true },
    credentialLabel: 'Personal access token',
    fields: [
      {
        key: FIGMA_ALLOWLIST_CONFIG_KEY,
        label: 'Teams and folders',
        kind: 'text',
        required: true,
        placeholder: 'https://www.figma.com/files/team/1234567890/Design',
        help: 'Figma team or folder links (or team:<id>, folder:<id>), separated by spaces or commas. Only their files can be embedded.',
      },
      {
        key: FIGMA_TOKEN_EXPIRES_CONFIG_KEY,
        label: 'Token expires on',
        kind: 'text',
        required: false,
        placeholder: '2027-01-31',
        help: 'The expiry you chose when creating the token, as YYYY-MM-DD. Figma does not report it, so the card warns from this date.',
      },
    ],
  },
  {
    // Source-backed pages (#674): a markdown or HTML URL whose page here is
    // read-only and replaced by each new version. No push, no tree yet.
    kind: 'web',
    label: 'Web page',
    capabilities: { pull: true, push: false, webhook: true, tree: false },
    credentialLabel: 'Token, or Header-Name: value',
    fields: [
      {
        key: 'url',
        label: 'URL',
        kind: 'text',
        required: true,
        placeholder: 'https://example.com/docs/guide.md',
        help: 'A markdown file or an HTML page. The page it becomes is read-only and follows the source.',
      },
    ],
  },
];

export function connectorKindInfo(kind: string): ConnectorKindInfo | null {
  return CONNECTOR_KIND_INFO.find((k) => k.kind === kind) ?? null;
}

// ---------------------------------------------------------------------------
// Connections (#564): one account's access to one upstream system, shared by
// every connector of a compatible kind in the workspace.
// ---------------------------------------------------------------------------

/**
 * Who a connection authenticates against. Derived from the connector kind (and
 * the host, for git kinds) by `connectionProviderFor`, never chosen: that is
 * what lets one Atlassian token serve Confluence and Jira on the same site.
 */
export const CONNECTION_PROVIDERS = [
  'github',
  'gitlab',
  'git',
  'atlassian',
  'confluence-server',
  'notion',
  'google',
  'linear',
  'zendesk',
  'intercom',
  'figma',
  // Any host a `web` source reads (#674), one connection per origin.
  'web',
] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

/**
 * How a connection authenticates: a pasted secret, a GitHub App installation
 * (`external_ref` = installation id), or a user grant with refresh
 * (`external_ref` = the Figma grant).
 */
export const CONNECTION_METHODS = ['token', 'app', 'oauth'] as const;
export type ConnectionMethod = (typeof CONNECTION_METHODS)[number];

export interface ConnectionTarget {
  provider: ConnectionProvider;
  /** The upstream origin when the provider is not one fixed host: an Atlassian site, a GitLab instance. */
  site: string | null;
}

/** github.com, anything calling itself GitLab, or a plain git host — `repoHost` in the API reads the same rule. */
export function gitProviderOf(hostname: string): 'github' | 'gitlab' | 'git' {
  return hostname === 'github.com' ? 'github' : hostname.includes('gitlab') ? 'gitlab' : 'git';
}

function originOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value.trim()).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** The provider a connector of `kind` with `config` authenticates against. */
export function connectionProviderFor(kind: ConnectorKind, config: Record<string, unknown>): ConnectionTarget {
  switch (kind) {
    case 'markdown-git':
    case 'codebase': {
      const site = originOf(config.repoUrl);
      const provider = site ? gitProviderOf(new URL(site).hostname) : 'git';
      // GitHub Enterprise is out of scope, so github.com needs no site.
      return { provider, site: provider === 'github' ? null : site };
    }
    case 'confluence':
    case 'jira':
      return { provider: 'atlassian', site: originOf(config.baseUrl) };
    case 'confluence-server':
      return { provider: 'confluence-server', site: originOf(config.baseUrl) };
    case 'zendesk':
      return { provider: 'zendesk', site: originOf(config.baseUrl) };
    case 'google-drive':
      return { provider: 'google', site: null };
    case 'intercom':
      // A token belongs to one region's API host.
      return { provider: 'intercom', site: `https://api.${config.region === 'eu' || config.region === 'au' ? `${config.region}.` : ''}intercom.io` };
    case 'notion':
    case 'linear':
    case 'figma':
      return { provider: kind, site: null };
    case 'web':
      return { provider: 'web', site: originOf(config.url) };
  }
}

/**
 * How an OAuth or App round trip ended (#564). Every callback lands on the web
 * page `/oauth/:provider?outcome=…&returnTo=…`, which says it in words.
 */
export const OAUTH_OUTCOMES = ['connected', 'installed', 'auth-failed', 'install-failed', 'error'] as const;
export type OauthOutcome = (typeof OAUTH_OUTCOMES)[number];

/** The landing URL a callback redirects to. `returnTo` is already a signed, same-origin path, or absent for a forged state. */
export function oauthLandingPath(provider: 'github' | 'figma', outcome: OauthOutcome, returnTo?: string): string {
  const params = new URLSearchParams({ outcome, ...(returnTo ? { returnTo } : {}) });
  return `/oauth/${provider}?${params.toString()}`;
}

/** The kinds a connection of `provider` can feed — the inverse of `connectionProviderFor`. */
export function connectionKindsFor(provider: ConnectionProvider): ConnectorKind[] {
  switch (provider) {
    case 'github':
    case 'gitlab':
    case 'git':
      return ['codebase', 'markdown-git'];
    case 'atlassian':
      return ['confluence', 'jira'];
    case 'google':
      return ['google-drive'];
    default:
      return [provider];
  }
}

/** How a provider can be connected. `app` and `oauth` also need their env keys; the server says which are live. */
export function connectionMethodsFor(provider: ConnectionProvider): ConnectionMethod[] {
  return provider === 'github' ? ['token', 'app'] : provider === 'figma' ? ['token', 'oauth'] : ['token'];
}

/**
 * The config keys that say *what* a connector reads, as opposed to how. Two
 * connectors of one kind in one project with equal values here are the same
 * link, which `POST /v1/connections/:id/links` refuses (#564).
 */
export const CONNECTOR_RESOURCE_KEYS: Record<ConnectorKind, readonly string[]> = {
  confluence: ['baseUrl', 'spaceKey', 'rootPageId'],
  'confluence-server': ['baseUrl', 'spaceKey', 'rootPageId'],
  jira: ['baseUrl', 'jql', 'projectKey'],
  notion: ['databaseId'],
  'markdown-git': ['repoUrl', 'subdir'],
  codebase: ['repoUrl', 'subdir'],
  'google-drive': ['folderId'],
  linear: ['harvestLabel'],
  zendesk: ['baseUrl', 'harvestLabel'],
  intercom: ['region', 'harvestLabel'],
  figma: [FIGMA_ALLOWLIST_CONFIG_KEY],
  web: ['url'],
};

/** The duplicate-link key: the resource keys, trimmed, case-folded, without a trailing `/` or `.git`. */
export function connectorResourceKey(kind: ConnectorKind, config: Record<string, unknown>): string {
  return [
    kind,
    ...CONNECTOR_RESOURCE_KEYS[kind].map((key) =>
      String(config[key] ?? '')
        .trim()
        .toLowerCase()
        .replace(/\.git$/, '')
        .replace(/^\/+|\/+$/g, ''),
    ),
  ].join('\n');
}

// GET /v1/connections?workspaceId=
export interface ConnectionSummary {
  id: string;
  workspaceId: string;
  provider: ConnectionProvider;
  method: ConnectionMethod;
  site: string | null;
  accountId: string | null;
  /** The upstream login or name the identify probe returned; null for a connection made by the backfill. */
  accountLabel: string | null;
  accountAvatarUrl: string | null;
  /** Last-4 hint of a `token` connection. */
  credentialHint: string | null;
  /** The connectors dialing through it — what a delete would strand. */
  connectors: Array<{ id: string; name: string; kind: ConnectorKind; projectId: string }>;
  createdAt: string;
  updatedAt: string;
}
export interface ListConnectionsResponse {
  workspaceId: string;
  connections: ConnectionSummary[];
  /** Methods the server can complete now: `app` needs the GitHub App keys, `oauth` the Figma OAuth keys. */
  methods: { app: boolean; oauth: boolean };
  /** False when SETTINGS_ENCRYPTION_KEY is unset — no token can be saved. */
  canStoreSecrets: boolean;
}
export interface ConnectionResponse {
  connection: ConnectionSummary;
}

// POST /v1/connections — identify the token's account; the same account again rotates it.
export interface CreateTokenConnectionRequest {
  workspaceId: string;
  provider: ConnectionProvider;
  /** Required for providers that are not one fixed host (an Atlassian site, a GitLab instance). */
  site?: string | null;
  credential: string;
}
// PATCH /v1/connections/:id — rotate. A token for another account is refused.
export interface UpdateConnectionRequest {
  credential: string;
}

// GET /v1/connections/wait?workspaceId=&since=
export interface ConnectionsWaitResponse {
  /** Pass back as `since`; it moves when the workspace's connections or the caller's OAuth identities change. */
  fingerprint: string;
  changed: boolean;
}

/** Something a connection can reach and a connector can read: a repository, a space, a project, a database, a folder. */
export interface ConnectionResource {
  /** Stable upstream id (a repo's full path, a space key, a database id). */
  id: string;
  label: string;
  description: string | null;
  /** GitHub owner or GitLab group path, for the namespace switcher. */
  namespace: string | null;
  private: boolean;
  /** Repositories only. */
  defaultBranch: string | null;
  /** Newest activity, ISO; the list is sorted by it. */
  updatedAt: string | null;
  url: string | null;
  /** The connector config keys this resource fills in. */
  config: Record<string, string>;
}
// GET /v1/connections/:id/resources?kind=&q=
export interface ConnectionResourcesResponse {
  /** False when this kind has no listing: the link screen shows its typed fields instead. */
  listable: boolean;
  resources: ConnectionResource[];
  /** Upstream's refusal, in its words, when the listing failed. */
  error: string | null;
}
// GET /v1/connections/:id/branches?repo=
export interface ConnectionBranchesResponse {
  branches: Array<{ name: string; isDefault: boolean }>;
  error: string | null;
}

// POST /v1/connections/:id/links — each resource↔project pair becomes its own connector.
export interface CreateConnectionLinksRequest {
  links: Array<{
    kind: ConnectorKind;
    projectId: string;
    /** The resource's own label, for the connector name `<label> · <project>`. */
    label: string;
    /** The resource's `config` plus kind settings (branch, subdir, JQL…). */
    config: Record<string, string>;
  }>;
}
export interface ConnectionLinkResult {
  kind: ConnectorKind;
  projectId: string;
  label: string;
  /** The connector created, or the one that already links this pair. */
  connectorId: string | null;
  status: 'created' | 'exists' | 'failed';
  error: string | null;
}
export interface ConnectionLinksResponse {
  results: ConnectionLinkResult[];
}

// GET /v1/connectors?workspaceId=
export interface ConnectorSummary {
  id: string;
  workspaceId: string;
  kind: ConnectorKind;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  /** Secrets are write-only: the value never leaves the API. */
  hasCredential: boolean;
  credentialHint: string | null;
  /** The connection it dials through (#564); null while it holds only an inline credential. */
  connectionId: string | null;
  /** False when SETTINGS_ENCRYPTION_KEY is unset — the UI must disable credential entry. */
  canStoreSecrets: boolean;
  projectId: string;
  parentId: string | null;
  category: DocumentCategory;
  direction: ConnectorDirection;
  conflict: ConnectorConflictPolicy;
  pushOnPublish: boolean;
  /** Default mode for runs this connector starts. */
  syncMode: ConnectorSyncMode;
  /**
   * Recreate the external tree under `parentId`. Default false, so an existing
   * connector keeps landing pages exactly where it does today — turning it on
   * moves nothing already imported.
   */
  preserveHierarchy: boolean;
  /** null = manual only. */
  syncIntervalMinutes: number | null;
  /** Access mirroring (#76); the details are on `GET /v1/connectors/:id/acl`. */
  aclMode: ConnectorAclMode;
  aclSyncedAt: string | null;
  hasWebhookSecret: boolean;
  /** Absolute path to POST external events at; null when no secret is set. */
  webhookPath: string | null;
  capabilities: ConnectorCapabilities;
  linkCount: number;
  lastRun: ConnectorRunInfo | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ListConnectorsResponse {
  workspaceId: string;
  connectors: ConnectorSummary[];
}
export interface ConnectorResponse {
  connector: ConnectorSummary;
}



// POST /v1/connectors/:id/test
export interface ConnectorTestResponse {
  ok: boolean;
  /** Upstream's own message on failure, or a one-line summary of what was reached. */
  detail: string | null;
  /**
   * OpenAPI / AsyncAPI files found in a repository whose connector names none
   * (#78). Offered in the setup dialog, never imported on their own.
   */
  apiSpecSuggestions?: string[];
}

// ---------------------------------------------------------------------------
// Drift check on pull / merge requests (docs/features/35)
// ---------------------------------------------------------------------------

/**
 * What a repository connector does when a pull or merge request opens or moves.
 *
 * - `off` — nothing. The default, and what an absent key reads as, so every
 *   connector created before this feature behaves exactly as it did.
 * - `report` — check the pages the change touches and say which ones drift:
 *   findings on an agent run, and one comment on the pull request, kept up to
 *   date rather than restacked on every push.
 * - `propose` — `report`, plus a merge request in the knowledge base for every
 *   page the check drafted a fix for.
 *
 * A config field rather than a column: `Connector.config` is free-form, and
 * the catalogue below is what makes the form, the guard and the trigger agree.
 */
export const DRIFT_CHECK_MODES = ['off', 'report', 'propose'] as const;
export type DriftCheckMode = (typeof DRIFT_CHECK_MODES)[number];
export const DRIFT_CHECK_CONFIG_KEY = 'driftCheck';

export function driftCheckMode(config: Record<string, unknown> | null | undefined): DriftCheckMode {
  const value = config?.[DRIFT_CHECK_CONFIG_KEY];
  return (DRIFT_CHECK_MODES as readonly unknown[]).includes(value) ? (value as DriftCheckMode) : 'off';
}

/**
 * Whether a drift check also marks the pages it finds wrong (docs/features/39,
 * issue #66): `requested` when a check reports drift, `outdated` once the pull
 * request merges. On by default — the check already names the page on the
 * pull request, and the flag is the same fact where readers of the page see
 * it. Effective only when `driftCheck` is not `off`. An absent key reads as
 * on, so a connector that opted into the check before this key existed gets
 * the flags; the setup form writes config values as strings, so `'false'`
 * counts as off too.
 */
export const DRIFT_FLAG_PAGES_CONFIG_KEY = 'driftFlagPages';

export function driftFlagPages(config: Record<string, unknown> | null | undefined): boolean {
  const value = config?.[DRIFT_FLAG_PAGES_CONFIG_KEY];
  return value !== false && value !== 'false';
}

// ---------------------------------------------------------------------------
// Repo wiki (docs/features/46)
// ---------------------------------------------------------------------------

/**
 * The sections a `codebase` connector can derive when its wiki is on.
 *
 * `overview` and `modules` are the two unit kinds the connector has always had
 * (`overview`, `module:<path>`); the rest are new units keyed by `wikiUnitKey`.
 * A section is a vocabulary word in `.knowledge/wiki.yml`, and this list is what
 * the parser, the adapter and the settings UI all check against.
 */
export const WIKI_SECTIONS = ['overview', 'architecture', 'modules', 'data-flow', 'api', 'changelog'] as const;
export type WikiSection = (typeof WIKI_SECTIONS)[number];

/** The sections with a unit key of their own — `wiki:<section>`. */
export const WIKI_PAGE_SECTIONS = ['architecture', 'data-flow', 'api'] as const;
export type WikiPageSection = (typeof WIKI_PAGE_SECTIONS)[number];

/**
 * How much a wiki section may spend.
 *
 * - `low` — facts, tables and diagrams. No model call at all.
 * - `medium` — `low` plus one narration per page. What the connector did before
 *   the wiki existed.
 * - `high` — `medium` plus a bounded code-reading loop per section.
 *
 * Ordered: the clamp in `effectiveWikiConfig` compares indexes.
 */
export const WIKI_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
export type WikiEffort = (typeof WIKI_EFFORT_LEVELS)[number];

/** Where the steering file lives, from the repository root — independent of `subdir`. */
export const WIKI_CONFIG_PATH = '.knowledge/wiki.yml';

/** Connector config keys. Absent means inherit, exactly like every other sparse override here. */
export const WIKI_CONFIG_KEY = 'wiki';
export const WIKI_EFFORT_CONFIG_KEY = 'wikiEffort';

/** Hard caps on what a steering file may ask for. A glob list is not a place to put a repository. */
export const WIKI_MAX_GLOBS = 50;
export const WIKI_MAX_GLOB_LENGTH = 200;
export const WIKI_MAX_FLOWS = 12;
/** Flows seeded from entrypoints when the file declares none. */
export const WIKI_DEFAULT_FLOWS = 6;

/**
 * `.knowledge/wiki.yml` as written — every field optional.
 *
 * The parse lives API-side (zod over `js-yaml` `JSON_SCHEMA`); this is the
 * shape it produces, so `effectiveWikiConfig` can be read by the web as well.
 */
export interface WikiSteeringConfig {
  version?: 1;
  effort?: WikiEffort;
  include?: string[];
  exclude?: string[];
  sections?: WikiSection[];
  modules?: { max?: number; titles?: Record<string, string> };
  diagrams?: { architecture?: boolean; class?: boolean; sequence?: boolean; maxNodes?: number };
  flows?: Array<{ name: string; entry: string; symbol?: string }>;
  /** Free text from the repository, handed to the model wrapped as untrusted. */
  focus?: string;
  changelog?: {
    /** Which tags are releases. A glob: `*` is any run of characters. */
    tagPattern?: string;
    breaking?: { conventional?: boolean; labels?: string[]; apiSurface?: boolean };
  };
}

/** One flow the Data flow section draws. `seeded` = derived from an entrypoint, not declared. */
export interface WikiFlow {
  name: string;
  entry: string;
  symbol?: string;
  seeded: boolean;
}

/** What actually applies, after code default ← repo file ← connector override ← env ceiling. */
export interface EffectiveWikiConfig {
  /** The connector's `wiki` key. Off reproduces the pre-wiki overview + module pages. */
  enabled: boolean;
  sections: WikiSection[];
  /** Asked and applied side by side: a silent clamp lies about the configuration. */
  effort: { asked: WikiEffort; applied: WikiEffort; clamped: boolean };
  include: string[];
  exclude: string[];
  modules: { max: number | null; titles: Record<string, string> };
  diagrams: { architecture: boolean; class: boolean; sequence: boolean; maxNodes: number };
  /** Declared flows only. Seeding from entrypoints needs the repo map, so it happens in the adapter. */
  flows: Array<{ name: string; entry: string; symbol?: string }>;
  focus: string | null;
  /** Release notes. On when the connector says so, or the file lists the `changelog` section. */
  changelog: {
    enabled: boolean;
    tagPattern: string;
    breaking: { conventional: boolean; labels: string[]; apiSurface: boolean };
  };
}

export interface WikiCeiling {
  maxEffort: WikiEffort;
  maxDiagramNodes: number;
}

/** The sections a repository gets when it says nothing. */
export const WIKI_DEFAULT_SECTIONS: readonly WikiSection[] = ['overview', 'architecture', 'modules', 'data-flow'];

export function wikiEnabled(config: Record<string, unknown> | null | undefined): boolean {
  const value = config?.[WIKI_CONFIG_KEY];
  return value === 'on' || value === true || value === 'true';
}

function isEffort(value: unknown): value is WikiEffort {
  return (WIKI_EFFORT_LEVELS as readonly unknown[]).includes(value);
}

/**
 * The one predicate for "what does this repository's wiki do".
 *
 * Read by the adapter when it derives pages, by the API when it reports the
 * wiki's state and by the UI when it shows asked vs applied — so the three
 * cannot disagree about which sections exist or how much they may spend.
 *
 * Precedence is code default ← repository file ← connector override, then the
 * env ceiling clamps effort and diagram size. The ceiling never raises
 * anything: a file asking for `low` under a `high` ceiling stays `low`.
 */
export function effectiveWikiConfig(
  connectorConfig: Record<string, unknown> | null | undefined,
  repo: WikiSteeringConfig | null,
  ceiling: WikiCeiling,
): EffectiveWikiConfig {
  const connectorEffort = connectorConfig?.[WIKI_EFFORT_CONFIG_KEY];
  const asked: WikiEffort = isEffort(connectorEffort) ? connectorEffort : (repo?.effort ?? 'medium');
  const applied: WikiEffort =
    WIKI_EFFORT_LEVELS.indexOf(asked) > WIKI_EFFORT_LEVELS.indexOf(ceiling.maxEffort) ? ceiling.maxEffort : asked;

  // `overview` is the hub every other page hangs under; a file that leaves it
  // out still gets one, because without it the tree has no root.
  const listed = repo?.sections ?? WIKI_DEFAULT_SECTIONS;
  const sections = WIKI_SECTIONS.filter((s) => s === 'overview' || listed.includes(s));

  const askedNodes = repo?.diagrams?.maxNodes;
  return {
    enabled: wikiEnabled(connectorConfig),
    sections,
    effort: { asked, applied, clamped: applied !== asked },
    include: repo?.include ?? [],
    exclude: repo?.exclude ?? [],
    modules: { max: repo?.modules?.max ?? null, titles: repo?.modules?.titles ?? {} },
    diagrams: {
      architecture: repo?.diagrams?.architecture ?? true,
      class: repo?.diagrams?.class ?? true,
      sequence: repo?.diagrams?.sequence ?? true,
      maxNodes: askedNodes ? Math.min(askedNodes, ceiling.maxDiagramNodes) : ceiling.maxDiagramNodes,
    },
    flows: repo?.flows ?? [],
    focus: repo?.focus?.trim() || null,
    changelog: {
      enabled:
        connectorConfig?.[CHANGELOG_CONFIG_KEY] === 'on' ||
        (wikiEnabled(connectorConfig) && (repo?.sections ?? []).includes('changelog')),
      tagPattern: repo?.changelog?.tagPattern?.trim() || DEFAULT_TAG_PATTERN,
      breaking: {
        conventional: repo?.changelog?.breaking?.conventional ?? true,
        labels: repo?.changelog?.breaking?.labels ?? [...DEFAULT_BREAKING_LABELS],
        apiSurface: repo?.changelog?.breaking?.apiSurface ?? true,
      },
    },
  };
}

// --- Release notes (docs/features/46) ---

export const CHANGELOG_CONFIG_KEY = 'changelog';
export const DEFAULT_TAG_PATTERN = 'v*';
export const DEFAULT_BREAKING_LABELS = ['breaking', 'breaking-change'] as const;

/** The changelog's unit keys. `changelog:<tag>` is permanent once a tag is published. */
export const CHANGELOG_HUB_KEY = 'changelog';
export const CHANGELOG_UNRELEASED_KEY = 'changelog:unreleased';
export function changelogTagKey(tag: string): string {
  return `changelog:tag:${tag}`;
}
export function changelogTagOf(key: string): string | null {
  return key.startsWith('changelog:tag:') ? key.slice('changelog:tag:'.length) : null;
}

/**
 * How a change was found to be breaking. The first three are facts the code
 * can show; `model` is a suspicion, rendered apart as "Possibly breaking" and
 * never promoted to the confirmed list.
 */
export const BREAKING_CHANGE_SOURCES = ['conventional-commit', 'label', 'api-surface', 'model'] as const;
export type BreakingChangeSource = (typeof BREAKING_CHANGE_SOURCES)[number];

/** The groups a release page lists changes under — our own CHANGELOG.md's, plus Other. */
export const RELEASE_NOTE_GROUPS = ['breaking', 'added', 'changed', 'fixed', 'removed', 'other'] as const;
export type ReleaseNoteGroup = (typeof RELEASE_NOTE_GROUPS)[number];

export interface ConventionalCommit {
  type: string;
  scope: string | null;
  /** `!` after the type/scope, or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer. */
  breaking: boolean;
  /** The footer's text when there is one — what a reader must do. */
  breakingNote: string | null;
  description: string;
}

/**
 * A commit message read as a Conventional Commit, or null when it is not one.
 * Shared by the API (grouping release notes) and the web (labelling them), so
 * the two cannot disagree about what `feat(api)!:` means.
 */
export function parseConventionalCommit(message: string): ConventionalCommit | null {
  const [subject = '', ...rest] = message.replace(/\r\n/g, '\n').split('\n');
  const match = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^()\n]*)\))?(?<bang>!)?: (?<description>.+)$/.exec(subject.trim());
  if (!match?.groups) return null;
  const body = rest.join('\n');
  // A footer runs until the next trailer — `Token: value` or `Token #value` (git's two forms).
  const footer = /^BREAKING[ -]CHANGE: *(.+(?:\n(?![A-Za-z-]+(?:: | #)).+)*)/m.exec(body);
  return {
    type: match.groups.type.toLowerCase(),
    scope: match.groups.scope?.trim() || null,
    breaking: Boolean(match.groups.bang) || Boolean(footer),
    breakingNote: footer ? footer[1].trim() : null,
    description: match.groups.description.trim(),
  };
}

/** One release as the Releases tab lists it. */
export interface ReleaseNoteInfo {
  /** The tag, or null for Unreleased. */
  tag: string | null;
  /** The tag's commit date, when the page has been generated. */
  date: string | null;
  documentId: string | null;
  breakingCount: number;
  suspectedCount: number;
  /** False for a tag older than the backfill cap: listed, never generated. */
  generated: boolean;
}

export interface ListReleasesResponse {
  connectorId: string;
  releases: ReleaseNoteInfo[];
  /** Why the tag list could not be read from the host, when it could not. */
  error: string | null;
}

/** One page of a repo wiki, as the Wiki tab lists it. */
export interface RepoWikiSection {
  /** The unit key — `overview`, `wiki:architecture`, `module:<path>`, `changelog`. */
  key: string;
  section: WikiSection;
  title: string;
  /** Null until the first sync has created the page. */
  documentId: string | null;
  /** The version of the inputs the page was last derived from. */
  version: string | null;
  lastRegeneratedAt: string | null;
  /**
   * Derived, never stored: the last run saw different inputs than the page was
   * derived from — it failed, was skipped, or is waiting for review.
   */
  stale: boolean;
  /** An open merge request carrying a regenerated version of this page. */
  openMergeRequestId: string | null;
}

export interface RepoWikiInfo {
  connectorId: string;
  enabled: boolean;
  changelog: boolean;
  delivery: WikiDelivery;
  autoRegenerate: WikiAutoRegenerate;
  /** Asked beside applied — the Wiki tab shows both when the server clamped. */
  effort: { asked: WikiEffort; applied: WikiEffort; clamped: boolean };
  source: 'repo-file' | 'default';
  /** Why `.knowledge/wiki.yml` was rejected, one line per failure. */
  configErrors: string[];
  /** Set when the steering file could not be read from the host at all. */
  configUnreadable: string | null;
  sections: RepoWikiSection[];
}

export interface RegenerateWikiResponse {
  runId: string;
}

/** Whether a push to the branch starts a run (docs/features/46). Off unless asked for. */
export const WIKI_AUTO_REGENERATE_MODES = ['off', 'on-push'] as const;
export type WikiAutoRegenerate = (typeof WIKI_AUTO_REGENERATE_MODES)[number];
export const WIKI_AUTO_REGENERATE_CONFIG_KEY = 'wikiAutoRegenerate';

export function wikiAutoRegenerate(config: Record<string, unknown> | null | undefined): WikiAutoRegenerate {
  return config?.[WIKI_AUTO_REGENERATE_CONFIG_KEY] === 'on-push' ? 'on-push' : 'off';
}

/**
 * How a regenerated page reaches readers. `direct` writes it, as every sync
 * always has; `merge-request` puts it on a branch and opens a merge request,
 * so a person reviews what the code now says before readers see it.
 */
export const WIKI_DELIVERY_MODES = ['direct', 'merge-request'] as const;
export type WikiDelivery = (typeof WIKI_DELIVERY_MODES)[number];
export const WIKI_DELIVERY_CONFIG_KEY = 'wikiDelivery';

export function wikiDelivery(config: Record<string, unknown> | null | undefined): WikiDelivery {
  return config?.[WIKI_DELIVERY_CONFIG_KEY] === 'merge-request' ? 'merge-request' : 'direct';
}

/**
 * Why a `connector_conflicts` row exists: both sides changed (`conflict`), the
 * repo wiki regenerated a page that is delivered by merge request
 * (`regenerated`), or a synced API spec changed upstream (`spec-changed`, #78),
 * which always arrives by merge request so the breaking-change gate sees it.
 * The sweeper titles the merge request by it.
 */
export const CONNECTOR_CONFLICT_REASONS = ['conflict', 'regenerated', 'spec-changed'] as const;
export type ConnectorConflictReason = (typeof CONNECTOR_CONFLICT_REASONS)[number];

/**
 * The reasons whose merge requests replace each other: each carries the whole
 * page as the connector produced it, so only the newest of a burst is worth
 * reviewing. A `conflict` holds a person's edit too and is never superseded.
 */
export const SUPERSEDING_CONFLICT_REASONS: readonly ConnectorConflictReason[] = ['regenerated', 'spec-changed'];

// ---------------------------------------------------------------------------
// API spec files in a repository (#78, phase 7)
// ---------------------------------------------------------------------------

export const API_SPECS_CONFIG_KEY = 'apiSpecs';
/** More patterns than this is a typo, not a configuration. */
export const MAX_API_SPEC_GLOBS = 20;

/**
 * The connector's spec globs, `[]` when unset — which is every connector that
 * existed before this, so they sync exactly what they did. Config values are
 * strings, so the list is written comma- or newline-separated.
 */
export function apiSpecGlobs(config: Record<string, unknown> | null | undefined): string[] {
  const raw = config?.[API_SPECS_CONFIG_KEY];
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(/[\n,]/u).map((g) => g.trim()).filter(Boolean))].slice(0, MAX_API_SPEC_GLOBS);
}

/** `wiki:architecture` — a section's `connector_links` key, and therefore permanent. */
export function wikiUnitKey(section: WikiPageSection): string {
  return `wiki:${section}`;
}

export function isWikiUnitKey(key: string): boolean {
  return (WIKI_PAGE_SECTIONS as readonly string[]).some((s) => key === `wiki:${s}`);
}

// ---------------------------------------------------------------------------
// GitHub App repository picker (docs/features/30)
// ---------------------------------------------------------------------------

/**
 * The config key that says "this connector authenticates as an installation".
 *
 * Deliberately *not* a `ConnectorConfigField`: the catalogue above drives the
 * settings form, and this is written by the picker rather than typed. Keeping it
 * out of `fields` is what stops the generic input loop from rendering a raw
 * numeric box for it.
 */
export const GITHUB_INSTALLATION_CONFIG_KEY = 'githubInstallationId';

/** One account or organisation the App is installed on. */
export interface GithubInstallationSummary {
  /** GitHub's installation id, as a string — it is a 64-bit integer. */
  installationId: string;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  accountAvatarUrl: string | null;
  /** 'selected' means the owner granted a subset, so a short list is not a bug. */
  repositorySelection: 'all' | 'selected';
  suspended: boolean;
}

export interface GithubRepoSummary {
  /** 'owner/name'. This is the picker's stable identity for a repository. */
  fullName: string;
  name: string;
  ownerLogin: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  htmlUrl: string;
  /** ISO-8601, for "most recently pushed first" ordering in the list. */
  pushedAt: string | null;
  language: string | null;
}

export interface GithubBranchSummary {
  name: string;
  isDefault: boolean;
}

/**
 * The browse envelope, copied from `AiPluginTestResponse`: these endpoints
 * answer "what can I see", and a network hiccup upstream is data for the picker
 * to render, not a 500 for the client to catch. They never throw.
 */
export interface GithubInstallationsResponse {
  /** False when GITHUB_APP_ID is unset — the picker hides and the PAT path stays. */
  configured: boolean;
  /** False until this person has completed the OAuth leg; the UI offers it. */
  connected: boolean;
  /** Where to send the browser to connect a GitHub identity, when `connected` is false. */
  authorizeUrl: string | null;
  /** Where to send the browser to add another account or org. */
  installUrl: string | null;
  installations: GithubInstallationSummary[];
  error?: string;
  /**
   * Env keys a half-configured deployment still needs (#552). Absent when the
   * App is fully set up or deliberately off (every GITHUB_APP_* key empty).
   */
  missing?: string[];
}

export interface GithubReposResponse {
  ok: boolean;
  repositories: GithubRepoSummary[];
  error?: string;
}

export interface GithubBranchesResponse {
  ok: boolean;
  branches: GithubBranchSummary[];
  error?: string;
}

// ---------------------------------------------------------------------------
// GitHub access — granted permissions and re-authorisation (docs/features/36)
// ---------------------------------------------------------------------------

/** GitHub's permission levels, weakest first. */
export type GithubGrantLevel = 'read' | 'write' | 'admin';

/**
 * What in this product a permission or event is for. Each names a feature a
 * person can see, so a missing grant reads as "the drift check will not work"
 * rather than as a GitHub permission name nobody recognises.
 */
export type GithubAccessPurpose =
  | 'sync'
  | 'push'
  | 'work-items'
  | 'drift-check'
  | 'boards'
  | 'repo-events'
  /** The repo wiki regenerating on push (docs/features/46). */
  | 'wiki'
  /** Release notes from tags, commits and merged pull requests (docs/features/46). */
  | 'changelog'
  /** Mirroring a private repository's collaborators and teams as a page restriction (#76). */
  | 'acl';

/**
 * Where one requirement stands.
 *
 * - `granted` — the installation has it.
 * - `pending` — the App asks for it and this installation has not accepted:
 *   the installation's owner approves it on GitHub.
 * - `missing` — the App never asks for it: whoever owns the App registration
 *   adds it there first, and every installation then has to accept.
 * - `extra` — granted, and nothing here uses it.
 */
export type GithubGrantStatus = 'granted' | 'pending' | 'missing' | 'extra';

export interface GithubPermissionRow {
  /** GitHub's own key, e.g. `pull_requests`. */
  name: string;
  granted: GithubGrantLevel | null;
  /** What the App registration asks every installation for. */
  requested: GithubGrantLevel | null;
  /** The level this connector needs, or null when nothing here uses it. */
  needed: GithubGrantLevel | null;
  purposes: GithubAccessPurpose[];
  /** Whether this connector uses any of `purposes` right now — a gap in an unused one is not a problem. */
  active: boolean;
  status: GithubGrantStatus;
}

export interface GithubEventRow {
  /** GitHub's webhook event name, e.g. `pull_request`. */
  name: string;
  subscribed: boolean;
  requested: boolean;
  purposes: GithubAccessPurpose[];
  active: boolean;
  status: GithubGrantStatus;
}

// GET /v1/connectors/:id/github
export interface ConnectorGithubAccessResponse {
  /** False when no GitHub App is registered on this deployment. */
  configured: boolean;
  /** How this connector authenticates to GitHub. Only `app` has grants to list. */
  auth: 'app' | 'token' | 'none';
  installation: {
    installationId: string;
    accountLogin: string;
    accountType: 'User' | 'Organization';
    accountAvatarUrl: string | null;
    repositorySelection: 'all' | 'selected';
    suspended: boolean;
    /** The installation's page on GitHub — where new permissions are accepted. */
    settingsUrl: string | null;
  } | null;
  /** The App registration's settings — where permissions and events are added. */
  appSettingsUrl: string | null;
  permissions: GithubPermissionRow[];
  events: GithubEventRow[];
  /** The viewing person's linked GitHub account, if any. */
  identity: { login: string; avatarUrl: string | null; usable: boolean } | null;
  /** GitHub's authorisation page with the account picker forced, returning here. */
  reconnectUrl: string | null;
  /** Why the grants could not be read, when they could not. */
  error?: string;
}

// GET /v1/connectors/:id/links
export interface ConnectorLinkSummary {
  id: string;
  connectorId: string;
  documentId: string;
  documentTitle: string | null;
  externalId: string;
  externalUrl: string | null;
  externalTitle: string | null;
  externalVersion: string | null;
  lastPulledAt: string | null;
  lastPushedAt: string | null;
  createdAt: string;
}
export interface ListConnectorLinksResponse {
  connectorId: string;
  links: ConnectorLinkSummary[];
  /** Opaque; pass back as `cursor` for the next page. `null` at the end. */
  nextCursor: string | null;
}

/** One thing a run could not carry — never swallowed, always surfaced. */
export interface ConnectorRunWarning {
  externalId: string | null;
  title: string | null;
  message: string;
}

// GET /v1/connectors/runs/:runId — the poll target.
export interface ConnectorRunInfo {
  id: string;
  connectorId: string;
  workspaceId: string;
  direction: ConnectorRunDirection;
  trigger: ConnectorTrigger;
  status: ConnectorRunStatus;
  /** Frozen from the connector when the run was created. */
  mode: ConnectorSyncMode;
  /** Which part of the work this run is in; null before it starts and once it ends. */
  phase: ConnectorRunPhase | null;
  /** Free-text act ("Fetching 48 pages"); null when the client's own phase shows. */
  stage: string | null;
  /** 0..1 when honest; null means indeterminate. */
  progress: number | null;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  conflicts: number;
  /** Items the tree walk has found so far. Grows while `phase` is 'discovering'. */
  discovered: number;
  applied: number;
  reverted: number;
  /** Items staged and waiting on a person. Drives the review badge. */
  awaitingReview: number;
  warnings: ConnectorRunWarning[];
  error: { message: string } | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}
export interface ListConnectorRunsResponse {
  connectorId: string;
  runs: ConnectorRunInfo[];
  /** Opaque; pass back as `cursor` for the next page. `null` at the end. */
  nextCursor: string | null;
}
export interface ConnectorRunResponse {
  run: ConnectorRunInfo;
}


// ---------------------------------------------------------------------------
// Run items (docs/features/26) — one row per external page, which is what makes
// a pull watchable, pausable, reviewable and revertable. The tree lives as rows
// rather than inside the run, for the reason `workflow_run_nodes` does: "every
// item awaiting review in this connector" has to be a query.
// ---------------------------------------------------------------------------

/**
 * discovered → fetching → staged → approved → applying → applied,
 * or unchanged | skipped | rejected | failed | reverted.
 *
 * `unchanged` is not `skipped`: the first means the two sides already agree, the
 * second means a person declined it. Collapsing them would make "what did this
 * run actually leave alone" unanswerable.
 */
export type ConnectorRunItemStatus =
  | 'discovered'
  | 'fetching'
  | 'staged'
  | 'approved'
  | 'applying'
  | 'applied'
  | 'unchanged'
  | 'skipped'
  | 'rejected'
  | 'failed'
  | 'reverted';

/** What applying this item would do to the knowledge base. */
export type ConnectorItemAction = 'create' | 'update' | 'unchanged' | 'conflict';

/**
 * These four are `as const` arrays rather than bare unions because the API's
 * DTOs validate against them at runtime — the `CONNECTOR_KINDS` precedent, so
 * the values the server accepts and the ones the web offers cannot drift.
 */
export const CONNECTOR_SYNC_MODES = ['auto', 'review', 'step'] as const;
export const CONNECTOR_ITEM_EVENTS = ['FETCH', 'APPROVE', 'SKIP', 'REJECT', 'RETRY', 'REVERT'] as const;
export const CONNECTOR_RUN_EVENTS = ['PAUSE', 'RESUME', 'FILL', 'NEXT', 'CANCEL', 'APPROVE_ALL'] as const;
export const CONNECTOR_ITEM_AI_OPS = ['cleanup', 'merge'] as const;

export type ConnectorItemEventType = (typeof CONNECTOR_ITEM_EVENTS)[number];
export type ConnectorRunEventType = (typeof CONNECTOR_RUN_EVENTS)[number];

/** Which AI assist to run over a staged item. Never automatic; always asked for. */
export type ConnectorItemAiOp = (typeof CONNECTOR_ITEM_AI_OPS)[number];

export interface ConnectorRunItemInfo {
  id: string;
  runId: string;
  parentItemId: string | null;
  externalId: string;
  externalUrl: string | null;
  externalVersion: string | null;
  title: string;
  depth: number;
  position: number;
  /** The adapter said this branch continues. False once its children are rows. */
  hasChildren: boolean;
  status: ConnectorRunItemStatus;
  action: ConnectorItemAction | null;
  /** What the conversion could not carry, plus 'orphan' when the walk never reached it. */
  warnings: string[];
  /** Set when a model wrote the staged markdown, so a rewritten page is never mistaken for a sent one. */
  aiOp: ConnectorItemAiOp | null;
  /** True once someone edited the staged markdown by hand. */
  edited: boolean;
  /**
   * Set when the item is an API spec file (#78), not markdown: the review pane
   * shows its text as written, and neither assist may rewrite it.
   */
  specKind: ApiSpecKind | null;
  documentId: string | null;
  error: string | null;
  updatedAt: string;
}

// GET /v1/connectors/runs/:runId/items
export interface ListConnectorRunItemsResponse {
  runId: string;
  /** Flat rows; the client assembles the tree from `parentItemId`. */
  items: ConnectorRunItemInfo[];
  /** True when the walk stopped at CONNECTOR_SYNC_MAX_ITEMS. */
  truncated: boolean;
}

// GET /v1/connectors/runs/:runId/items/:itemId
export interface ConnectorRunItemResponse {
  item: ConnectorRunItemInfo;
  /** The prepared document, as it would be written. */
  markdown: string;
  /** The unedited conversion, when the staged copy has diverged from it. */
  incoming: string | null;
  /** The page's current content, for a 'conflict' or 'update' item. */
  localHead: string | null;
}





export interface ConnectorRunEventResponse {
  run: ConnectorRunInfo;
}
export interface ConnectorItemEventResponse {
  /** Every row the event touched — one, or a whole subtree. */
  items: ConnectorRunItemInfo[];
  run: ConnectorRunInfo;
}

/**
 * Which run events are legal right now.
 *
 * This pair is the `allowedNodeEvents` idea from `@knowledge/workflow` without
 * the machine: the connector's transitions are few enough that a table states
 * them more clearly than a state chart would, and the point of sharing them is
 * the same — the buttons the web offers and the transitions the API accepts are
 * one list, so they cannot drift.
 */
export function allowedRunEvents(
  run: Pick<ConnectorRunInfo, 'status' | 'mode' | 'awaitingReview' | 'phase' | 'discovered'>,
): ConnectorRunEventType[] {
  // Built in the order the controls are read, with `CANCEL` last: it is the one
  // that throws the run away, and it should not sit between two verbs that do
  // not.
  const events: ConnectorRunEventType[] = [];
  if (run.status === 'running' || run.status === 'queued') events.push('PAUSE');
  if (run.status === 'paused') events.push('RESUME');
  // Stop walking and work with what the walk found. Offered only while there is
  // still tree to walk — once fetching has begun, filling is what the run is
  // already doing — and only once it has found something to fill.
  if (
    run.phase === 'discovering' &&
    run.discovered > 0 &&
    (run.status === 'running' || run.status === 'queued' || run.status === 'paused')
  ) {
    events.push('FILL');
  }
  // `NEXT` releases one more item; only a stepping run has one held back.
  if (run.status === 'awaiting-review' && run.mode === 'step') events.push('NEXT');
  // A paused run is a reviewable one too: its approved items are written by a
  // scoped apply pass that leaves the pause and the discovery frontier alone.
  if ((run.status === 'awaiting-review' || run.status === 'paused') && run.awaitingReview > 0) {
    events.push('APPROVE_ALL');
  }
  if (run.status === 'running' || run.status === 'queued' || run.status === 'paused' || run.status === 'awaiting-review') {
    events.push('CANCEL');
  }
  return events;
}

export function allowedItemEvents(item: Pick<ConnectorRunItemInfo, 'status'>): ConnectorItemEventType[] {
  switch (item.status) {
    case 'staged':
      return ['APPROVE', 'SKIP', 'REJECT', 'RETRY'];
    case 'failed':
      return ['RETRY', 'SKIP'];
    case 'applied':
      // Revert is the whole reason the item keeps `previousRevisionId`.
      return ['REVERT'];
    case 'skipped':
    case 'rejected':
    case 'reverted':
      return ['RETRY'];
    case 'unchanged':
      return ['RETRY'];
    case 'discovered':
      // The walk found this page but has not read it. `FETCH` fills this one
      // (or, with `subtree`, this branch) without waiting for the rest of the
      // tree — and `SKIP` drops a page nobody wants without fetching it first.
      return ['FETCH', 'SKIP'];
    default:
      // fetching / approved / applying are the machine's own; a person
      // interrupts the run, not an item mid-flight.
      return [];
  }
}

// POST /v1/documents/:id/push — publish one page to the connector it is linked to.
export interface PushDocumentResponse {
  run: ConnectorRunInfo;
}

/** The connector attachment shown on a page, when one exists. */
export interface DocumentConnectorLink {
  connectorId: string;
  connectorName: string;
  kind: ConnectorKind;
  canPush: boolean;
  link: ConnectorLinkSummary;
}
export interface DocumentConnectorResponse {
  documentId: string;
  links: DocumentConnectorLink[];
}

// ---------------------------------------------------------------------------
// Work items (docs/features/32) — the unit of *work* in an external system, as
// opposed to the unit of *content* a link already maps.
//
// A link says "this page is that wiki page". A work item says "this page is
// what that issue is about", which differs in three ways that matter: a work
// item need not have a page at all, its interesting state is a lifecycle rather
// than a content hash, and it is the thing an inbound event is usually about.
// Folding them into one table would have meant a nullable `document_id` on
// `connector_links`, and the echo-loop suppression that makes pull idempotent
// reads that column on every sync.
// ---------------------------------------------------------------------------

/**
 * What kind of external work item this is.
 *
 * Deliberately no `'board-card'`: a GitHub Projects v2 card is a *view* of an
 * issue or pull request rather than a third kind of thing, so a card is
 * recorded as the item it points at and its board membership is a field.
 */
export const CONNECTOR_WORK_ITEM_KINDS = ['issue', 'pull-request'] as const;
export type ConnectorWorkItemKind = (typeof CONNECTOR_WORK_ITEM_KINDS)[number];

/**
 * The lifecycle, normalised across hosts.
 *
 * `merged` is distinct from `closed` because they say opposite things about the
 * work: a merged pull request finished, a closed one was abandoned. A flow that
 * reacts to "done" must not fire on the second.
 */
export const CONNECTOR_WORK_ITEM_STATES = ['open', 'closed', 'merged', 'draft'] as const;
export type ConnectorWorkItemState = (typeof CONNECTOR_WORK_ITEM_STATES)[number];

export interface ConnectorWorkItemInfo {
  id: string;
  connectorId: string;
  kind: ConnectorWorkItemKind;
  /** The host's own number, as a person would cite it ("#412"). */
  number: number;
  title: string;
  state: ConnectorWorkItemState;
  url: string;
  /** Host login of whoever opened it. Never resolved against our users. */
  authorLogin: string | null;
  assigneeLogins: string[];
  labels: string[];
  /** The page this work item is about, when somebody attached one. */
  documentId: string | null;
  documentTitle: string | null;
  /** Names of the Projects v2 boards carrying this item. */
  boards: string[];
  externalCreatedAt: string | null;
  externalUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** How a person cites it: `BILL-123`, or `#412` for a repository tracker (#424). */
  key: string;
  /** The knowledge object this ticket was handed off for; both null on a plain projection. */
  sourceKind: WorkItemSourceKind | null;
  sourceId: string | null;
  /** Derived through the connector's status map; never stored. */
  status: WorkItemStatus;
  /** The tracker's own name for the status ("In Progress"). */
  externalStatus: string | null;
  syncState: WorkItemSyncState;
  /** The tracker's error from the last failed transition. */
  syncError: string | null;
}

/** GET /v1/work-items — the work items anchored on one object, as the caller may see them. */
export interface ListAnchorWorkItemsResponse {
  workItems: ConnectorWorkItemInfo[];
}

/** GET|PUT /v1/projects/:id/tracker-route — where a knowledge project hands off to. */
export interface TrackerRouteInfo {
  projectId: string;
  connectorId: string;
  /** Jira project key; null on a repository tracker. */
  externalProject: string | null;
  /** Jira issue type; null = Task. */
  issueType: string | null;
  /** The GitHub org board a handed-off issue's card is kept on; null = none. */
  boardUrl: string | null;
  updatedAt: string;
}
export interface TrackerRouteResponse {
  route: TrackerRouteInfo | null;
}
/** GET /v1/connectors/:id/tracker-routes */
export interface ListTrackerRoutesResponse {
  routes: TrackerRouteInfo[];
}
export interface PutTrackerRouteInput {
  connectorId: string;
  externalProject?: string | null;
  issueType?: string | null;
  boardUrl?: string | null;
}

/** GET|PUT /v1/work-items/rules — the workspace's handoff rules and the env ceiling they run under. */
export interface WorkItemRules {
  issues: WorkItemIssueRule | null;
  conflicts: WorkItemConflictRule | null;
  verification: WorkItemVerificationRule | null;
}
export interface WorkItemRulesResponse {
  workspaceId: string;
  /** What the workspace asked for; null is off. */
  requested: WorkItemRules;
  /** WORK_ITEM_AUTOCREATE_MAX_PER_TICK and WORK_ITEM_SYNC_ENABLED: what actually runs. */
  ceiling: { maxPerTick: number; syncEnabled: boolean };
}

/** POST /v1/work-items/handoff — create a ticket for an anchor, or attach an existing one. */
export interface WorkItemHandoffInput {
  workspaceId: string;
  sourceKind: WorkItemSourceKind;
  sourceId: string;
  /** Null = the anchor's project route. */
  connectorId?: string;
  /** `BILL-123`, `#45`, `org/repo#45` or a ticket URL: attach instead of create. */
  attach?: string;
}

// GET /v1/connectors/:id/work-items
export interface ListConnectorWorkItemsResponse {
  workItems: ConnectorWorkItemInfo[];
  /** Every stored work item on the connector, not just this page. */
  total: number;
  /** Opaque; pass back as `cursor` for the next page. `null` at the end. */
  nextCursor: string | null;
}
export interface ConnectorWorkItemResponse {
  workItem: ConnectorWorkItemInfo;
}

/** POST /v1/connectors/:id/work-items — hand a task to the external system. */
export interface CreateConnectorWorkItemInput {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  /** Attach the new issue to this page, so events on it can reach a workflow. */
  documentId?: string;
}

// --- tracker handoff (#424) ----------------------------------------------------
//
// A work item can be the ticket a knowledge object was handed off for: its
// anchor. The tracker (Jira, GitHub, GitLab) is the task list; this side keeps
// the link and moves status both ways.

/**
 * What a work item can be anchored on. Rows only: a JSON finding on an agent
 * run has no id that survives, so it becomes a `knowledge_issues` row first.
 *
 * - `issue`        — `knowledge_issues.id`, a reported problem with a page.
 * - `conflict`     — `knowledge_conflicts.id`, two sources disagreeing.
 * - `verification` — `documents.id` of a page flagged `requested`/`outdated`.
 * - `document`     — `documents.id`, the page itself.
 */
export const WORK_ITEM_SOURCE_KINDS = ['issue', 'conflict', 'verification', 'document'] as const;
export type WorkItemSourceKind = (typeof WORK_ITEM_SOURCE_KINDS)[number];

/**
 * The status vocabulary every tracker is read and written through. Derived at
 * read time from the stored raw status by `workItemStatusFor`, never stored:
 * changing a connector's status map re-labels every row at once.
 */
export const WORK_ITEM_STATUSES = ['open', 'in_progress', 'done', 'wont_do'] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/** Whether this side owes the tracker a transition. */
export const WORK_ITEM_SYNC_STATES = ['synced', 'pending', 'failed', 'orphaned'] as const;
export type WorkItemSyncState = (typeof WORK_ITEM_SYNC_STATES)[number];

/** Outbound attempts before a pending transition becomes `failed` and waits for a person. */
export const WORK_ITEM_SYNC_MAX_ATTEMPTS = 5;

/** The trackers a `TrackerAdapter` exists for. A repo connector's host picks github or gitlab. */
export const TRACKER_KINDS = ['github', 'gitlab', 'jira'] as const;
export type TrackerKind = (typeof TRACKER_KINDS)[number];

/**
 * How one connector's raw statuses map onto `WorkItemStatus`, kept on
 * `connectors.config.statusMap` as a sparse override of the tracker's default.
 *
 * - `inbound` — raw tracker status → ours. Keys compare case-insensitively,
 *   because Jira status names are typed by people.
 * - `outbound` — ours → the raw status a transition should reach. A status
 *   with no entry cannot be pushed; the sweeper logs it rather than guess.
 */
export interface WorkItemStatusMap {
  inbound: Record<string, WorkItemStatus>;
  outbound: Partial<Record<WorkItemStatus, string>>;
}

/**
 * Each tracker's code default. GitHub's raw status is the issue state with its
 * close reason (`completed` / `not_planned`) folded in; GitLab only has
 * `opened` / `closed`; Jira's are the names of a stock Jira Software workflow.
 */
export const DEFAULT_WORK_ITEM_STATUS_MAPS: Readonly<Record<TrackerKind, WorkItemStatusMap>> = {
  github: {
    inbound: { open: 'open', completed: 'done', not_planned: 'wont_do', merged: 'done', draft: 'in_progress' },
    outbound: { open: 'open', done: 'completed', wont_do: 'not_planned' },
  },
  gitlab: {
    inbound: { opened: 'open', closed: 'done' },
    outbound: { open: 'opened', done: 'closed', wont_do: 'closed' },
  },
  jira: {
    inbound: { 'to do': 'open', 'in progress': 'in_progress', done: 'done', "won't do": 'wont_do' },
    outbound: { open: 'To Do', in_progress: 'In Progress', done: 'Done', wont_do: "Won't Do" },
  },
};

/**
 * Which tracker a connector row is, from its kind and repository URL — the
 * same rule the API's tracker registry applies, for readers that cannot reach
 * it. Null for a kind or host with no tracker.
 */
export function trackerKindOf(connector: { kind: string; config: unknown }): TrackerKind | null {
  if (connector.kind === 'jira') return 'jira';
  if (connector.kind !== 'markdown-git' && connector.kind !== 'codebase') return null;
  const url = (connector.config as { repoUrl?: unknown } | null)?.repoUrl;
  if (typeof url !== 'string') return null;
  try {
    const host = new URL(url).hostname;
    return host === 'github.com' ? 'github' : host.includes('gitlab') ? 'gitlab' : null;
  } catch {
    return null;
  }
}

/** A connector's effective map: its sparse override layered over the tracker default. */
export function workItemStatusMap(kind: TrackerKind, override?: Partial<WorkItemStatusMap> | null): WorkItemStatusMap {
  const base = DEFAULT_WORK_ITEM_STATUS_MAPS[kind];
  const inbound: Record<string, WorkItemStatus> = { ...base.inbound };
  for (const [raw, status] of Object.entries(override?.inbound ?? {})) {
    if ((WORK_ITEM_STATUSES as readonly string[]).includes(status)) inbound[raw.toLowerCase()] = status;
  }
  return { inbound, outbound: { ...base.outbound, ...(override?.outbound ?? {}) } };
}

/**
 * The derived status of one stored work item. The raw status wins when the map
 * knows it; otherwise the coarse `state` answers, so a row written before #424
 * (no raw status) still reads the way it always did.
 */
export function workItemStatusFor(
  row: { state: string; externalStatus: string | null },
  map: WorkItemStatusMap,
): WorkItemStatus {
  const mapped = row.externalStatus ? map.inbound[row.externalStatus.toLowerCase()] : undefined;
  if (mapped) return mapped;
  if (row.state === 'closed' || row.state === 'merged') return 'done';
  if (row.state === 'draft') return 'in_progress';
  return 'open';
}

/** The coarse state a derived status projects to — what SQL filters on. */
export function workItemStateFor(status: WorkItemStatus): ConnectorWorkItemState {
  return status === 'done' || status === 'wont_do' ? 'closed' : 'open';
}

/**
 * Handoff rules on `workspace_settings` (#424). Null on the row is `off`, so an
 * empty table creates no ticket. `high` / `medium` rank a reported issue by how
 * many people reported it (`issueRankFor`): an issue has no severity of its own.
 */
export const WORK_ITEM_ISSUE_RULES = ['off', 'high', 'medium', 'all'] as const;
export type WorkItemIssueRule = (typeof WORK_ITEM_ISSUE_RULES)[number];
export const WORK_ITEM_CONFLICT_RULES = ['off', 'on'] as const;
export type WorkItemConflictRule = (typeof WORK_ITEM_CONFLICT_RULES)[number];
export const WORK_ITEM_VERIFICATION_RULES = ['off', 'outdated', 'all'] as const;
export type WorkItemVerificationRule = (typeof WORK_ITEM_VERIFICATION_RULES)[number];

/**
 * A reported issue's rank for the `work_item_issues` rule: `wrong` or three
 * reports is high, `stale`/`missing` or two reports is medium, anything else low.
 */
export function issueRankFor(issue: { kind: string; reportCount: number }): 'high' | 'medium' | 'low' {
  if (issue.kind === 'wrong' || issue.reportCount >= 3) return 'high';
  if (issue.kind === 'stale' || issue.kind === 'missing' || issue.reportCount >= 2) return 'medium';
  return 'low';
}

/** Whether a rule admits an issue of this rank. */
export function issueRuleAdmits(rule: WorkItemIssueRule | null, rank: 'high' | 'medium' | 'low'): boolean {
  if (!rule || rule === 'off') return false;
  if (rule === 'all') return true;
  return rule === 'medium' ? rank !== 'low' : rank === 'high';
}

/** The footer every handed-off ticket carries, which an inbound event is reconciled from. */
export function workItemRefFooter(kind: WorkItemSourceKind, id: string): string {
  return `knowledge-ref: ${kind}:${id}`;
}

/** Read a footer back out of a ticket body; null when absent or malformed. */
export function parseWorkItemRef(body: string | null | undefined): { kind: WorkItemSourceKind; id: string } | null {
  const m = /knowledge-ref:\s*(issue|conflict|verification|document):([0-9a-f-]{36})/i.exec(body ?? '');
  return m ? { kind: m[1].toLowerCase() as WorkItemSourceKind, id: m[2].toLowerCase() } : null;
}

// --- component pages (#236) -----------------------------------------------------

/**
 * Why a page's `component:` block resolved to no code connector. Each one
 * means the page gets no usage index and no derived edges, and the page says
 * so — a declaration that silently matches nothing is the failure this exists
 * to prevent.
 *
 * - `no-connector`         — the workspace has no codebase connector.
 * - `ambiguous-repository` — no `repository` and several connectors, or a
 *                            `repository` several connectors match.
 * - `unknown-repository`   — `repository` matches no connector.
 * - `no-paths`             — the block declares no usable path.
 */
export const COMPONENT_DECLARATION_WARNINGS = [
  'no-connector',
  'ambiguous-repository',
  'unknown-repository',
  'no-paths',
] as const;
export type ComponentDeclarationWarning = (typeof COMPONENT_DECLARATION_WARNINGS)[number];

/** GET /v1/documents/:id/component — the page's declaration as the server resolved it. */
export interface ComponentDeclarationView {
  documentId: string;
  /** `component:<name>`: the entity usage pages `DEPENDS_ON`. */
  componentKey: string;
  /** As the page wrote it; null when it named none. */
  repository: string | null;
  connector: { id: string; name: string } | null;
  paths: string[];
  symbols: string[];
  /** The declared paths no file answers to at the connector's indexed head, as of its last pull. */
  missingPaths: string[];
  warning: ComponentDeclarationWarning | null;
  /** The revision the declaration was read from. */
  revisionId: string;
}

/** A page a usage answer names: only ever one the caller may open. */
export interface CodeUsagePage {
  id: string;
  title: string;
}

/** One file that uses a component, and the pages that document that file. */
export interface CodeUsageSite {
  /** The importing file. */
  path: string;
  /** The component's files it imports, and the names it takes from each (`default`, `*`, or none for a side-effect import). */
  imports: Array<{ path: string; names: string[] }>;
  /** Component pages covering `path`, else the wiki module page containing it. */
  pages: CodeUsagePage[];
  /** Pages documenting `path` that the caller may not open: counted, never titled. */
  hiddenPages: number;
}

/**
 * GET /v1/documents/:id/component/usages, GET /v1/code-usages and the
 * `knowledge_code_usages` tool (#236, phase 3): where a component's code is
 * used at the connector's indexed head, computed on read.
 */
export interface CodeUsagesResponse {
  connector: { id: string; name: string } | null;
  /** The head the usage index was built from; null when the connector has none yet. */
  headSha: string | null;
  /** The files or globs asked about. */
  paths: string[];
  /** The names a use must import; empty means any import counts. */
  symbols: string[];
  /** Component pages whose declared paths cover what was asked about, the asking page excluded. */
  components: CodeUsagePage[];
  hiddenComponents: number;
  /** Usage sites, in path order. */
  usages: CodeUsageSite[];
  /** Usage sites past the limit, counted and not listed. */
  truncated: number;
  /** Why the answer is empty when the declaration resolved to no connector. */
  warning: ComponentDeclarationWarning | null;
}

/** Files one "Document this component" request may cover (#236, phase 5). */
export const COMPONENT_DRAFT_MAX_PATHS = 10;

/**
 * POST /v1/components/drafts — draft a component page from code (#236,
 * phase 5). The archaeologist reads the files in the worker and fills the
 * `component` template; the API then opens the page as a merge request, as the
 * person who asked. Nothing is published until that merge request merges.
 */
export interface DraftComponentRequest {
  workspaceId: string;
  /** Repo-relative files — never globs: a draft is written from files it can read. */
  paths: string[];
  /** The codebase connector; optional when the workspace has exactly one. */
  connectorId?: string;
  /** Narrows the page's `component.symbols`. */
  symbols?: string[];
  /** The component's name and the page's title; derived from the first path when absent. */
  name?: string;
  /** Where the page goes once merged; the connector's destination when absent. */
  projectId?: string;
  parentId?: string;
}

export interface DraftComponentResponse {
  /** The archaeologist run drafting the page. Its finding carries `mergeRequestId` once the merge request is open. */
  runId: string;
  connectorId: string;
  /** The page's title, and the merge request's. */
  title: string;
  paths: string[];
}

// ---------------------------------------------------------------------------
// Source-backed pages (#674): a read-only page whose body belongs to a `web`
// source and is replaced by each new version of it.
// ---------------------------------------------------------------------------

/** The check intervals the page source panel offers, in minutes. */
export const SOURCE_INTERVALS_MIN = [15, 60, 360, 1440] as const;
export const SOURCE_DEFAULT_INTERVAL_MIN = 60;
/** Consecutive failed syncs before an alert, and consecutive 404/410s before the page is archived. */
export const SOURCE_FAILURE_LIMIT = 3;
/** Minutes before each retry of a transient failure (timeout, 5xx, 429, DNS); `Retry-After` can only lengthen one. */
export const SOURCE_RETRY_DELAYS_MIN = [1, 5, 25] as const;

/**
 * Why a source alerts its connector's owner (an in-app row plus email, reason
 * `alert`). Later phases add `held` (recipe review) and `breaking` (OpenAPI).
 */
export const SOURCE_ALERT_KINDS = ['paused', 'gone', 'failing'] as const;
export type SourceAlertKind = (typeof SOURCE_ALERT_KINDS)[number];

// GET /v1/documents/:id/source
export interface DocumentSourceInfo {
  documentId: string;
  connectorId: string;
  url: string;
  host: string;
  intervalMinutes: number | null;
  /** Set while the source writes nothing (paused by hand or by a restore). */
  pausedAt: string | null;
  /** New versions the source has published since the page was paused. */
  aheadCount: number;
  /** The last successful check, changed or not. */
  lastCheckedAt: string | null;
  /** The revision the source last wrote, and the page's head now (they differ after a restore). */
  syncedRevisionId: string | null;
  headRevisionId: string | null;
  /** Consecutive failed syncs. */
  failures: number;
  /** When the next retry of a transient failure runs, if one is pending. */
  retryAt: string | null;
  webhookConfigured: boolean;
}

// POST /v1/sources
export interface CreateSourcePageRequest {
  workspaceId: string;
  projectId: string;
  parentId?: string | null;
  url: string;
  title?: string;
  intervalMinutes?: number | null;
  /** For a host that needs one: a token (sent as Bearer) or `Header-Name: value`. Saved as a connection for the host. */
  credential?: string;
}

export interface CreateSourcePageResponse {
  documentId: string;
  connectorId: string;
}

// PATCH /v1/documents/:id/source
export interface UpdateDocumentSourceRequest {
  intervalMinutes: number | null;
}

// POST /v1/documents/:id/source/restore
export interface RestoreDocumentSourceRequest {
  /** An earlier revision of this page; restoring it pauses the source. */
  revisionId: string;
}

// POST /v1/documents/:id/source/webhook — shown once.
export interface DocumentSourceWebhookResponse {
  url: string;
  secret: string;
  /** The header the sender signs the raw body with: `sha256=<hex HMAC-SHA256>`. */
  header: string;
}
