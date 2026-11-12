-- The toolsets a key is limited to (#945): a JSON string[] of MCP_TOOLSETS keys,
-- null for every toolset, which is every key that exists. Additive, no backfill.
ALTER TABLE "api_keys" ADD COLUMN "toolsets" JSONB;
