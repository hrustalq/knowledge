-- #924: a capture parent page per project. Null inherits the workspace's.
ALTER TABLE "projects" ADD COLUMN "capture_parent_document_id" UUID;
