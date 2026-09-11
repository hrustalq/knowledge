# Dynamic Knowledge Platform — developer commands
# Usage: make help
SHELL := /bin/bash
.DEFAULT_GOAL := help

API := pnpm --filter @knowledge/api
WEB := pnpm --filter @knowledge/web
COMPOSE := docker compose
ENV_FILES := .env apps/api/.env

# ---------------------------------------------------------------- meta

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_/-]+:.*##' $(MAKEFILE_LIST) | \
	    awk 'BEGIN {FS = ":.*##"} {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: setup
setup: env-init ## First-time setup: env files, deps, infra, migrations, build
	pnpm install
	$(MAKE) infra-up
	$(MAKE) db-migrate
	pnpm build
	@echo "✔ Setup complete. Run 'make dev' — starts infra + api + web + worker."

# ---------------------------------------------------------------- dev

# Dev talks to intranet services (Confluence/Jira connectors) whose TLS chain is signed by a
# corporate CA that lives in the OS keychain and not in Node's bundled root store, which shows
# up as UNABLE_TO_VERIFY_LEAF_SIGNATURE. --use-system-ca adds the system trust store on top of
# the bundled roots — unlike NODE_TLS_REJECT_UNAUTHORIZED=0 it still verifies the chain.
# Node < 22.15 aborts on an unknown NODE_OPTIONS flag, so probe once and add nothing if absent.
DEV_NODE_OPTIONS := $(NODE_OPTIONS) $(shell node -e 'process.exit(process.allowedNodeEnvironmentFlags.has("--use-system-ca") ? 0 : 1)' 2>/dev/null && echo --use-system-ca)
# The system store does not help when a server sends only its leaf certificate and leaves the
# intermediate to AIA fetching (confluence.rolf.ru does exactly that): nothing is missing from
# the roots, the chain to them is just unbuildable. certs/extra-ca.pem carries those issuers.
CA_BUNDLE := $(wildcard certs/extra-ca.pem)
DEV_ENV := NODE_OPTIONS="$(strip $(DEV_NODE_OPTIONS))" $(if $(CA_BUNDLE),NODE_EXTRA_CA_CERTS="$(CURDIR)/$(CA_BUNDLE)")

.PHONY: dev
dev: infra-up ## Start EVERYTHING for dev: infra containers + api (:3000) + web (:5173) + worker, watch mode
	$(DEV_ENV) pnpm exec turbo run dev dev:worker

.PHONY: dev-api
dev-api: ## Run only the NestJS API in watch mode
	$(DEV_ENV) $(API) run dev

.PHONY: dev-web
dev-web: ## Run only the SSR frontend in dev mode
	$(DEV_ENV) $(WEB) run dev

.PHONY: dev-worker
dev-worker: ## Run only the ingestion worker in watch mode (already part of 'make dev')
	$(DEV_ENV) $(API) run dev:worker

.PHONY: dev-mcp
dev-mcp: ## Run the MCP server (stdio) in watch mode (needs infra up)
	$(DEV_ENV) $(API) run dev:mcp

.PHONY: ca-add
ca-add: ## Add a host's missing TLS intermediate to certs/extra-ca.pem: make ca-add host=confluence.rolf.ru
	@[ -n "$(host)" ] || { echo "Usage: make ca-add host=<hostname>"; exit 1; }
	@node scripts/ca-add.mjs $(host)

