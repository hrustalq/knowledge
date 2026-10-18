-- #75 phase 2: the OIDC `sid` rides on the login transaction from the callback
-- to the session the exchange opens. Additive and nullable: survives a rollback.
ALTER TABLE "sso_auth_requests" ADD COLUMN "idp_session_id" TEXT;
