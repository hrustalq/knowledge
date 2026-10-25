-- #474: a page created as a private draft remembers who it belongs to until it
-- is published. Nullable with no default, so every existing page stays
-- published and the previous release's image runs against this schema.
ALTER TABLE "documents" ADD COLUMN "draft_owner_id" UUID;
