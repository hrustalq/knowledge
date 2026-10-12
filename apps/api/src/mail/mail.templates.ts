import type { Locale } from '@knowledge/contracts';
import { t } from '../i18n/t.js';

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

/**
 * What a message says, independent of how it is laid out. Every string is
 * already translated; `action` is the one link the message exists to deliver.
 */
interface MailContent {
  subject: string;
  greeting: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  /** Small print: why this arrived, what to do if it was not you. */
  footer: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Text and HTML from one source, so the two parts of a multipart message can
 * never say different things. The HTML is deliberately plain — inline styles,
 * one table-free column, no images — because mail clients strip everything
 * else, and a remote image is a read receipt nobody agreed to.
 */
function layout(c: MailContent): RenderedMail {
  const text = [
    c.greeting,
    '',
    ...c.paragraphs.flatMap((p) => [p, '']),
    ...(c.action ? [`${c.action.label}: ${c.action.url}`, ''] : []),
    '—',
    c.footer,
  ].join('\n');

  const p = (s: string) => `<p style="margin:0 0 16px">${escapeHtml(s)}</p>`;
  const button = c.action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(c.action.url)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(c.action.label)}</a></p>` +
      `<p style="margin:0 0 16px;font-size:13px;color:#6b7280;word-break:break-all">${escapeHtml(c.action.url)}</p>`
    : '';
  const html =
    `<!doctype html><html><body style="margin:0;padding:24px;background:#f9fafb">` +
    `<div style="max-width:560px;margin:0 auto;padding:32px;background:#ffffff;border-radius:8px;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827">` +
    p(c.greeting) +
    c.paragraphs.map(p).join('') +
    button +
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">` +
    `<p style="margin:0;font-size:13px;color:#6b7280">${escapeHtml(c.footer)}</p>` +
    `</div></body></html>`;

  return { subject: c.subject, text, html };
}

export interface Recipient {
  displayName: string;
  locale: Locale;
}

export function verifyEmailMail(to: Recipient, url: string, hours: number): RenderedMail {
  const l = to.locale;
  return layout({
    subject: t('mail.verifyEmail.subject', undefined, l),
    greeting: t('mail.greeting', { name: to.displayName }, l),
    paragraphs: [t('mail.verifyEmail.body', { hours }, l)],
    action: { label: t('mail.verifyEmail.action', undefined, l), url },
    footer: t('mail.verifyEmail.footer', undefined, l),
  });
}

export function passwordResetMail(to: Recipient, url: string, minutes: number): RenderedMail {
  const l = to.locale;
  return layout({
    subject: t('mail.passwordReset.subject', undefined, l),
    greeting: t('mail.greeting', { name: to.displayName }, l),
    paragraphs: [t('mail.passwordReset.body', { minutes }, l)],
    action: { label: t('mail.passwordReset.action', undefined, l), url },
    footer: t('mail.passwordReset.footer', undefined, l),
  });
}

export function inviteMail(to: Recipient, url: string, hours: number, inviter: string | null): RenderedMail {
  const l = to.locale;
  return layout({
    subject: t('mail.invite.subject', undefined, l),
    greeting: t('mail.greeting', { name: to.displayName }, l),
    paragraphs: [
      inviter ? t('mail.invite.bodyBy', { inviter }, l) : t('mail.invite.body', undefined, l),
      t('mail.invite.expiry', { hours }, l),
    ],
    action: { label: t('mail.invite.action', undefined, l), url },
    footer: t('mail.invite.footer', undefined, l),
  });
}

export function passwordChangedMail(to: Recipient, resetUrl: string): RenderedMail {
  const l = to.locale;
  return layout({
    subject: t('mail.passwordChanged.subject', undefined, l),
    greeting: t('mail.greeting', { name: to.displayName }, l),
    paragraphs: [t('mail.passwordChanged.body', undefined, l), t('mail.passwordChanged.notYou', undefined, l)],
    action: { label: t('mail.passwordChanged.action', undefined, l), url: resetUrl },
    footer: t('mail.passwordChanged.footer', undefined, l),
  });
}

/** `mention` | `review-requested` | `assigned` → the catalogue's camelCase key. */
const REASON_KEY: Record<string, string> = {
  mention: 'mention',
  'review-requested': 'reviewRequested',
  assigned: 'assigned',
};

export function notificationMail(
  to: Recipient,
  input: { reason: string; actor: string; title: string; url: string; settingsUrl: string },
): RenderedMail {
  const l = to.locale;
  const key = REASON_KEY[input.reason] ?? 'mention';
  const args = { actor: input.actor, title: input.title };
  return layout({
    subject: t(`mail.notification.${key}.subject`, args, l),
    greeting: t('mail.greeting', { name: to.displayName }, l),
    paragraphs: [t(`mail.notification.${key}.body`, args, l)],
    action: { label: t('mail.notification.action', undefined, l), url: input.url },
    footer: t('mail.notification.footer', { url: input.settingsUrl }, l),
  });
}
