-- #1095: the SSO exchange is bound to the browser that started the sign-in.
-- AlterTable
ALTER TABLE "sso_auth_requests" ADD COLUMN     "browser_hash" TEXT;
