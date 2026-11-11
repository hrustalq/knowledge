-- The project chosen for one Plaud recording (#877). Null = the link's
-- default at import time, which is every existing row and the old behaviour.
-- Additive and nullable, so the previous release is unaffected. No FK: a
-- deleted project is refused when the import runs, like the link's own.
ALTER TABLE "plaud_imports" ADD COLUMN "project_id" UUID;
