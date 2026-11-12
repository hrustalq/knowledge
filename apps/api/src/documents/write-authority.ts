import type { Principal } from '../auth/principal.js';

/**
 * Why a write that is not a person's own edit may land on a published page's
 * default branch whatever the publish mode (#958): a merge is the review
 * path itself, a connector writes its own synced page, and a proposal writes
 * a branch a merge request then carries.
 */
export type InternalWrite = 'merge' | 'connector-sync' | 'proposal';

/**
 * Who vouches for a new revision (#958). Required by every revision writer,
 * so a new caller cannot reach a default branch by leaving it out:
 * `{ person }` is a person's direct edit and is held to the workspace's
 * publish mode (`undefined` is the principal-less stdio MCP server, trusted as
 * the dev principal is); `internalWrite(reason)` is the greppable exemption,
 * as `systemScope` is for reads.
 */
export type WriteAuthority = { person: Principal | undefined } | { internal: InternalWrite };

export const internalWrite = (reason: InternalWrite): WriteAuthority => ({ internal: reason });
