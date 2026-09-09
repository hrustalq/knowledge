---
title: REST API
section: Reference
summary: Every endpoint, what it needs to call it, and the one error envelope they all share.
widget: api-reference
---

# REST API

Base path `/v1`. Interactive Swagger runs at **`http://localhost:3000/docs`**, and the
generated OpenAPI document lives at `apps/api/openapi.json`.

## Authenticating

```
Authorization: Bearer ks_…    # a session token, from POST /v1/auth/login
Authorization: Bearer kn_…    # an API key, from `make auth-bootstrap`
```

With `AUTH_MODE=none` no header is required and every request is a full-access dev
principal. `GET /v1/events` also accepts `?token=`, because `EventSource` cannot set
headers.

## Errors

Every non-2xx response is the same envelope:

```jsonc
{
  "statusCode": 409,
  "code": "REVISION_CONFLICT", // ← branch on this, never on the message
  "message": "The branch head has advanced",
  "details": { "comparisonUrl": "/v1/documents/…/compare?from=…&to=…" },
  "path": "/v1/documents/abc/revisions",
  "timestamp": "2026-09-09T12:00:00.000Z",
  "requestId": "…", // echoes x-request-id
}
```

`code` is a stable identifier. `details` carries whatever the specific failure needs — a
comparison link on a conflict, a merge gate's reason, a validation breakdown. The
`requestId` is echoed from your header when you send one, which is what makes a report
traceable.

The typed client the web app uses maps transport failures onto the same shape
(`statusCode: 0` with `NETWORK_ERROR`, `TIMEOUT`, `ABORTED`, `UNKNOWN`), so `code` is the
only thing any caller has to branch on.

## Access column

The table below is generated from the route definitions, so it cannot drift:

- **`viewer` / `editor` / `admin`** — the workspace role required. The value in
  parentheses is where the target workspace is resolved from: `body`, `query`, or the
  entity named by the `:id` parameter.
- **`public`** — no authentication (login, signup, connector webhooks).
- **`platform admin`** — account management, above workspace ACLs.
- **`authenticated`** — a valid token, but **no workspace check**. Correct for `/v1/me`
  and for creating a workspace you are not yet in; anywhere else it would be a gap.

## Conventions

- **Pagination** is cursor-based: pass `limit`, follow the returned cursor.
- **Concurrency**: `If-Match: <revision-id>` on revision creation returns 409 with a
  comparison link if the branch head moved.
- **Idempotence**: finalize dedupes by content hash per branch, so replaying it is safe.
- **Uploads** never pass through the API — request a presigned URL and PUT the bytes at
  storage directly.

## The endpoints
