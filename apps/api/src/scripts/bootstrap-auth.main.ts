/**
 * Phase 5 bootstrap (plan.md §11): create/refresh a user, API key, workspace
 * and membership so AUTH_MODE=api-key has something to authenticate against.
 *
 *   node --env-file=apps/api/.env apps/api/dist/scripts/bootstrap-auth.main.js \
 *     --email you@example.com [--name "You"] [--workspace-id <uuid>] \
 *     [--workspace-name "Demo Workspace"] [--role admin] [--operator true]
 *
 * The plaintext API key is printed ONCE; only its SHA-256 lands in Postgres.
 */
import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const DEMO_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ROLES = ['viewer', 'editor', 'admin'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const email = arg('email');
if (!email) {
  console.error(
    'Usage: bootstrap-auth --email <email> [--name <display name>] [--workspace-id <uuid>] ' +
      '[--workspace-name <name>] [--role viewer|editor|admin] [--operator true|false]',
  );
  process.exit(1);
}
const displayName = arg('name') ?? email.split('@')[0];
const workspaceId = arg('workspace-id') ?? DEMO_WORKSPACE_ID;
const workspaceName = arg('workspace-name') ?? 'Demo Workspace';
const role = arg('role') ?? 'admin';
const trustedOperator = (arg('operator') ?? 'true') === 'true';
// Auth flow: the bootstrapped user is the initial platform admin by default.
const isAdmin = (arg('platform-admin') ?? 'true') === 'true';
if (!ROLES.includes(role)) {
  console.error(`--role must be one of ${ROLES.join('|')}`);
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  const key = `kn_${randomBytes(24).toString('hex')}`;
  const apiKeyHash = createHash('sha256').update(key).digest('hex');

  await prisma.workspace.upsert({
    where: { id: workspaceId },
    update: { name: workspaceName },
    create: { id: workspaceId, name: workspaceName },
  });
  const user = await prisma.user.upsert({
    where: { email },
    update: { displayName, isAdmin },
    create: { email, displayName, isAdmin },
  });
  // A new named key beside any the user already has (docs/features/33):
  // bootstrapping twice must not lock out a client configured with the first.
  await prisma.apiKey.create({
    data: { userId: user.id, name: 'Bootstrap key', keyHash: apiKeyHash, prefix: key.slice(0, 11), scope: 'write' },
  });
  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
    update: { role, trustedOperator },
    create: { workspaceId, userId: user.id, role, trustedOperator },
  });

  console.log(
    JSON.stringify({ userId: user.id, email, workspaceId, workspaceName, role, trustedOperator }, null, 2),
  );
  console.log('\nAPI key (shown once; only its SHA-256 is stored — earlier keys stay valid, revoke them under Settings → Connect AI):');
  console.log(`  ${key}`);
  console.log(`\nWith AUTH_MODE=api-key:  curl -H 'Authorization: Bearer ${key}' http://localhost:3000/v1/me`);
} finally {
  await prisma.$disconnect();
}
