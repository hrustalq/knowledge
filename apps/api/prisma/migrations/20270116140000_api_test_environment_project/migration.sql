-- #925: a test environment may belong to one project. Null = shared, which is
-- every existing row, so nothing changes until someone binds one.
ALTER TABLE "api_test_environments" ADD COLUMN "project_id" UUID;
