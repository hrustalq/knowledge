-- A bank's graph (#1008): the MCP reference memory server's entities and
-- relations. Additive: the previous release ignores both tables, so it
-- survives a rollback. Observations are memory_units rows, not a table here.

-- CreateTable
CREATE TABLE "memory_entities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_key" TEXT NOT NULL,
    "position" SERIAL NOT NULL,
    "observation_seq" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_relations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "from_id" UUID NOT NULL,
    "to_id" UUID NOT NULL,
    "relation_type" TEXT NOT NULL,
    "position" SERIAL NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_relations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_entities_bank_id_position_idx" ON "memory_entities"("bank_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "memory_entities_bank_id_name_key" ON "memory_entities"("bank_id", "name");

-- CreateIndex
CREATE INDEX "memory_relations_bank_id_position_idx" ON "memory_relations"("bank_id", "position");

-- CreateIndex
CREATE INDEX "memory_relations_to_id_idx" ON "memory_relations"("to_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_relations_from_id_to_id_relation_type_key" ON "memory_relations"("from_id", "to_id", "relation_type");

-- AddForeignKey
ALTER TABLE "memory_entities" ADD CONSTRAINT "memory_entities_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "memory_banks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "memory_banks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_from_id_fkey" FOREIGN KEY ("from_id") REFERENCES "memory_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_to_id_fkey" FOREIGN KEY ("to_id") REFERENCES "memory_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

