/**
 * Send one message through the configured transport, synchronously, and say
 * what happened (docs/features/41). The quickest proof that the box running
 * the worker can reach the SMTP relay — run it where the worker runs:
 *
 *   make mail-test to=you@example.com
 *   docker compose exec api node dist/scripts/send-test-mail.main.js --to you@example.com
 *
 * Deliberately not queued: a queued test reports "enqueued", which proves Redis.
 */
import { validateEnv } from '../config/env.js';
import { MailTransport } from '../mail/mail.transport.js';

const i = process.argv.indexOf('--to');
const to = i >= 0 ? process.argv[i + 1] : undefined;
if (!to) {
  console.error('Usage: send-test-mail --to <email>');
  process.exit(1);
}

const env = validateEnv(process.env);
const transport = new MailTransport({ get: (key: keyof typeof env) => env[key] } as never);
console.log(`MAIL_TRANSPORT=${env.MAIL_TRANSPORT} from="${env.MAIL_FROM}"`);
try {
  const check = await transport.verify();
  if (!check.ok) throw new Error(`relay check failed: ${check.error}`);
  await transport.send(to, {
    subject: 'Knowledge mail test',
    text: 'If you are reading this, the configured mail transport delivers.\n\n— sent by make mail-test',
    html: '<p>If you are reading this, the configured mail transport delivers.</p><p style="color:#6b7280">— sent by make mail-test</p>',
  });
  console.log(env.MAIL_TRANSPORT === 'smtp' ? `Sent to ${to}` : 'Logged above (MAIL_TRANSPORT=log sends nothing)');
} catch (e) {
  console.error(`Mail test failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  transport.close();
}
