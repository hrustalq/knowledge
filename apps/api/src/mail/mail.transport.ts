import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../config/env.js';
import type { RenderedMail } from './mail.templates.js';

/**
 * MAIL_SMTP_URL supplies host, port and TLS; MAIL_SMTP_USER / MAIL_SMTP_PASS,
 * when set, become `auth` as-is (no URL-encoding). validateEnv refuses a URL
 * that also carries credentials, so there is only ever one source.
 */
export function smtpOptions(config: ConfigService<Env, true>) {
  const url = config.get('MAIL_SMTP_URL', { infer: true });
  const user = config.get('MAIL_SMTP_USER', { infer: true });
  return user ? { url, auth: { user, pass: config.get('MAIL_SMTP_PASS', { infer: true }) } } : { url };
}

/**
 * The one place a message leaves the process (docs/features/41).
 *
 * `log` is the default and sends nothing: dev, CI and `make api-schema` never
 * open a socket, and a message — links included — lands in the worker log,
 * which is what an operator did by hand before there was a mailer. `smtp`
 * speaks to whatever MAIL_SMTP_URL names; provider-specific HTTP APIs were
 * passed over because every provider also speaks SMTP, so switching providers
 * is an env change rather than a code change.
 */
@Injectable()
export class MailTransport {
  private readonly logger = new Logger(MailTransport.name);
  private readonly mode: Env['MAIL_TRANSPORT'];
  private readonly from: string;
  private readonly smtp: Transporter | null;

  constructor(config: ConfigService<Env, true>) {
    this.mode = config.get('MAIL_TRANSPORT', { infer: true });
    this.from = config.get('MAIL_FROM', { infer: true });
    this.smtp = this.mode === 'smtp' ? createTransport(smtpOptions(config)) : null;
  }

  get transport(): Env['MAIL_TRANSPORT'] {
    return this.mode;
  }

  async send(to: string, mail: RenderedMail): Promise<void> {
    if (!this.smtp) {
      this.logger.log(`[mail:log] to=${to} subject="${mail.subject}"\n${mail.text}`);
      return;
    }
    const info = await this.smtp.sendMail({ from: this.from, to, subject: mail.subject, text: mail.text, html: mail.html });
    this.logger.log(`Mail sent to ${to} ("${mail.subject}") id=${info.messageId}`);
  }

  /**
   * Connect and authenticate without sending. Run once at worker boot and by
   * `make mail-test`: on a network that cuts connections by server name, a
   * blocked relay otherwise shows up only as mail that never arrives.
   */
  async verify(): Promise<{ ok: boolean; error?: string }> {
    if (!this.smtp) return { ok: true };
    try {
      await this.smtp.verify();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  close(): void {
    this.smtp?.close();
  }
}