.PHONY: kill
kill: ## Kill all dev processes of this repo (api, web, worker, mcp, turbo, prisma studio)
	@killed=0; \
	for pid in $$(pgrep -f 'nest start|turbo|dist/main\.js|dist/worker\.main\.js|dist/mcp\.main\.js|node server|prisma studio' 2>/dev/null); do \
	    [ "$$pid" = "$$$$" ] && continue; \
	    cwd=$$(lsof -a -p $$pid -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'); \
	    case "$$cwd" in \
	        $(CURDIR)*) cmd=$$(ps -p $$pid -o command= | cut -c1-60); \
	            kill $$pid 2>/dev/null && killed=$$((killed+1)) && echo "· killed $$pid  $$cmd";; \
	    esac; \
	done; \
	echo "✔ killed $$killed process(es)"; \
	for port in 3000 5173; do \
	    pid=$$(lsof -tiTCP:$$port -sTCP:LISTEN 2>/dev/null | head -1); \
	    [ -n "$$pid" ] && echo "⚠ port $$port still in use by PID $$pid (not started from this repo — not killed)"; \
	done; true

.PHONY: kill-all
kill-all: kill infra-down ## Kill dev processes AND stop infra containers

.PHONY: build
build: ## Build all apps and packages
	pnpm build

.PHONY: lint
lint: ## Lint all workspaces
	pnpm lint

.PHONY: typecheck
typecheck: ## Typecheck all workspaces
	pnpm typecheck

.PHONY: check
check: lint typecheck build ## Lint + typecheck + build (CI gate)

.PHONY: clean
clean: ## Remove build artifacts and turbo cache
	rm -rf .turbo apps/api/dist apps/web/dist
	@echo "✔ Cleaned (node_modules kept; use 'make clean-all' to drop them)"

.PHONY: clean-all
clean-all: clean ## Also remove node_modules everywhere
	rm -rf node_modules apps/*/node_modules packages/*/node_modules

# ---------------------------------------------------------------- api client generation

.PHONY: api-schema
api-schema: ## Generate the OpenAPI schema from the NestJS app -> apps/api/openapi.json (no server needed)
	$(API) run build
	node --env-file=apps/api/.env apps/api/dist/scripts/generate-openapi.main.js --out apps/api/openapi.json

.PHONY: api-client
api-client: api-schema docs-reference ## Regenerate the typed web client: schema -> openapi-typescript -> apps/web/src/api/schema.d.ts
	$(WEB) run generate:api
	$(WEB) run typecheck
	@echo "✔ typed client regenerated — commit apps/api/openapi.json + apps/web/src/api/schema.d.ts + reference.generated.json"

.PHONY: docs-reference
docs-reference: ## Regenerate the docs page's endpoint + MCP tables from openapi.json, the controllers and mcp.service.ts
	$(WEB) run generate:docs

# ---------------------------------------------------------------- infra (docker)

.PHONY: infra-up
infra-up: ## Start postgres, minio (+bucket init), redis, arcadedb
	$(COMPOSE) up -d
	$(COMPOSE) ps

.PHONY: infra-up-opensearch
infra-up-opensearch: ## Start infra INCLUDING the optional OpenSearch BM25 node (set FULLTEXT_PROVIDER=opensearch)
	$(COMPOSE) --profile opensearch up -d
	$(COMPOSE) --profile opensearch ps

.PHONY: infra-up-searxng
infra-up-searxng: ## Start infra INCLUDING the optional SearXNG web-search node (set WEB_SEARCH_URL + WEB_ACCESS_MODE)
	$(COMPOSE) --profile searxng up -d
	$(COMPOSE) --profile searxng ps

.PHONY: infra-down
infra-down: ## Stop infra containers (volumes kept)
	$(COMPOSE) down

.PHONY: infra-restart
infra-restart: ## Restart infra containers
	$(COMPOSE) restart

.PHONY: infra-ps
infra-ps: ## Show infra container status
	$(COMPOSE) ps

.PHONY: infra-logs
infra-logs: ## Tail infra logs (S=service to filter, e.g. make infra-logs S=arcadedb)
	$(COMPOSE) logs -f $(S)

.PHONY: infra-nuke
infra-nuke: ## DESTRUCTIVE: stop infra and delete ALL data volumes (pg, minio, arcade)
	@read -p "This deletes ALL local data (Postgres, MinIO, ArcadeDB). Type 'yes' to continue: " a && [ "$$a" = "yes" ]
	$(COMPOSE) down -v

# ---------------------------------------------------------------- database (postgres / prisma)

.PHONY: db-migrate
db-migrate: ## Apply pending migrations to the local DB (creates one if schema drifted)
	$(API) exec prisma migrate dev

.PHONY: db-migrate-new
db-migrate-new: ## Prepare a named migration: make db-migrate-new name=add_tags
	@[ -n "$(name)" ] || (echo "Usage: make db-migrate-new name=<migration_name>"; exit 1)
	$(API) exec prisma migrate dev --name $(name)

.PHONY: db-migrate-deploy
db-migrate-deploy: ## Apply committed migrations only (no generation) — prod-style
	$(API) exec prisma migrate deploy

.PHONY: db-migrate-status
db-migrate-status: ## Show migration status vs local DB
	$(API) exec prisma migrate status

.PHONY: db-generate
db-generate: ## Regenerate the Prisma client from schema.prisma
	$(API) exec prisma generate

.PHONY: db-reset
db-reset: ## DESTRUCTIVE: drop & recreate DB, replay all migrations
	$(API) exec prisma migrate reset --force

.PHONY: db-studio
db-studio: ## Open Prisma Studio on the local DB
	$(API) exec prisma studio

.PHONY: auth-bootstrap
auth-bootstrap: ## Phase 5: create user + API key + workspace membership: make auth-bootstrap email=you@x.dev [workspace_id=<uuid>] [role=admin] [operator=true]
	@[ -n "$(email)" ] || (echo "Usage: make auth-bootstrap email=<email> [workspace_id=] [role=] [operator=]"; exit 1)
	$(API) run build >/dev/null
	node --env-file=apps/api/.env apps/api/dist/scripts/bootstrap-auth.main.js --email $(email) \
	    $(if $(workspace_id),--workspace-id $(workspace_id),) $(if $(role),--role $(role),) $(if $(operator),--operator $(operator),)

.PHONY: db-psql
db-psql: ## Open a psql shell in the postgres container
	$(COMPOSE) exec postgres psql -U knowledge knowledge

.PHONY: redis-cli
redis-cli: ## Open redis-cli in the redis container
	$(COMPOSE) exec redis redis-cli

# ---------------------------------------------------------------- graph (arcadedb)

.PHONY: arcade-check
arcade-check: ## Verify ArcadeDB is up and list schema types
	@curl -sf -u root:playwithdata -X POST http://localhost:2480/api/v1/query/knowledge \
	    -H 'Content-Type: application/json' \
	    -d '{"language":"sql","command":"SELECT name FROM schema:types"}' | head -c 2000; echo

.PHONY: arcade-studio
arcade-studio: ## Open ArcadeDB Studio in the browser (root/playwithdata)
	open http://localhost:2480

.PHONY: minio-console
minio-console: ## Open the MinIO console in the browser (minioadmin/minioadmin)
	open http://localhost:9001

# ---------------------------------------------------------------- env vars

.PHONY: env-init
env-init: ## Create .env files from .env.example where missing (never overwrites)
	@for f in $(ENV_FILES); do \
	    if [ -f $$f ]; then echo "· $$f exists — skipped"; \
	    else cp .env.example $$f && echo "✔ created $$f"; fi; \
	done

.PHONY: env-generate
env-generate: ## Regenerate .env files from .env.example (backs up existing to *.bak)
	@for f in $(ENV_FILES); do \
	    [ -f $$f ] && cp $$f $$f.bak && echo "· backed up $$f -> $$f.bak"; \
	    cp .env.example $$f && echo "✔ wrote $$f"; \
	done

.PHONY: env-check
env-check: ## Check .env files: missing/extra keys vs .env.example, empty required values
	@status=0; \
	example_keys=$$(grep -E '^[A-Z0-9_]+=' .env.example | cut -d= -f1 | sort); \
	for f in $(ENV_FILES); do \
	    if [ ! -f $$f ]; then echo "✖ $$f missing (run 'make env-init')"; status=1; continue; fi; \
	    file_keys=$$(grep -E '^[A-Z0-9_]+=' $$f | cut -d= -f1 | sort); \
	    missing=$$(comm -23 <(echo "$$example_keys") <(echo "$$file_keys")); \
	    extra=$$(comm -13 <(echo "$$example_keys") <(echo "$$file_keys")); \
	    [ -n "$$missing" ] && { echo "✖ $$f missing keys:"; echo "$$missing" | sed 's/^/    /'; status=1; }; \
	    [ -n "$$extra" ] && { echo "· $$f extra keys (ok):"; echo "$$extra" | sed 's/^/    /'; }; \
	    empty=$$(grep -E '^(DATABASE_URL|REDIS_URL|S3_ENDPOINT|S3_ACCESS_KEY|S3_SECRET_KEY|S3_BUCKET|ARCADE_URL|ARCADE_DB|ARCADE_USER|ARCADE_PASSWORD)=$$' $$f | cut -d= -f1); \
	    [ -n "$$empty" ] && { echo "✖ $$f required keys with empty values:"; echo "$$empty" | sed 's/^/    /'; status=1; }; \
	    [ $$status -eq 0 ] && echo "✔ $$f OK"; \
	done; exit $$status

.PHONY: env-validate
env-validate: ## Validate apps/api/.env against the API's zod schema (fail-fast boot check)
	@cd apps/api && node --env-file=.env -e "import('./dist/config/env.js').then(m => { m.validateEnv(process.env); console.log('✔ apps/api/.env passes zod validation'); }).catch(e => { console.error(e.message); process.exit(1); })"

# ---------------------------------------------------------------- smoke / e2e

.PHONY: smoke
smoke: ## Quick health check: api /docs, web /, arcadedb, minio, postgres, redis
	@curl -sfo /dev/null http://localhost:3000/docs   && echo "✔ api      :3000/docs"   || echo "✖ api      :3000 (make dev-api)"
	@curl -sfo /dev/null http://localhost:5173/       && echo "✔ web      :5173"        || echo "✖ web      :5173 (make dev-web)"
	@curl -sfo /dev/null http://localhost:2480/api/v1/ready && echo "✔ arcadedb :2480" || echo "✖ arcadedb :2480 (make infra-up)"
	@curl -sfo /dev/null http://localhost:9000/minio/health/ready && echo "✔ minio    :9000" || echo "✖ minio    :9000 (make infra-up)"
	@$(COMPOSE) exec -T postgres pg_isready -U knowledge >/dev/null 2>&1 && echo "✔ postgres :5432" || echo "✖ postgres :5432 (make infra-up)"
	@$(COMPOSE) exec -T redis redis-cli ping >/dev/null 2>&1 && echo "✔ redis    :6379" || echo "✖ redis    :6379 (make infra-up)"
