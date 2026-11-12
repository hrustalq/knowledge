-- Origins, besides its server, that a test environment may send a secret to.
ALTER TABLE "api_test_environments" ADD COLUMN "secret_origins" TEXT[] DEFAULT ARRAY[]::TEXT[];
