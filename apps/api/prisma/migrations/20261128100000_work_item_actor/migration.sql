-- #424 phase 2: who last changed a work item on the tracker side. Nullable, so
-- the previous image runs unchanged against it.
ALTER TABLE "connector_work_items" ADD COLUMN "external_actor_id" TEXT;
