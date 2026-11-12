-- #926: a glossary term with no project is a workspace term. No row is moved:
-- every existing term keeps its project, so linking is unchanged until an
-- admin writes or promotes a workspace term.
ALTER TABLE "glossary_terms" ALTER COLUMN "project_id" DROP NOT NULL;
