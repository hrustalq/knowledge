# 41 — Mail

Issue [#132](https://github.com/hrustalq/knowledge/issues/132). Outbound email
for the auth flows and for the notifications addressed at a person by name.

Before this, the platform could not send mail. A password reset wrote its link
to the API log and the operator passed it on, signup never checked the
address, and an admin-created account with no password could only be claimed
through that same logged link. Notifications reached nobody who wasn't
looking at the app.

## What is sent

| Mail                      | When                                                           | Link                                     |
| ------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| Confirm your email        | signup; `POST /v1/auth/resend-verification`                    | `/verify-email?token=kv_…`               |
| Reset your password       | `POST /v1/auth/forgot-password`                                | `/reset-password?token=kr_…`             |
| You have been invited     | an admin creates a user with no password                       | `/reset-password?token=kr_…&invite=1`    |
| Your password was changed | reset, change-password, an admin's password override           | `/forgot-password` ("if this wasn't you") |
| Mentioned / review / assigned | a notification row with reason `mention`, `review-requested` or `assigned` | the page or merge request        |

Every message is rendered in the recipient's `users.locale` (en, ru) from
`src/i18n/{en,ru}/mail.json`, as text and HTML from one source
(`mail/mail.templates.ts`). Signup now stores the request's language in
`users.locale`, and an admin-created account takes the admin's, so the first
mail can be read.

## Shape

```
API (auth flow, users, announce)          worker
  MailProducer.enqueue ──► BullMQ "mail" ──► MailProcessor ──► MailTransport ──► log | SMTP
```

- **The API enqueues, the worker sends.** `MailQueueModule` (producer) is
  imported by `AuthModule`, `UsersModule` and `EventsModule`;
  `MailWorkerModule` (processor + transport) only by `worker.module.ts`. One
  process holds an SMTP connection.
- **Queued, never inline.** Besides retries (5 attempts, exponential backoff),
  this keeps SMTP latency out of the request, so `forgot-password` takes the same
  time whether the account exists or not.
- **The enqueue never throws** into its caller (the `ActivityService.record`
  contract). A signup does not fail because Redis blinked; the person can ask for
  the link again.
- **The recipient is resolved at send time.** A job carries a `userId` (or a
  `notificationId`), never an address. The processor reads the address, the
  language and whether the account is still enabled when the message leaves.
  Tokens do travel in the job, because only their hash is stored. Failed jobs
  are dropped after a day so tokens don't sit in Redis.

### Transport

`MAIL_TRANSPORT=log` (default) writes each message, links included, to the
worker log and opens no socket. Dev, CI and `make api-schema` behave as before,
and an operator with no relay still has the link: it is in the worker log now
instead of the API log.

`MAIL_TRANSPORT=smtp` sends through `MAIL_SMTP_URL` with nodemailer (`smtps://`
implicit TLS on 465, `smtp://` + STARTTLS on 587). Credentials go either in
the URL's userinfo, URL-encoded, or in `MAIL_SMTP_USER` / `MAIL_SMTP_PASS`
verbatim beside a credential-free URL (`smtps://smtp.timeweb.ru:465`), which
lets the URL stay a plain variable in the GitHub `production` environment.
Both at once refuses to boot: nodemailer would silently prefer the URL's.
SMTP rather than a vendor API because every provider speaks it, so changing
provider is an env change. The worker checks the relay at boot (connect +
auth, nothing sent) and logs the result without failing. On a network that
cuts connections by server name, as the production Mac mini's does, a blocked
relay otherwise shows up only as mail that never arrives.

`make mail-test to=<email>` (or `node dist/scripts/send-test-mail.main.js --to`
inside the api container) sends one message **synchronously** and prints the
SMTP error if any. A queued test would only prove Redis.

Locally, `make infra-up-mailpit` starts Mailpit on loopback: point
`MAIL_SMTP_URL` at `smtp://localhost:1025` and read mail at
`http://localhost:8025`.

## Email verification

- `users.email_verified_at` is null until the address is proven. **Any**
  followed link proves it: a `kv_` verify link, a reset or an invite.
- `email_verification_tokens` stores the SHA-256 and the **address the link was
  sent to**. A token verifies only while that is still the account's address,
  so a link minted before an address change cannot verify the new one.
- Redemption is one guarded `updateMany` on `used_at`. A double click spends the
  token once, and the second click succeeds quietly because the account is
  already verified.
- Resend refuses (429) within 60 s of the last link.
- The migration backfills `created_at` into every existing account: they were
  trusted as they were, and leaving them null would have put a banner on
  everyone. Under strict mode it would have locked them all out.

### Strict mode

`AUTH_REQUIRE_VERIFIED_EMAIL=true` makes `AuthGuard` refuse an unverified
**session** with `403` and `details.reason: 'emailUnverified'`, except on
`@UnverifiedOk` routes: `GET/PATCH /v1/me`, `POST /v1/auth/logout` and
`POST /v1/auth/resend-verification` (`verify-email` is `@Public`). The live
WebSocket applies the same `TokenAuthService.blocksUnverified` predicate and
closes with 4403. API keys are minted by an admin and are never refused for
this.

The web holds a gated account on `/verify-email` (router guard on
`auth.verificationPending`) and opens no SSE or socket. Without strict mode, an
unverified account works normally and sees a dismissable banner with a Resend
button.

## Invites

`POST /v1/users` without a password mints a `kr_` token with
`password_reset_tokens.purpose = 'invite'` and `AUTH_INVITE_TTL_HOURS` (72),
and mails it. It is redeemed by the ordinary `POST /v1/auth/reset-password`, so
there is no second redemption path to keep correct. `purpose` only changes the
mail, the TTL, the page heading (`?invite=1`) and whether a "password changed"
notice follows (it doesn't: there was no previous password).

## Notification mail

`EventsPublisher.announce` is where both notification doors (docs/features/22)
already hand over their deliveries, so it is where they reach the mailer too.
Only the directed reasons are queued (`MAILED_REASONS`). A watch is a
subscription to news, and news belongs in the inbox; being named is the
interruption. Every other `notify` call site uses `owner` or `author` and is
not mailed.

**One email per inbox row.** The processor claims `notifications.emailed_at`
with one guarded `updateMany({ where: { id, emailedAt: null } })` before
sending, and releases it if the send throws, so the BullMQ retry can claim it
again. That gives at most one email per row, and at least one while retries
last. A row that coalesces later (five more replies to a thread that named you)
is already claimed and sends nothing more. Once it is read, the next event opens
a fresh row, which can mail again. The job id `notification-<id>` collapses a
double `announce` while the first job is still queued. The migration stamps
every pre-existing row as mailed, so history is never sent.

Skipped, decided at send time:

- `MAIL_NOTIFICATIONS_ENABLED=false` (operator switch; auth mail unaffected);
- the row was already read in the app;
- the recipient is disabled or their address is unverified;
- `notification_preferences.email_directed` is false (toggle under
  `/settings/notifications`, default on, sparse like the rest of that row);
- a muted category: already dropped by `deliver()` before a row exists.

The link mirrors the directed branches of the web's `notificationLink`: the
merge request on the thread that named you, else the page, else the inbox.

## Not here

- Digests for watch-driven notifications (page edits, workflow results).
- Changing the email address, magic-link login, new-sign-in alerts.
- Bounce and complaint handling; inbound mail.
- Picking a provider and SPF/DKIM for the `MAIL_FROM` domain. That is operator
  work, listed in the changelog's Operations section.
