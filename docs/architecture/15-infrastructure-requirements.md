# 15 — infrastructure requirements: scaffold and serve

**Status:** current, 2026-11-24. Written against `dev` at v0.64.0 and the homelab
kustomization whose image tags are pinned at v0.59.0.

**Question:** what infrastructure does Knowledge need (a) for a developer to
scaffold it locally and (b) to serve it in production? This document answers both
so a host or a cluster can be sized without reading the compose files.

Everything below is either a **measured value** (a manifest field, a registry
index or a command's output, with the source named) or an **estimate** (marked,
with the reasoning). No figure is copied from a vendor's sizing page.

## 1. Scope

**In scope.** Every process the platform runs — the API, the worker, the git
remote, the SSR web server, the proxy, the datastores, and the optional
search/rendering services — plus the hook jobs, their ports, storage, memory,
external services, and the operational shape of a deploy.

**Out of scope.** Application architecture (docs 01–11), feature behaviour
(`docs/features/`), the release process ([CONTRIBUTING.md](../../CONTRIBUTING.md)),
and build-time CI internals. Also out of scope: sizing *for a specific number of
users*. The platform has no published benchmark, and this document does not
invent one — see [§5](#5-sizing) for what is measured and what is a rule of
thumb.

**Two words used throughout.**

- **Scaffold** — a developer runs `make setup` once and `make dev` afterwards on
  their own machine, with no external accounts.
- **Serve** — the platform answers requests for real users. The current target is
  a homelab k3s cluster; [§4](#4-serve-requirements-production) separates that
  from what any comparable deployment would need.

## 2. Workload inventory

Twelve workloads (7 Deployments, 5 StatefulSets) and three hook containers (two
Jobs and one initContainer) in the `knowledge` namespace. CPU and memory are the
values in `k8s/apps/knowledge/app.yaml` and `datastores.yaml`; `-` means the key
is absent.

| Workload | Role | Stateful? | Image | Optional? | CPU req | Mem req | Mem limit | PVC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `api` | HTTP API: REST, `/v1/mcp`, SSE + WS events, collab socket | no | `knowledge-api:<tag>` (`Dockerfile.api`, target `runtime`) | always | 200m | 512Mi | 2Gi | `applogs` |
| `worker` | BullMQ processors: ingestion, import, workflow, connector, agent; the only process that sends mail | no (queue state in Redis) | same image, `node dist/worker.main` | always | 200m | 512Mi | 2Gi | `applogs` |
| `web` | Vue SSR server (Node, not nginx) | no | `knowledge-web:<tag>` (`Dockerfile.web`) | always | 100m | 256Mi | 1Gi | `applogs` |
| `git` | smart-HTTP git remote, one bare repository per project | cache only, rebuildable | `knowledge-api-git:<tag>` (`Dockerfile.api`, target `git-runtime`) | profile `git` | 50m | 256Mi | 1Gi | `gitcache`, `applogs` |
| `gotenberg` | Page → PDF via headless Chromium | no | `gotenberg/gotenberg:8` | profile `gotenberg` | 50m | 256Mi | 2Gi | — |
| `searxng` | metasearch backend for `web_search` | no | `searxng/searxng:latest` | always in prod (dev: profile `searxng`) | 50m | 128Mi | 512Mi | — (settings ConfigMap) |
| `caddy` | Front proxy: `/api/*` prefix strip, `/oauth-*`, presigned `/<bucket>/*` → MinIO, `/git/*`, `/admin/*`, else SSR | no | `caddy:2-alpine` | always (compose: not a profile) | 50m | 64Mi | 256Mi | — (`/data`, `/config` emptyDir) |
| `postgres` | transactional truth: documents, branches, revisions + DAG, jobs, diffs | **yes** | `postgres:17-alpine` | always | 100m | 256Mi | 2Gi | `data` 10Gi |
| `redis` | BullMQ queues, pub/sub, rate limits, optional read cache | **yes** (queue durability) | `redis:7-alpine` (compose: `8-alpine`) | always | 50m | 64Mi | 512Mi | `data` 1Gi |
| `minio` | S3 object store, versioned bucket `knowledge` | **yes** | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | always | 50m | 256Mi | 1Gi | `data` 20Gi |
| `arcadedb` | graph + vectors (`LSM_VECTOR` chunks) | **yes** | `arcadedata/arcadedb:26.10.2` (compose: `26.11.1`) | always | 100m | 512Mi | 2Gi | `data` 10Gi |
| `opensearch` | BM25 keyword index, fused with the vector leg | **yes**, rebuildable | `opensearchproject/opensearch:2` | profile `opensearch` | 100m | 1Gi | 1536Mi | `data` 10Gi |
| `migrate` (Sync hook) | `npx prisma migrate deploy` as the schema owner | — | `knowledge-api` | always (wave 0) | none set | none set | none set | — |
| `roles` (initContainer of `migrate`) | creates the owner and app Postgres roles (`deploy/postgres-roles.sh`), idempotent | — | `postgres:17-alpine` | always | none set | none set | none set | — |
| `minio-init` (Sync hook) | creates the bucket and enables versioning | — | `pgsty/mc:RELEASE.2026-09-16T00-00-00Z` | always (wave 0) | none set | none set | none set | — |

**Totals over the twelve Deployments/StatefulSets** (the Jobs declare no
resources, so they add nothing to either sum):

| | Requests | Limits |
| --- | --- | --- |
| CPU | 1,100m (12 containers) | none declared |
| Memory | 4,096Mi = **4 GiB** | 16,128Mi = **15.75 GiB** |

**Storage: 66 GiB across 7 claims**, all `local-path`, all `ReadWriteOnce`:

| Claim | Size | Written by |
| --- | --- | --- |
| `applogs` | 10Gi | `api`, `worker`, `web`, `git` (`LOG_DIR=/app/logs`, one JSONL file per service per day) |
| `gitcache` | 5Gi | `git` (bare repositories; a cold rebuild from Postgres + MinIO costs time, never data) |
| `postgres/data` | 10Gi | `postgres` |
| `redis/data` | 1Gi | `redis` |
| `minio/data` | 20Gi | `minio` — the object store's own volume |
| `arcadedb/data` | 10Gi | `arcadedb` |
| `opensearch/data` | 10Gi | `opensearch` |

`local-path` provisions a directory on the node — the request is a planning
ceiling, not a reservation, so usage is whatever the objects actually take. The
provisioner keeps the volume on one node, and there is no replication: every
claim-backed pod is pinned to `k3s-server` (the only control-plane node), which
is why the manifests accept `ReadWriteOnce` for a volume shared by four pods.

**What the manifests do not deploy.** Two processes exist in the repository but
not in the namespace:

- **`admin`** — the platform console (`Dockerfile.admin`, static SPA behind
  Caddy on 8080, routed at `/admin/*`). Its image is built by `images.yml`; the
  homelab kustomization does not list it yet, so it has no request or limit to
  report. When it lands, budget it like `caddy`: ~25 MB compressed, tens of MiB
  of RAM.
- **`learner`** — the learning-loop timer (`dist/learner.main`, compose profile
  `learner`, `LEARNER_ENABLED` off by default). It has no manifest anywhere and
  no declared resources. It is a fourth `api`-class Node process: idle RSS in the
  low hundreds of MiB, a model call and an embedding pass per workspace per day.
  Size it like `worker` (200m / 512Mi request) if you deploy it.

The MCP server is not a process: `POST /v1/mcp` is served by `api`, and
`make dev-mcp` is a stdio client-side entrypoint only.

## 3. Scaffold requirements (developer machine)

### 3.1 Operating system and toolchain

| Requirement | Version | Why that version |
| --- | --- | --- |
| OS | macOS (Apple Silicon, reference: 15.3.1) or Linux x86_64/arm64 | The repo is developed on macOS; the Dockerfiles build Linux images and nothing in the toolchain is platform-specific. Windows is untested (WSL2 should work). |
| Node.js | **>= 22** (`package.json` `engines`); 22.15+ recommended | `make dev` probes for `--use-system-ca` and adds it only when Node supports the flag (22.15+). Without it, a connector pointed at a TLS endpoint signed by a corporate CA fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. |
| pnpm | **10.30.1**, exactly | Pinned by `packageManager`; no `corepack` on this Node install, so install pnpm directly. A different pnpm resolves a different lockfile layout. |
| Docker | Docker Desktop or Colima, with Docker Compose v2 | Four datastores plus optional nodes. Colima is what production used on the Mac mini; either is fine locally. |
| make | GNU Make 3.x | The root `Makefile` is the entry point, and `SHELL := /bin/bash` — bash is required (macOS `/bin/sh` is not enough). |
| git | 2.x | `make setup` runs `husky`; the git remote feature shells out to `git` at runtime in dev. |
| Free disk | see 3.2 | |

Measured on the reference workstation: Node v22.22.0, pnpm 10.30.1, GNU Make
3.81, git 2.39.5, macOS 15.3.1.

### 3.2 Disk

The repository itself is small: 64 MB working tree including 28 MB of `.git`.
The weight is `node_modules` and Docker images.

| Item | Size | Basis |
| --- | --- | --- |
| pnpm install + store | ~3 GiB | estimate: `pnpm-lock.yaml` resolves 1,717 package entries; a monorepo of this size installs to 2–3 GiB |
| Default dev image set | 0.54 GB compressed | measured: `postgres:17-alpine` 117 MB, `redis:8-alpine` 43 MB, `pgsty/minio` 55 MB, `pgsty/mc` 19 MB, `arcadedb:26.11.1` 302 MB |
| Default + every dev profile | 2.39 GB compressed, total | measured: the above plus `opensearch:2` 1,040 MB, `gotenberg:8` 697 MB, `searxng:latest` 103 MB, `mailpit:v1.33` 14 MB |
| Unpacked images | 2–3× compressed | estimate: the compose file's own figure for Gotenberg is "~2.5 GB" against 697 MB compressed here (3.6×), so 2–3× is the conservative band for the rest |
| Local image builds | several GiB of build cache | estimate; only if you run `docker build` yourself — `make dev` runs from source and builds nothing |

**Budget 20 GiB free** for a comfortable scaffold (repo + install + every
profile unpacked + a build cache), and treat 10 GiB as the floor for the default
stack. None of this is needed in production, where `node_modules` and the build
toolchain live inside the image.

### 3.3 Memory

Every figure in this table is an **estimate** — no container was started for
this document, and none of the compose files declares a memory limit in dev.

| Stack | Docker memory to give it | Why |
| --- | --- | --- |
| Default (`make infra-up`: postgres, minio, redis, arcadedb) | **6 GiB** (estimate) | Postgres idles at ~50–100 MB, Redis and MinIO at tens of MB each. ArcadeDB is the consumer: `docker-compose.yml` sets **no** `-Xmx`, so the JVM sizes its heap from the VM's total RAM (default max heap ≈ 25%), and ingestion plus the LSM vector index add off-heap. |
| Default + `opensearch` | 10–12 GiB (estimate) | OpenSearch is capped in the compose file at a 512 MB heap in a 1.5 GB container; the rest is for ArcadeDB's uncapped JVM and the page cache. The production compose file's own comments assume a **10 GB Colima VM** shared with image builds — that is the design point. |
| Default + `gotenberg` | +1–2 GiB (estimate) | Chromium peaks per conversion; `EXPORT_CONCURRENCY` defaults to 2. |
| `mailpit`, `keycloak`, `searxng` | +0.5–1 GiB (estimate) | Mailpit is tiny; Keycloak's JVM is the largest of the three. |

Production caps ArcadeDB's heap at 1 GiB (`JAVA_OPTS -Xms256m -Xmx1g` in
`docker-compose.prod.yml`); **dev does not**, which is the single most likely
cause of a laptop feeling short of memory under `make dev`.

### 3.4 Ports

| Port | Process | Notes |
| --- | --- | --- |
| 3000 | api | Swagger at `/docs`; `make smoke` checks it |
| 5173 | web | SSR; `/admin` is served through it in dev |
| 5174 | admin | its own Vite server; `make dev-admin`, open `:5173/admin` |
| 3002 | git remote | `make dev-git`; answers 404 unless `GIT_REMOTE_ENABLED=true` |
| 5432 | postgres | loopback only |
| 6379 | redis | loopback only |
| 9000 / 9001 | minio API / console | loopback only |
| 2480 / 2424 | arcadedb HTTP+studio / binary | loopback only |
| 9200 | opensearch | profile `opensearch` only |
| 8888 → 8080 | searxng | profile `searxng`; host 8888 so it cannot collide |
| 3100 → 3000 | gotenberg | profile `gotenberg`; host port chosen because 3000 is the API's |
| 1025 / 8025 | mailpit SMTP / inbox | profile `mailpit` |
| 8180 | keycloak | profile `keycloak`, for exercising SSO |

Everything except the app ports is bound to `127.0.0.1`, not `0.0.0.0`.

### 3.5 The flow

`make setup` is safe to re-run (it never overwrites an existing `.env`) and does
five things in order: `env-init` copies
`.env.example` → `.env` and `apps/api/.env` (never overwrites an existing file),
`pnpm install`, `make infra-up` (docker compose up for postgres, minio + bucket
init, redis, arcadedb), `make db-migrate` (`prisma migrate dev`), and
`pnpm build`.

`make dev` runs `infra-up` and then `turbo run dev dev:worker`, which starts the
API in watch mode on 3000, the web app on 5173, the admin console on 5174 and the
BullMQ worker. `make verify` is the pre-push gate; `make check` is CI (it
rebuilds `apps/api/dist`, which kills a running dev server).

No `.env` value is required to get a working app: the checked-in defaults are
`AUTH_MODE=none`, `EMBEDDINGS_PROVIDER=stub`, `MAIL_TRANSPORT=log`,
`ASSISTANT_PROVIDER=none`, `FULLTEXT_PROVIDER=none` and `WEB_ACCESS_MODE=off`.

### 3.6 External providers in dev

| Provider | Required in dev? | Default | What a developer gets by adding it |
| --- | --- | --- | --- |
| Embeddings | **no** | `EMBEDDINGS_PROVIDER=stub`, 384 dimensions | A real retrieval model: `ollama pull bge-m3`, then `openai-compatible` at `http://localhost:11434/v1` with `EMBEDDINGS_DIM=1024`. The stub is a hashed bag of words — `.env.example` records 49% recall@1 on a 467-page import, so search quality is not representative without this. Changing provider/dim reindexes on the next sweep. |
| LLM for relation extraction | no | `EXTRACTOR_PROVIDER=none` | Graph edges from prose (frontmatter relations still work). `qwen2.5:7b` on Ollama is the documented local option. |
| Assistant / agents | no | `ASSISTANT_PROVIDER=none` | Review, suggest, ask, agents. Any OpenAI-compatible endpoint, or a workspace-level provider in AI settings. |
| SMTP | no | `MAIL_TRANSPORT=log` (messages are printed, not sent) | `make infra-up-mailpit` + `smtp://localhost:1025`; inbox at `:8025`. |
| SSO / LDAP / SCIM | no | `AUTH_SSO_ENABLED=false` | `make infra-up-keycloak` with the seeded realm (`ada/ada` verified, `eve/eve` unverified) and `AUTH_MODE=api-key`. |
| GitHub App | no | empty; repo connectors take a PAT | The repository picker and PR features. Needs a public HTTPS callback, so it is awkward locally. |
| BM25 search | no | `FULLTEXT_PROVIDER=none` | `make infra-up-opensearch` + `opensearch` provider. Turning it on later requires a reindex. |
| Web research | no | `WEB_ACCESS_MODE=off` | `make infra-up-searxng` and `WEB_SEARCH_URL=http://localhost:8888`; fetching a named URL works without it. |
| MCP OAuth | no | `MCP_OAUTH_ENABLED=false` | Browser sign-in for MCP clients instead of handing out a key. |

So the scaffold's only hard requirement is a container runtime and enough disk;
every account and every model is optional, and each one is off by default.

## 4. Serve requirements (production)

### 4.1 The current target

Production is the homelab k3s cluster, deployed by Argo CD from
`hrustalq/homelab`, `k8s/apps/knowledge/`. That directory is a **lift-and-shift
of [`docker-compose.prod.yml`](../../docker-compose.prod.yml)**: service names,
images and JVM flags are the same, so the app's config
(`DATABASE_URL=…@postgres:5432`, `REDIS_URL=…@redis:6379`, …) is unchanged.

| Requirement | How the current deployment satisfies it |
| --- | --- |
| Kubernetes | k3s v1.37.2+k3s1, Traefik and ServiceLB disabled in favour of GitOps-installed platform components |
| GitOps controller | Argo CD 3.6, polling `main` every ~2 minutes; `k8s/apps/*` are Applications in the `apps` project (namespaced resources + `Namespace` only) |
| Namespace | `knowledge`, created by the kustomization itself |
| Gateway API | `traefik/traefik-gateway` (HTTP :80, routes from all namespaces), behind MetalLB L2 `192.168.20.200` |
| Routes | `knowledge.apps.lan` (LAN) and `edge.tail92dbf3.ts.net` with `X-Edge-Host: knowledge.hrustalq.dev` (public), both → `caddy:80` |
| Storage class | `local-path`, 66 GiB over 7 claims, all pinned to `k3s-server` |
| Secret controller | sealed-secrets 0.41 in `kube-system`; the deploy seals config with `k8s/platform/sealed-secrets/pub-cert.pem` |
| Network policy enforcement | k3s's embedded kube-router; `networkpolicy.yaml` is default-deny on **ingress**, egress open |
| Image registry | `ghcr.io/hrustalq/knowledge-{api,api-git,web,admin}`, pulled with a read-only PAT configured cluster-wide |
| Public edge | Cloudflare Worker (`knowledge.hrustalq.dev`) → Tailscale Funnel `edge.tail92dbf3.ts.net` → Traefik → Caddy. A Cloudflare Tunnel cannot connect from this network (its handshake is filtered on every egress), which is why Funnel is in the path |
| Replicas | exactly **1** for every workload; `apps/*` ignore `replicas` drift so `kubectl scale` survives a sync |

**Consequences of that shape**, which an operator must plan around rather than
discover:

- **No high availability.** One replica per process, one node with the volumes,
  one control plane. A node restart is downtime; a volume's node loss is data
  loss until backups exist.
- **The GPU node contributes nothing.** `k8s-gpu` (4 vCPU / 8 GiB, RTX 5070) runs
  no Knowledge workload; `k3s-server` (6 vCPU / 16 GiB / 300 GiB) runs all of
  them.
- **Sync order is load-bearing.** Waves: `-2` secrets and network policies, `-1`
  datastores, `0` role + migration + bucket hooks, `1` app, `2` routes. A
  `local-path` PVC belongs in the same wave as its pod (it binds on first
  consumer), and an HTTPRoute comes after its backend or Argo reports Degraded.

### 4.2 Manifest drift from the compose files

The manifests are authoritative for sizing, but they are not a byte-for-byte copy
of `docker-compose.prod.yml`. Four differences matter to an operator:

| Item | `docker-compose.prod.yml` | `k8s/apps/knowledge` |
| --- | --- | --- |
| Redis | `redis:8-alpine` | `redis:7-alpine` — a different major version sharing the same 1 GiB `data` claim |
| ArcadeDB | `26.11.1` + digest | `26.10.2` + digest |
| Caddy, Gotenberg, SearXNG, OpenSearch, Postgres | pinned by tag **and** digest | tag only (`searxng:latest` has no tag pin at all) |
| Opt-in services | `COMPOSE_PROFILES` decides at `up` time | no profile switch: `gotenberg`, `searxng` and `opensearch` are always-on Deployments/StatefulSets |

Also: the kustomization currently pins the app images at **v0.59.0** while `dev`
is at v0.64.0. That is release lag, not drift — a tag bump moves it.

### 4.3 What a generic deployment needs

Nothing in `apps/api` requires Kubernetes. A comparable deployment needs:

- **Any Kubernetes** that can run `StatefulSet`s, `Job`s and a
  `ReadWriteOnce` StorageClass, with a Gateway API implementation (or
  `routes.yaml` rewritten as Ingress), a secret store (sealed-secrets here;
  External Secrets or a plain Secret elsewhere), and a pod network that enforces
  NetworkPolicy if you want the namespace isolation the manifests assume. The
  Jobs are plain `batch/v1`; the StatefulSets need no operator. A cluster that
  cannot bind PVCs is not enough.
- **Or a single Docker host** running `docker-compose.prod.yml`, which has **no
  `build:` section on purpose** — images must be built elsewhere (`images.yml`
  or a local build) and tagged `knowledge-api:<tag>`, `knowledge-api-git:<tag>`,
  `knowledge-web:<tag>`. `docker compose up` in that directory will not build a
  source tree it does not have.
- **A reverse proxy and TLS.** The Caddyfile serves plain HTTP at `:80` and
  trusts visitor headers only alongside `EDGE_SECRET`; TLS is expected to end at
  the edge. Reusing it without an edge that sets `X-Knowledge-*` is safe — the
  header block simply never matches, and every visitor is logged as the
  immediate proxy rather than the real client.
- **`AUTH_MODE=api-key`.** Under `NODE_ENV=production` the API refuses
  `AUTH_MODE=none` unless `AUTH_ALLOW_NONE_IN_PRODUCTION=true`, because `none`
  injects a full-access principal — on a public domain that is an open
  read/write knowledge base.
- **Outbound internet** (or a proxy) for connectors, web sources, model providers
  and `ghcr.io`. Ingress is locked down; egress is deliberately not.

## 5. Sizing

### 5.1 How the totals were produced

One small script over the manifests, so the numbers reconcile rather than being
transcribed by hand. It reads every YAML document in the directory, keeps
Deployments, StatefulSets, Jobs and PVCs, and sums `resources.requests/limits`
per container plus every `volumeClaimTemplates` entry. Run it with PyYAML
available (a scratch venv is enough):

```python
# k8s-totals.py — python3 k8s-totals.py k8s/apps/knowledge
import sys, os, yaml
DIR = sys.argv[1]
cpu = lambda v: 0 if not v else int(v[:-1]) if str(v).endswith("m") else int(float(v) * 1000)
mem = lambda v: 0.0 if not v else float(str(v)[:-2]) * (1024 if str(v).endswith("Gi") else 1)
req_c = req_m = lim_m = 0
for name in sorted(os.listdir(DIR)):
    if not name.endswith(".yaml"):
        continue
    for d in yaml.safe_load_all(open(os.path.join(DIR, name))):
        if not d or d.get("kind") not in ("Deployment", "StatefulSet"):
            continue
        spec = d["spec"]
        pvcs = spec.get("volumeClaimTemplates", [])
        print(f'{d["metadata"]["name"]:11}', end=" ")
        for c in spec["template"]["spec"]["containers"]:
            r = c.get("resources", {}) or {}
            rq, lm = r.get("requests", {}) or {}, r.get("limits", {}) or {}
            print(f'{rq.get("cpu", "-"):>4} {rq.get("memory", "-"):>5} '
                  f'{lm.get("cpu", "-"):>4} {lm.get("memory", "-"):>6}', end=" ")
            req_c += cpu(rq.get("cpu")); req_m += mem(rq.get("memory")); lim_m += mem(lm.get("memory"))
        print("| pvc:", [v["spec"]["resources"]["requests"]["storage"] for v in pvcs])
print(f"requests: {req_c}m / {req_m:.0f}Mi ({req_m / 1024:.2f}Gi)")
print(f"limits:   {lim_m:.0f}Mi ({lim_m / 1024:.2f}Gi)")
```

Command used:

```bash
python3 k8s-totals.py ~/Projects/homelab/k8s/apps/knowledge
```

Output (2026-11-24): `requests: 1100m / 4096Mi (4.00Gi)`, `limits: 16128Mi
(15.75Gi)`, seven claims totalling 66 GiB. The script prints one row per
container; the table in [§2](#2-workload-inventory) is that output, reflowed with
the role and image columns added by hand.

(The script does not add `PersistentVolumeClaim` documents outside the
templates; `applogs` and `gitcache` are counted from `app.yaml` by hand, which is
why the total is stated as 7 claims rather than 5.)

### 5.2 Tiers

Summed from the rows above. "Core" is the eight processes with nothing optional;
"recommended" adds git, Gotenberg and SearXNG; "full" adds OpenSearch.

| Tier | Workloads | CPU request | Mem request | Mem limits | PVCs (+ `applogs`) | Host |
| --- | --- | --- | --- | --- | --- | --- |
| **Minimum viable** | api, worker, web, caddy, postgres, redis, minio, arcadedb | 850m | 2.4 GiB | 10.75 GiB | 41 + 10 = 51 GiB | **4 vCPU / 8 GiB / 80 GiB** |
| **Recommended** | + git, gotenberg, searxng | 1,000m | 3 GiB | 14.25 GiB | 46 + 10 = 56 GiB | **6 vCPU / 16 GiB / 100 GiB** |
| **Full** | + OpenSearch (`learner` and `admin` are extra, not counted) | 1,100m | 4 GiB | 15.75 GiB | 56 + 10 = 66 GiB | **6–8 vCPU / 24 GiB / 150 GiB** |

**How to read the host column.** The CPU request is deliberately far below the
host: there is no CPU limit anywhere in the manifests, so a reindex, an import
and a PDF render can each burst to a whole core. The memory column is where the
arithmetic bites — the **request** total is what a scheduler needs, and the
**limit** total is what the kernel may be asked for. A host smaller than the
limit sum is viable only if the limits are lowered; see 5.3. The recommended
row's 16 GiB assumes the node is **dedicated to this namespace**: run the
monitoring stack beside it and the practical size is the full row's 24 GiB.

**Against the current hardware.** `k3s-server` is 6 vCPU / 16 GiB / 300 GiB and
runs the **full** set, because the k8s manifests have no profile switch. The
verdict is plain:

- **By requests it fits with room to spare** — 4 GiB of 16 GiB, 1.1 of 6 vCPU.
- **By limits it does not fit** — 15.75 GiB against roughly 15 GiB allocatable on
  a 16 GiB node (rule of thumb: kubelet and the system reserve about 1 GiB) that
  also runs kubelet, containerd, Traefik, MetalLB, Argo CD and the monitoring
  stack (Prometheus keeps 15 days of history). If every container reached its
  limit at once the node would OOM before that happened; the limits are
  individually plausible and collectively impossible.
- **So the current box works at its real load and has no configured margin.**
  Either give it 24 GiB, or drop OpenSearch from the namespace (the settings
  support it — `FULLTEXT_PROVIDER=none`), or lower the 2 GiB limits. That is the
  sizing conclusion of this document.
- **Disk is not the constraint:** 66 GiB of claims on a 300 GiB VM.

### 5.3 Headroom and where the OOM risk sits

Limits sum above requests by construction: the scheduler places pods on requests
and the kernel kills on limits. Headroom is not waste — it is what lets one
process burst while its neighbours idle. The specific places a 16 GiB node runs
out, in order:

1. **OpenSearch** — 512 MB heap in a 1,536Mi limit. That ratio is normal for
   Elasticsearch-family servers, but the non-heap half (Lucene, direct buffers,
   mmap) grows during a bulk reindex, so this pod is the first to hit its cgroup.
2. **ArcadeDB** — `-Xmx1g` in a 2 GiB limit. JVM overhead plus the LSM vector
   index's off-heap structures grow outside the heap during ingestion. That
   leaves 1 GiB of non-heap room — the same as OpenSearch's — and the LSM index
   is the structure that grows fastest on a first ingest.
3. **api / worker** — Node, capped at 2 GiB by the cgroup but **not** by V8:
   `NODE_OPTIONS=--max-old-space-size=2560` appears in the Dockerfile's *builder*
   stage only, and V8 sizes its default heap from the host's total RAM, not the
   cgroup. So the process does not throw a JS heap error at 2 GiB; the kernel
   kills it. The worker is the one to watch — imports, PDF parsing and embedding
   batches all run in its heap, and a 200 MiB memo is allowed by the app's own
   cap (`MEMO_MAX_BYTES`).
4. **Gotenberg** — 2 GiB with `EXPORT_CONCURRENCY=2`: two Chromium instances in
   one pod, each rendering a page tree up to 500 pages / 256 MiB.
5. **Postgres** — 2 GiB is generous at default settings (`shared_buffers` is
   128 MB). The risk is a large sort or `VACUUM`, plus page cache accounted to
   the pod under cgroup v2; it is not the first limit to be hit.
6. **git, web, searxng, caddy, redis, minio** — 1 GiB and below, all small
   next to the rest.

Two facts sharpen this: **no CPU limit** is declared anywhere, and the namespace
has **no ResourceQuota or LimitRange**. A single runaway pod can therefore
consume the node's CPU or memory with nothing but the kernel to stop it, which is
acceptable for a single-tenant homelab and is the first thing to add before
hosting someone else's workspace.

### 5.4 Storage growth

The 66 GiB is a request, not a forecast. What actually grows:

- **MinIO** — the dominant term. The bucket is **versioned**, and every revision
  stores `source.md` + `normalized.json` under
  `workspaces/{ws}/documents/{doc}/revisions/{rev}/`. Revisions are immutable, so
  editing a page adds objects and only a workspace teardown purges its prefix;
  attachments and 20 collab checkpoints per draft add to it. There is no honest
  way to predict a corpus size from the code, so size this volume from the corpus
  you will import: bytes ≈ Σ(2 × page size) per revision, plus attachments.
- **Postgres** — metadata only (documents, revisions, the `revision_parents`
  DAG, cached diffs, jobs, audit/activity/analytics rows). It grows with edit
  volume, not with document bytes; retention settings exist for analytics
  (`ANALYTICS_RETENTION_DAYS`), feedback and ops events.
- **ArcadeDB** — 1024-dimensional chunk vectors; roughly `4 KB × chunks` for the
  vector payload alone, plus graph edges and entities. Rebuilt by reindex.
- **OpenSearch** — an inverted index plus the stored chunk text; rebuilt by
  reindex, so it needs no backup, only room.
- **`applogs`** — one JSONL file per service per day, never rotated by the app.
  10 GiB is a lot of `info`-level lines; a full reindex with
  `OPS_JSONL_ENABLED=true` emits tens of thousands of measurement records, so
  this is the volume to watch on a busy box (or set `LOG_LEVEL=warn`).
- **`gitcache`** — one bare repository per project and visible set; rebuilding is
  a cold clone from Postgres + MinIO, so it is sized for convenience, not truth.

## 6. External dependencies and configuration

| Dependency | Used for | Required? | Configuration |
| --- | --- | --- | --- |
| **Embeddings** | chunk vectors for search, dedupe, memory | **yes, for real search** | `EMBEDDINGS_PROVIDER=openai-compatible`, `EMBEDDINGS_BASE_URL` (must end `/v1`), `EMBEDDINGS_MODEL=bge-m3`, `EMBEDDINGS_DIM=1024`. Production points at the in-cluster LiteLLM gateway (`http://litellm.ai.svc.cluster.local:4000/v1`) serving `bge-m3` from the cluster's Ollama, so no document text leaves the cluster. `EMBEDDINGS_API_KEY` is a LiteLLM key. `EMBEDDINGS_DIM` must equal the model's real width or every indexing job fails with "Vector dimension does not match index dimension". Rollback to the stub embedder (`stub`, 768) is supported and triggers a full reindex; `SEARCH_MIN_COSINE` must go to 0 with it. |
| **LLM / assistant** | assistant, agents, extraction, lint, arbiter | no | `ASSISTANT_PROVIDER=none` in the production template; `deepseek`, `gen-api` or any `openai-compatible` endpoint turns it on. Workspace-level providers are configured in AI settings and stored under `SETTINGS_ENCRYPTION_KEY`. |
| **SMTP relay** | verification, reset, invite, notification mail | no | `MAIL_TRANSPORT=log` by default; `smtp`/`smtps` with a credential-free `MAIL_SMTP_URL` plus `MAIL_SMTP_USER`/`MAIL_SMTP_PASS`. The From domain needs SPF + DKIM or mail lands in spam. Only the worker sends (`mail` queue). |
| **SSO / LDAP / SCIM** | enterprise sign-in and provisioning | no | `AUTH_SSO_ENABLED=false`; per-workspace providers, `AUTH_LDAP_ENABLED`, `AUTH_SCIM_ENABLED`. Needs `AUTH_MODE=api-key` and `SETTINGS_ENCRYPTION_KEY`. Enforced SSO is checked inside `requireRole`, with `AUTH_BREAK_GLASS_EMAILS` as the way back in. |
| **GitHub App** | repository picker, PR drift, code research, work items | no | Five `GITHUB_APP_*` keys plus `GITHUB_APP_WEBHOOK_SECRET`; public callback `$API_PUBLIC_URL/v1/connectors/github/callback` and webhook path. Empty = PAT connectors instead, a supported configuration. |
| **Figma / Plaud OAuth** | design embeds / memo import | no | Figma is a private Figma app (client id + secret); Plaud is a public client (id only, no secret). Both are registered against `$API_PUBLIC_URL` and both are empty by default. |
| **SearXNG** | `web_search` backend | no | `WEB_SEARCH_URL=http://searxng:8080`; `WEB_ACCESS_MODE` is a **ceiling** over per-workspace policies (`open` = deny-list, `allowlist` = permit-list). No port is published: an unthrottled metasearch proxy is an abuse magnet. |
| **Gotenberg** | PDF export | no | `GOTENBERG_URL=http://gotenberg:3000`; empty = PDF is not offered. Its Chromium is held to its own upload folder — a page can embed any URL and whatever it fetched would be printed into the PDF. |
| **OpenSearch** | BM25 leg | no | `FULLTEXT_PROVIDER=opensearch`, `OPENSEARCH_URL`; plain HTTP with the security plugin off, safe only because only api/worker/git can reach it. Turning it on later needs `POST /v1/ingestion/reindex` for pages indexed before it. |
| **Postgres, Redis, MinIO, ArcadeDB** | see §2 | **yes** | `DATABASE_URL` (app role, no DDL), `DATABASE_OWNER_URL` (migrations only), `REDIS_URL`, `S3_*` (including `S3_PUBLIC_ENDPOINT` for presigned URLs), `ARCADE_*`. |
| **Cloudflare Worker + Tailscale Funnel** | the public edge | current target only | `deploy/edge/worker.js` forwards to the Funnel URL and adds `X-Knowledge-*` headers; `EDGE_SECRET` must match the Worker binding, or Caddy ignores those headers. |
| **GitHub Container Registry** | images | **yes** | `ghcr.io/hrustalq/knowledge-*`; the cluster pulls with a read-only PAT configured cluster-wide. |
| **sealed-secrets key** | decrypting the committed secrets | **yes** | See below. |

### 6.1 Secrets

Configuration has **one source of truth: the GitHub `production` environment.**
`deploy.yml` renders its variables and secrets on every release and checks them
against `.env.production.example` *before* building: a key the template gives a
value to must be present, and no value may still say `CHANGE_ME`. It then seals
them offline with the cluster's public cert into two Secrets:

| Secret | Keys | Read by |
| --- | --- | --- |
| `knowledge-env` | everything else, including `DATABASE_URL`, `REDIS_URL`, `S3_*`, `ARCADE_*`, `EDGE_SECRET`, `SEARXNG_SECRET`, `SETTINGS_ENCRYPTION_KEY`, embedding and provider keys | every app pod (`envFrom`) |
| `knowledge-db-admin` | `POSTGRES_PASSWORD`, `DATABASE_OWNER_URL` | only `postgres` and the `migrate` Job |

A hand edit on the box or in the cluster survives exactly one release — the next
deploy re-renders and re-seals over it. Rotating a secret means changing it in
the environment and deploying.

Three things are not recoverable and need an explicit backup:

1. **The sealed-secrets private key** (`k8s/platform/sealed-secrets/` in the
   homelab repo, backed up in `.secrets/sealed-secrets-key.yaml`, to be kept
   *off* the Mac). Without it a rebuilt cluster cannot decrypt any SealedSecret
   committed there.
2. **`SETTINGS_ENCRYPTION_KEY`** — AES-256-GCM over stored AI-provider and
   connector credentials. Losing or changing it makes those rows permanently
   undecryptable.
3. **The Postgres superuser password / owner URL** — only in
   `knowledge-db-admin`, and only in the GitHub environment.

No secret is in this repository, and none should be added to it.

## 7. Operations

### 7.1 Deploy by tag

`TAGS DEPLOY, MERGES DO NOT.` Pushing `vX.Y.Z` — a tag on a commit that is an
ancestor of `origin/main` — is the deploy, in this order:

1. `deploy.yml` refuses anything that is not `vX.Y.Z` and not on `main`.
2. `images.yml` builds four `linux/amd64` images (api, api-git, web, admin),
   tagged with the ref and the commit SHA, pushed to GHCR.
3. The `production` environment is rendered, validated and sealed into
   `sealedsecret-env.yaml` / `sealedsecret-db-admin.yaml` at sync-wave `-2`.
4. `Caddyfile`, `searxng/settings.yml` and `deploy/postgres-roles.sh` are copied
   into `k8s/apps/knowledge/files/`, and every image the kustomization lists gets
   its `newTag` bumped.
5. The change is committed to `hrustalq/homelab` `main`; Argo CD notices within
   ~2 minutes, runs the `migrate` hook (roles initContainer, then
   `prisma migrate deploy`) and `minio-init` at wave 0, then rolls the app at
   wave 1.
6. The workflow polls `https://knowledge.hrustalq.dev` for up to 10 minutes —
   a smoke check, not proof that the new version is serving.

Rollback is a **retag**, not a rebuild: bump the versions back in the homelab
kustomization (or re-run the workflow for the old tag) and let Argo sync. The
database does not roll back; see 7.2.

### 7.2 Migrations and the expand/contract rule

`prisma migrate deploy` runs as the **schema owner** (`DATABASE_OWNER_URL`) in
the `migrate` Job, before the app rolls. The `roles` initContainer creates the
owner and app roles on every sync (idempotent, because Postgres only runs
`initdb` scripts on an empty volume), and the app connects as a non-superuser
that can read and write rows but not run DDL.

Migrations are forward-only, so **every migration must be runnable by the
previous release's image** ([versioning.md §Rollback](../versioning.md#rollback-and-the-expandcontract-rule)).
A destructive change is two releases: expand (add nullable, backfill, write both
shapes), then contract. With Prisma, dropping a column takes one more release
than that, because an unqualified `findMany` in the old image still selects the
dropped column.

Operationally: a rollback that crosses a contract release can fail to start, and
the fix is forward, not backward.

### 7.3 Probes

| Workload | Probe | What it proves |
| --- | --- | --- |
| `api` | `httpGet /` on 3000, readiness 10 s, startup 60 × 5 s | the event loop answers and the port is bound. `/` is the only `@Public()` liveness route and touches **no** store, so it reports healthy through a total database outage. |
| `web` | `httpGet /` on 5173, readiness 10 s | the SSR server answers. The image's own healthcheck probes `/favicon.svg` instead, so a probe cannot wake a full SSR render that calls the API. |
| `git` | `httpGet /` on 3002, readiness 15 s | the git process answers on its port. |
| `caddy` | `tcpSocket 80` | the proxy accepts connections. |
| `postgres` | `pg_isready` exec, readiness 5 s | the server accepts sessions. |
| `redis` | `redis-cli ping` exec, readiness 5 s | Redis answers. |
| `minio` | `httpGet /minio/health/ready` on 9000, readiness 5 s | the object store is ready, not merely up. |
| `arcadedb` | `httpGet /api/v1/ready` on 2480, readiness 10 s | the database finished opening. |
| `opensearch` | `httpGet /_cluster/health?wait_for_status=yellow`, readiness 15 s / 10 s timeout | the cluster is at least yellow (single-node, so yellow is green here). |
| `worker` | **none** | nothing. See below. |
| Jobs | none | they either exit 0 or retry (`backoffLimit` 3 for migrate, 5 for minio-init). |

**The worker gap.** `worker.main.ts` opens no HTTP listener, so there is no
probe to point at it. The compose file answers this with a healthcheck that asks
Redis which clients are blocked on the five BullMQ queues — strictly stronger
than `PING`, because it proves the processors attached. The k8s Deployment has
no equivalent: a worker that crashes restarts (the kubelet notices the container
exited), but a worker that is **running and not consuming** is invisible. Add a
`livenessProbe` that runs that same Redis `client list` check (or a Prometheus
alert on queue depth) before treating the namespace as observable.

### 7.4 Observability

- **Metrics:** kube-prometheus-stack in `monitoring`; every `ServiceMonitor`,
  `PodMonitor`, `PrometheusRule` and `ScrapeConfig` in any namespace is picked
  up. Prometheus keeps 15 days. Grafana at `grafana.apps.lan`; alerts go to
  Telegram. Nothing in the knowledge manifests defines an alert — the platform
  defaults (pod restarts, OOM kills, PVC pressure) are what you get.
- **Logs:** every process writes one JSON object per line to stdout and, with
  `OPS_JSONL_ENABLED=true`, a `ops-<service>-YYYY-MM-DD.jsonl` measurement stream
  to `LOG_DIR` (`/app/logs`, the `applogs` PVC). `OPS_SINK_ENABLED` also copies
  error-level records to `ops_events` in Postgres, which the admin console's
  Errors view reads. There is **no Loki** in the cluster — pod logs are lost when
  a pod is deleted; the PVC only holds the measurement stream.
- **Tracing:** a trace id links browser → API request → worker job, but it is a
  log field, not an exporter. There is no OpenTelemetry collector.
- **In-app health:** `GET /v1/admin/health` reads queues and probes fresh (≤ 2 s
  each) for the console; `GET /healthz` is a public liveness route that touches
  no store. Neither is a substitute for a real readiness check on the API.
- **Measurement data:** the backtest and `make tune` read the JSONL stream, so
  losing `applogs` loses historical measurements, not customer data.

### 7.5 Backups and restore order

**The honest state of the current deployment: there is no off-box backup.**
`hrustalq/homelab` lists "Off-box backups (target undecided)" and "Off-box
backups (single NVMe!)" as open items, and every volume is `local-path` on
`k3s-server`. A disk failure loses Postgres, MinIO, ArcadeDB and OpenSearch
together. What follows is what a deployment must do; treat it as a requirement,
not a description.

**Restore order** — metadata names the objects, derived stores are rebuilt last:

1. **Postgres** — `pg_dump -Fc` as the owner (`DATABASE_OWNER_URL` from
   `knowledge-db-admin`). Restore in this order: create the roles
   (`deploy/postgres-roles.sh`, the `migrate` hook's initContainer does it), load
   the dump, then let `prisma migrate deploy` confirm the schema is at head.
   Nothing else can be interpreted without these rows.
2. **MinIO** — the versioned `knowledge` bucket. Mirror it, keeping versions, to
   a second store; a file copy of the live volume is not a consistent backup of a
   running MinIO. Restore before serving: the API never streams bodies, so with
   MinIO missing every page opens with no bytes behind it and every upload fails.
3. **ArcadeDB** — scale the StatefulSet to 0 and copy the volume (there is no
   online backup in use), or skip it and reindex. Copying an LSM store while it
   is running is not safe, which is why the quiesce is part of the order.
4. **OpenSearch** — do not back up; recreate the index by reindexing. Its
   contents are derived from Postgres and ArcadeDB.
5. **Start the app** and run `POST /v1/ingestion/reindex` if any derived store
   was rebuilt rather than restored.

**What a reindex does not recover:** relation edges a person **retracted** or an
extraction **expired** live only in ArcadeDB — a rebuild recreates the edges the
current revisions imply and forgets that history. That makes ArcadeDB's volume
the one derived store worth copying if its edge history matters.

**Rebuildable without a backup:** the OpenSearch index, the git cache (cold
rebuild from Postgres + MinIO on the next clone/fetch), cached revision diffs,
and the web render caches. **Not rebuildable:**
Postgres, the MinIO bucket, the `SETTINGS_ENCRYPTION_KEY` and the sealed-secrets
private key — those are the four things to put in a backup today.

## 8. Sources

| File | Facts taken from it |
| --- | --- |
| [`docker-compose.prod.yml`](../../docker-compose.prod.yml) | The production service list, image pins and digests, `COMPOSE_PROFILES` behaviour, JVM flags (`-Xmx1g` ArcadeDB, `-Xms512m -Xmx512m` OpenSearch, 1,536m container cap), Gotenberg's ~2.5 GB image and Chromium allow-list, the worker's BullMQ healthcheck, `init: true`, no host bindings for datastores, the Worker → Funnel → Caddy `127.0.0.1:8088` edge, and the nine named volumes. |
| [`docker-compose.yml`](../../docker-compose.yml) | The developer stack: images and ports, the optional profiles (opensearch, searxng, mailpit, keycloak, gotenberg, learner), the absence of a heap cap on dev ArcadeDB, `host.docker.internal` for a host Ollama in the learner container. |
| [`Caddyfile`](../../Caddyfile) | Routes (`/api/*` strip, `/.well-known/oauth-*`, `/<bucket>/*` → MinIO with the signed Host, `/git/*`, `/admin/*`, SSR fallback), `auto_https off`, plain HTTP `:80`, and the `EDGE_SECRET` header-trust block. |
| [`.env.production.example`](../../.env.production.example) | Required vs optional keys, `AUTH_MODE=api-key`, `AUTH_SSO_ENABLED=false`, `MAIL_TRANSPORT=log`, `COMPOSE_PROFILES=gotenberg,opensearch`, `FULLTEXT_PROVIDER=opensearch`, `WEB_SEARCH_URL`, `WEB_ACCESS_MODE=open`, `EMBEDDINGS_PROVIDER=openai-compatible`, `EMBEDDINGS_MODEL=bge-m3`, `EMBEDDINGS_DIM=1024`, `SEARCH_MIN_COSINE=0.4`, `SETTINGS_ENCRYPTION_KEY`, the GitHub App and Figma/Plaud blocks, `S3_PUBLIC_ENDPOINT`, `API_PUBLIC_URL`. |
| [`.env.example`](../../.env.example) | The dev defaults: `EMBEDDINGS_PROVIDER=stub` at 384 with its measured 49% recall@1, `AUTH_MODE=none`, `MAIL_TRANSPORT=log`, `FULLTEXT_PROVIDER=none`, `WEB_ACCESS_MODE=off`, `ASSISTANT_PROVIDER=none`, every optional feature off. |
| [`Makefile`](../../Makefile) | `setup` = env-init → pnpm install → infra-up → db-migrate → build; `dev` = infra-up + `turbo run dev dev:worker`; the `--use-system-ca` probe and its 22.15 floor; the port numbers (3000, 5173, 5174, 3002); the `infra-up-*` profile targets; `make smoke`'s endpoint list. |
| [`package.json`](../../package.json) | `engines.node >= 22`; `packageManager: pnpm@10.30.1`. |
| [`Dockerfile.api`](../../Dockerfile.api) | Node 24.21.0 bookworm-slim; one image for api and worker (`dist/main`, `dist/worker.main`) and a `git-runtime` stage for `dist/git.main`; `ffmpeg`/`ffprobe`/`git` in the runtime; `--max-old-space-size=2560` only in the builder; healthcheck on `/`; `EXPOSE 3000` / `3002`; `PORT=3000`, `LOG_DIR=/app/logs`. |
| [`Dockerfile.web`](../../Dockerfile.web) | Node 24 SSR runtime, `PORT=5173`, no Prisma/openssl, healthcheck on `/favicon.svg`. |
| [`Dockerfile.admin`](../../Dockerfile.admin) | Static SPA served by Caddy on `:8080`, `/healthz`, built with the same pnpm pin. |
| [`deploy/postgres-roles.sh`](../../deploy/postgres-roles.sh) | The owner/app/superuser split, idempotency, and why an `initdb` script would not do. |
| [`deploy/edge/worker.js`](../../deploy/edge/worker.js) | The public edge: Funnel origin, the three `X-Knowledge-*` headers, `X-Edge-Host` routing, WebSocket pass-through, `redirect: 'manual'`. |
| [`.github/workflows/images.yml`](../../.github/workflows/images.yml) | Four `linux/amd64` images, GHCR tags by ref and SHA, the api-git build sharing the api's layers, registry-based build cache. |
| [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) | Tag shape and `main` ancestry checks, environment rendering, the `CHANGE_ME`/missing-key gate, sealing into two Secrets at wave `-2`, files synced to `k8s/apps/knowledge/files/`, the homelab commit, the 10-minute public-endpoint check, `concurrency: deploy-production`. |
| [`docs/versioning.md`](../versioning.md) | Rollback is a retag; migrations are forward-only; the expand/contract rule and Prisma's extra release for a column drop. |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | Release flow: bump on `dev`, promote to `main`, tag the commit that landed on `main`. |
| [`docs/architecture/03-ingestion.md`](03-ingestion.md), [`04-search-graph.md`](04-search-graph.md) | Why embeddings are on the write path, and how the BM25 leg fuses with the vector leg. |
| `~/Projects/homelab/k8s/apps/knowledge/{app,datastores,jobs,routes,networkpolicy,kustomization}.yaml` | Every request, limit and PVC in §2; replicas = 1; `local-path`; sync waves; probe paths and periods; the `knowledge-env` / `knowledge-db-admin` split; the routes and their `X-Edge-Host` match; default-deny ingress and the per-service allow rules; sealed config and image tags (v0.59.0 at the time of writing). |
| `~/Projects/homelab/k8s/README.md` | Platform services and their roles (Argo CD, sealed-secrets, MetalLB, Traefik + Gateway, monitoring with 15-day Prometheus, Tailscale operator), `ignoreDifferences` on replicas, the local-path and HTTPRoute sync-wave rules, the sealed-secrets key-backup warning, GHCR pull with a read-only PAT. |
| `~/Projects/homelab/README.md` | Node specs: `k3s-server` 6c/16G/300G, `k3s-gpu` 4c/8G/150G with the RTX 5070; single NVMe; off-box backups still an open item. |
| Docker Hub and GHCR registry APIs, read 2026-11-24 | The compressed image sizes in §3.2 (postgres 117 MB, redis 43 MB, minio 55 MB, mc 19 MB, ArcadeDB 302 MB, OpenSearch 1,040 MB, Caddy 25 MB, Gotenberg 697 MB, SearXNG 103 MB, mailpit 14 MB, `knowledge-api` 446 MB, `knowledge-api-git` 446 MB, `knowledge-web` 167 MB, `knowledge-admin` 25 MB). |
| The reference workstation (`uname`, `node --version`, `pnpm --version`, `make --version`, `git --version`, `du`) | macOS 15.3.1, Node v22.22.0, pnpm 10.30.1, GNU Make 3.81, git 2.39.5; a 64 MB working tree with 28 MB of `.git`; no `node_modules` yet, hence the install size is an estimate. |
