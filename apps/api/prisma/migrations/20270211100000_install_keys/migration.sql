-- #1371: a Connect wizard setup key. 'install' = accepted only by the skill and
-- capture-kit installer routes, for INSTALL_KEY_TTL_MINUTES. Null = an ordinary
-- key or an OAuth grant. Expand-only: nullable, no backfill, the previous
-- release never reads it.
ALTER TABLE "api_keys" ADD COLUMN "purpose" TEXT;
