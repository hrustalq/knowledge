-- #908 (#857 phase 4, step 2): drop the pre-credentials copies of connector and
-- sign-in secrets. #907 stopped reading and writing them and took them out of
-- schema.prisma one release earlier (v0.50.0), so no image from v0.50.0 on
-- declares them. Irreversible: a rollback can go no further back than v0.50.0.
-- Hand-written (dev DB drift, see #905); chat_integrations.credential stays.

ALTER TABLE "connectors" DROP COLUMN "credential", DROP COLUMN "credential_hint";
ALTER TABLE "connections" DROP COLUMN "credential", DROP COLUMN "credential_hint";
DROP TABLE "github_user_tokens";
DROP TABLE "figma_oauth_grants";
