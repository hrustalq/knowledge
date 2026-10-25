-- #474 phase 2: a branch can be private to the person who started it.
-- Additive: `restricted` defaults to false, so every existing branch stays as
-- readable as its page, and the previous release's image runs against this.
ALTER TABLE "document_branches" ADD COLUMN "owner_id" UUID;
ALTER TABLE "document_branches" ADD COLUMN "restricted" BOOLEAN NOT NULL DEFAULT false;
