-- CreateTable
CREATE TABLE "memory_units" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "fact_type" TEXT NOT NULL DEFAULT 'world',
    "context" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "document_id" TEXT NOT NULL,
    "source_text" TEXT NOT NULL,
    "occurred_start" TIMESTAMPTZ,
    "occurred_end" TIMESTAMPTZ,
    "mentioned_at" TIMESTAMPTZ,
    "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('russian', "text")) STORED,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_unit_entities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "entity_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "memory_unit_entities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_units_bank_id_document_id_idx" ON "memory_units"("bank_id", "document_id");

-- CreateIndex
CREATE INDEX "memory_units_bank_id_created_at_idx" ON "memory_units"("bank_id", "created_at");

-- CreateIndex
CREATE INDEX "memory_unit_entities_bank_id_entity_key_idx" ON "memory_unit_entities"("bank_id", "entity_key");

-- CreateIndex
CREATE UNIQUE INDEX "memory_unit_entities_unit_id_entity_key_key" ON "memory_unit_entities"("unit_id", "entity_key");

-- AddForeignKey
ALTER TABLE "memory_units" ADD CONSTRAINT "memory_units_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "memory_banks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_unit_entities" ADD CONSTRAINT "memory_unit_entities_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "memory_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Full-text leg of recall. Not expressible in the Prisma schema.
CREATE INDEX "memory_units_search_tsv_gin" ON "memory_units" USING gin ("search_tsv");
