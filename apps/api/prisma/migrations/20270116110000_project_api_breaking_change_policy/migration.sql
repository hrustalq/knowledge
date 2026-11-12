-- #922: the breaking-API merge gate per project. Null inherits the workspace's.
ALTER TABLE "projects" ADD COLUMN "api_breaking_change_policy" TEXT;
