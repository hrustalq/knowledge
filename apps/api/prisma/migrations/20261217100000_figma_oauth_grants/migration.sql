-- #557: Figma OAuth grants, one per Figma person. A new table, nothing reads
-- it in the previous release, so this survives a rollback.
-- CreateTable
CREATE TABLE "figma_oauth_grants" (
    "figma_user_id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "refreshing_until" TIMESTAMPTZ,
    "connected_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "figma_oauth_grants_pkey" PRIMARY KEY ("figma_user_id")
);
