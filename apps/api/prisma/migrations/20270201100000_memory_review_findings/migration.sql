-- #1166: findings from the review of #1164.

-- A deletion stales mental models: it leaves no newer row for `staleness()` to find.
ALTER TABLE "memory_banks" ADD COLUMN "memories_deleted_at" TIMESTAMPTZ;

-- A scope's tag set may be up to 50 tags of 100 characters: past the btree row
-- limit as an array key. Unique on a hash of the canonical (sorted) set instead.
ALTER TABLE "memory_observation_scopes" DROP CONSTRAINT IF EXISTS "memory_observation_scopes_bank_id_tags_key";
DROP INDEX IF EXISTS "memory_observation_scopes_bank_id_tags_key";
-- Each tag length-prefixed, so no tag text can make two sets encode alike; the empty
-- set is '' (not NULL), so the untagged scope stays unique too. IMMUTABLE holds: the
-- input is text[] in its stored, sorted order.
CREATE FUNCTION memory_tag_set_key(tags text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT md5(coalesce(string_agg(length(t)::text || ':' || t, ',' ORDER BY i), ''))
    FROM unnest(tags) WITH ORDINALITY AS u(t, i)
$$;
CREATE UNIQUE INDEX "memory_observation_scopes_bank_id_tags_hash" ON "memory_observation_scopes" ("bank_id", memory_tag_set_key("tags"));

-- 20270128100000 added (bank_id, document_id, position) and left the narrower index behind.
DROP INDEX IF EXISTS "memory_units_bank_id_document_id_idx";
