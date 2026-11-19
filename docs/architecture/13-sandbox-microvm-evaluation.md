# 13 — smolvm microVMs for sandboxed agent and code execution

**Status:** decided, 2026-11-19

**Issue:** [#1253](https://github.com/hrustalq/knowledge/issues/1253)

**Decision:** **defer.** Do not adopt smolvm, or any microVM runtime, today.

No workload in the platform executes untrusted code. The ones that parse
untrusted bytes in a native binary (ffmpeg, git) have gaps that ordinary process
and pod hardening closes at a fraction of the cost, and the one sandbox that
needs no hardware virtualization on our nodes is gVisor, not a microVM. No spike
issue is filed, because the verdict is not positive. Reopen the question when a
feature that **runs** untrusted code is accepted (see
[Reopening criteria](#reopening-criteria)); the spike for that day is sketched
at the end.

## What was evaluated

[smolvm](https://github.com/smol-machines/smolvm) (Apache-2.0) runs each workload
in a libkrun microVM, on Linux KVM or on macOS Apple Silicon. It offers network
off by default with an egress allowlist, secret placeholders substituted outside
the guest, S3/MinIO mounts, snapshots and branches, and a Node SDK with no
daemon. It is not CelestoAI SmolVM, a Firecracker-based Python SDK.

The question is whether moving a workload into a microVM reduces a risk we
actually carry, at a cost our deployment can absorb. So the starting point is an
inventory of where the API, worker, git and learner processes touch untrusted
code or bytes today. The deployment facts come from the homelab repo
(`tofu/vms.tf`, `k8s/apps/knowledge/`), and the vendor facts from each project's
own documentation, linked inline.

## Which workloads would move, ranked by risk reduced

A search of `apps/api/src` and `packages/` for `child_process`, `spawn`,
`execFile`, `node:vm`, `new Function`, `eval` and `worker_threads` finds four
non-test call sites: `memos/audio.ts`, `git/git.controller.ts`,
`git/git-repo.service.ts` and `connectors/code-research/code-tools.ts`. Nothing
builds a repo, runs its hooks or package scripts, or runs user JavaScript. There
is no code-interpreter or shell tool for agents, and stdio MCP plugins are
refused precisely because "stdio would mean spawning processes on the API host"
(`ai/mcp-client.service.ts`).

| Rank | Workload | Untrusted input, and who supplies it | Executes it? | Today's containment | What a microVM would add |
| --- | --- | --- | --- | --- | --- |
| 1 | **ffmpeg / ffprobe on memo audio** (worker, `memos/audio.ts`) | Audio bytes from any workspace editor, or a Plaud download. The format is checked by extension and content type, but ffmpeg probes the real container, so its whole demuxer and decoder surface sees attacker bytes. | No. It parses them in the largest native parser in the stack. | `MEMO_MAX_BYTES` (200 MiB), a `mkdtemp` directory removed in `finally`, runs as `node`. No `timeout` on any `execFile` call. The worker pod holds every secret in `knowledge-env` and can reach Postgres, Redis, MinIO and ArcadeDB. | The most: a decoder exploit would land in a VM with no secrets and no network, instead of in the process that holds the database credentials. |
| 2 | **git on pushed and fetched packs** (git pod, `git-push.service.ts`, `git.controller.ts`) | Packfiles and pkt-lines from any key holder: reader role to fetch, editor role to push. | No. `index-pack`, `cat-file`, `rev-list` and `diff-tree` parse them; `upload-pack` serves them. No working tree, no hooks (push is our own receive-pack in Node), only mode `100644` accepted. | 256 MiB push cap measured after gunzip, an inflated-blob budget per push, object ids validated before argv, a quarantine object directory. No spawn timeouts. Each child inherits `process.env`, and the pod mounts all of `knowledge-env`. | Similar in kind to ffmpeg, smaller in likelihood: git's pack parser is mature and heavily fuzzed, and the inputs come from authenticated key holders. |
| 3 | **Gotenberg's Chromium** (own pod, feature 45) | HTML the web renderer builds from user pages, plus our bundled mermaid over user diagram text (`securityLevel: 'strict'`). | Runs **our** JavaScript over untrusted text. | Already a separate pod with no `envFrom`, ingress only from the worker, `--chromium-allow-list=^file:///tmp/.*` so it fetches nothing. Egress is open. | Little. The boundary already exists; denying its egress is the remaining step. |
| 4 | **Code research `code_*` tools** (API and worker, features 27, 31, 46, 51) | Files of an external repo an admin connected, plus model-chosen paths, globs and regexes. | No. The repo arrives as a zip over `safeFetch`, is unzipped in memory with `fflate`, and is read; `code_outline` parses with web-tree-sitter (wasm). `node:vm` runs only a constant script, to make a model-supplied regex interruptible within 2 s. | Download and inflate caps, per-file and per-call output caps, `..` refused, output wrapped untrusted. | Nothing until a feature runs the repo's code. This is the workload most likely to need a sandbox **later** (running a repo's tests or build). |
| 5 | **API test runner** (worker, `API_TEST_RUNNER_MODE`) | Plans and fixtures authored by users. | No. It sends HTTP and matches declarative captures; Postman scripts are generated for export only, never run server-side. | Off by default, source policies plus `safeFetch`, no redirects, 15 s / 1 MB caps, targets limited to the spec's servers. | Nothing: the risk is SSRF, which `safeFetch` handles. |
| 6 | **In-process parsers** (import's mammoth, unpdf, exceljs, fflate; linkedom and JSDOM for web pages; `@scalar/openapi-parser`) | Uploaded files and fetched pages. | No; parsed in the API or worker heap. JSDOM never runs page scripts. | Size caps; `IMPORT_PARSE_TIMEOUT_MS` is a `Promise.race` timer and cannot stop a synchronous parse that blocks the event loop. | A microVM is far heavier than the proportionate fix, which is a child process or worker thread with a kill timeout. |

The common thread: the risk reduced is **containment of a parser exploit**, not
containment of executed code. For that, the first three cheaper steps below
remove most of the exposure before any sandbox runtime is involved.

## Fit with our deployment

**Production nodes are VMs.** `k3s-server` (6 cores, 16 GiB) and `k3s-gpu`
(4 cores, 8 GiB) are Proxmox VMs on one AMD Ryzen 7 9800X3D host, both with
`cpu { type = "host" }` (`tofu/vms.tf`). A microVM inside a pod therefore needs:

1. **Nested virtualization on the Proxmox host.** CPU type `host` is the
   prerequisite Proxmox documents; whether `kvm_amd` has `nested` enabled on the
   host, and whether `/dev/kvm` exists inside the k3s VMs, is **not verified**
   for this record. Check with `cat /sys/module/kvm_amd/parameters/nested` on the
   host and `ls -l /dev/kvm` on each node. Nested guests cannot be
   live-migrated, which costs nothing on a single host. Source:
   [Proxmox: Nested Virtualization](https://pve.proxmox.com/wiki/Nested_Virtualization).
2. **A way to reach `/dev/kvm` from Kubernetes.** The homelab declares no
   RuntimeClass and no device plugin, and the knowledge pods run with default
   security contexts. There are two paths:
   - **A RuntimeClass.** smolvm ships a containerd shim (`io.containerd.smolvm.v2`)
     and a k3s installer, which must be re-run after every k3s upgrade; its own
     `critest` run reports 82 passed and 7 failed. Source:
     [smolvm deploy/README](https://github.com/smol-machines/smolvm/blob/main/deploy/README.md).
     This runs a whole pod in a VM: it would isolate a separate ffmpeg pod, not a
     call made from the worker.
   - **The SDK inside the worker pod.** smolvm does not document this. It needs
     `/dev/kvm` in the pod: either `privileged: true` plus a `hostPath` (a
     privileged worker holding every secret is a worse posture than today), or a
     device plugin. The KVM plugin from KubeVirt has been archived since 2020;
     [squat/generic-device-plugin](https://github.com/squat/generic-device-plugin)
     can advertise any `/dev` path but has no KVM example.
3. **A compatible runtime image.** The `smolmachines` Node addon is prebuilt for
   darwin-arm64 and linux x64/arm64 with glibc ≥ 2.34. Our `node:24-bookworm-slim`
   base (glibc 2.36) qualifies; an Alpine image would not. Source:
   [smol SDK README](https://github.com/smol-machines/smol/blob/main/sdk/node/README.md).

**Dev on macOS** is the one place smolvm fits without friction: the SDK runs
natively on Apple Silicon through Hypervisor.framework. That does not help
production, where the nodes are the hard part.

## Cost

| Item | smolvm figure | What it means here |
| --- | --- | --- |
| Cold start | "<200 ms to agent ready", boot "in under a second" (vendor claim, [README](https://github.com/smol-machines/smolvm)) | Negligible for memos (one ffmpeg pass per upload, minutes of work) and for git fetch/push. |
| Memory | Guest default is half the host up to 8 GiB, elastic through a virtio balloon; the RuntimeClass declares `podFixed` overhead of 160Mi and 250m CPU ([runtimeclass.yaml](https://github.com/smol-machines/smolvm/blob/main/deploy/kubernetes/runtimeclass.yaml)) | Affordable per VM, but `k3s-server` already hosts every datastore in 16 GiB; a concurrency cap would be required, not optional. |
| Image | Any OCI image, including `docker save` archives | A guest carrying ffmpeg and git is roughly the runtime OS layer `Dockerfile.api` already ships (the comment there puts the apt layer at about 170 MB), built and pinned separately. |
| Operations | Shim or `/dev/kvm` exposure on each node, a Proxmox host setting, re-running the installer per k3s upgrade, unsigned releases ([SECURITY.md](https://github.com/smol-machines/smolvm/blob/main/SECURITY.md)) | A new component in the node's trusted base, owned by one person, tracking a project that ships several releases a week. |

## Comparison

Same criteria for every option. Facts were checked against each project's
documentation on 2026-11-19.

| | smolvm | Firecracker | gVisor | Kata Containers | microsandbox | E2B (hosted) |
| --- | --- | --- | --- | --- | --- | --- |
| Needs KVM on the node | Yes (nested on our nodes) | Yes | **No** (systrap platform) | Yes (nested) | Yes (nested) | No (hosted); yes to self-host |
| Native on macOS dev | Yes, Apple Silicon | No | No | No | Yes, Apple Silicon | Hosted only |
| k3s path | Containerd shim RuntimeClass + installer; SDK-in-pod undocumented | Only through Kata's `kata-fc` (firecracker-containerd archived 2026-11-10) | RuntimeClass `runsc` via a containerd config template | kata-deploy Helm chart, explicit k3s support | Privileged pod + `hostPath` `/dev/kvm`, or a KVM device plugin | One-node "Embed" self-host |
| Cold start | "<200 ms" (vendor) | ≤ 125 ms to guest init (spec) | Not documented (no VM boot) | Not documented | "<100 ms" on M1 (vendor) | "milliseconds" (snapshot resume) |
| Memory per sandbox | Balloon; 160Mi pod overhead | ≤ 5 MiB VMM overhead (spec) | Not documented | Not documented | Not documented | 512 MiB default (billing docs) |
| Network default / egress control | **Off**; host, pattern and CIDR allowlists, optional per-flow mediator | VMM only, n/a | Kubernetes NetworkPolicy | Kubernetes NetworkPolicy | **On**; domain rules checked against DNS answers | **On**; `allowOut` domains, `denyOut` CIDRs |
| Secret placeholders | Yes (TLS interception, headers only) | No | No | No | Yes (TLS interception) | Not found |
| Node integration | `smolmachines` napi addon, in-process | None (HTTP API) | None (transparent to the pod) | None (transparent to the pod) | `microsandbox` napi addon, Node ≥ 22 | `e2b` HTTP SDK |
| Maturity | v1.35.4, first release 2026-01-28 | v1.18.0, since 2017 | Weekly releases, since 2018 | 4.4.0, since 2017 | v0.7.16, self-described beta | SDK v2.64; runtime open source |
| License / cost | Apache-2.0 | Apache-2.0 | Apache-2.0 | Apache-2.0 | Apache-2.0 | Paid usage (~$0.11/h for 2 vCPU / 512 MiB) |

Sources:
- [smolvm security model](https://github.com/smol-machines/smolvm/blob/main/docs/security-model.md)
- [Firecracker specification](https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md)
- [firecracker-containerd](https://github.com/firecracker-microvm/firecracker-containerd)
- [gVisor platforms](https://gvisor.dev/docs/architecture_guide/platforms/)
- [gVisor containerd quick start](https://gvisor.dev/docs/user_guide/containerd/quick_start/)
- [Kata runtime classes](https://github.com/kata-containers/kata-containers/blob/main/docs/kata-deploy-runtimeclasses.md)
- [microsandbox](https://github.com/superradcompany/microsandbox)
- [microsandbox network docs](https://docs.microsandbox.dev/security/network.md)
- [E2B pricing](https://e2b.dev/pricing)
- [E2B internet access docs](https://docs.e2b.dev/network/internet-access.md)
- [k3s alternative runtimes](https://docs.k3s.io/advanced#alternative-container-runtime-support): k3s auto-detects crun, nvidia and wasm runtimes, not Kata or runsc.

What the comparison settles:

- **gVisor is the only option that needs neither nested virtualization nor
  `/dev/kvm`** on our Proxmox VMs. Its overhead falls on syscall-bound work;
  ffmpeg is mostly CPU-bound, and git's file I/O pays the Gofer cost. It does
  nothing for macOS dev, which needs no sandbox anyway.
- **smolvm and microsandbox are the only ones native on Apple Silicon,** and
  both are libkrun-based. smolvm is the better fit of the two for us: network is
  off by default, where microsandbox's is on, and microsandbox calls itself beta.
- **Firecracker's Kubernetes path narrowed to Kata** when firecracker-containerd
  was archived on 2026-11-10, so it brings Kata's requirements plus a devmapper
  thin-pool.
- **E2B is ruled out for our data, not for its technology.** Memo audio is
  recorded speech, and connected repos are private code: sending either to a
  third-party sandbox is a new data flow the memo and connector designs never
  accepted. Its self-hosted Embed is one node by design and needs KVM, so it
  inherits every node requirement above.

## Maturity risk

smolvm is about ten months old: repo created 2025-12-18, first release v0.1.0 on
2026-01-28, now v1.35.4 after 204 releases. Eight releases shipped between
2026-11-13 and 2026-11-18. v1.35.0 alone changed behaviour in several places:
PID 1 now runs as root, a start with supplied-only credentials and no interceptor
now errors instead of silently intercepting, the Docker Engine API is opt-in, and
credential-host requests drop `Range`
([release notes](https://github.com/smol-machines/smolvm/releases/tag/v1.35.0)).
The "1.x" number does not mean a stable interface.

Its security story also has two layers to trust, and the lower one says so
itself. libkrun's README: "The VM boundary does not restrict host resources
exposed through devices. Limit the VMM's host permissions and exposed paths."
TSI networking "uses the VMM's host network access"
([libkrun](https://github.com/libkrun/libkrun#readme)). smolvm confines its
`smol-vmm` helper with seccomp and Landlock on Linux, but its releases are not
signed and no third-party audit was found. Adopting it means pinning a version,
reading every release note before an upgrade, and re-proving the boundary each
time. That is a standing cost for one maintainer, paid to contain parsers that
cheaper means already contain.

## What to do instead

These do not depend on this record's verdict and could ship in any order. None of
them is a new runtime.

1. **Bound every child process.** Give the `execFile` calls in `memos/audio.ts`
   and the git spawns in `git-repo.service.ts` / `git.controller.ts` a `timeout`
   and a kill on overrun, sized from the existing ceilings (`MEMO_MAX_MINUTES`,
   the push cap).
2. **Stop handing children the whole environment.** Pass ffmpeg and git a
   minimal `env` (`PATH`, `HOME`, the `GIT_*` they need) instead of
   `process.env`. Today any code execution in either binary reads every secret in
   `knowledge-env`.
3. **Harden the pods.** `allowPrivilegeEscalation: false`, drop all
   capabilities, `seccompProfile: RuntimeDefault`, `runAsNonRoot`, and an egress
   NetworkPolicy. Gotenberg needs no egress at all; git needs the datastores and
   DNS only. Today ingress is default-deny, but egress is open for every pod
   (`networkpolicy.yaml`).
4. **If ffmpeg still warrants more, move it, not the worker.** A small media pod
   with no `envFrom`, reading the object from MinIO by a presigned URL and
   writing chunks back the same way, separates the parser from the secrets.
   That pod is also the natural first candidate for a `runsc` RuntimeClass,
   which needs no KVM.

## Reopening criteria

Reopen this question when a feature that **executes** untrusted code is accepted:

- an agent tool that runs code or a shell;
- running a connected repo's tests, build or package scripts (the natural next
  step for code research or the repo wiki);
- user-written scripts in the API test runner, such as Postman pre-request or
  test scripts executed server-side.

At that point, a container boundary plus gVisor stops being enough for code that
is hostile by design, and smolvm's network-off default and secret placeholders
become directly useful. Re-check its release cadence and signing first.

### The spike, when reopened

One workload, in a throwaway branch and one node:

1. On the Proxmox host, confirm `kvm_amd` nested is on and `/dev/kvm` exists in
   `k3s-server`; record the `smolvm` version pinned.
2. Install the shim with smolvm's k3s installer and create its RuntimeClass.
   Run one job: a pod with no `envFrom` and network off, executing the
   candidate workload (a repo's test command, or the code tool's runner) over
   an input mounted read-only.
3. Measure cold start, steady memory, and the node's headroom with three VMs at
   once. Confirm from inside the guest that the network is unreachable and that
   no host path beyond the mount is visible.
4. Upgrade k3s once on the test node and confirm the installer re-run is the
   only step needed.
5. Write the result back into this record as an amendment, with a go/no-go for
   the feature that triggered it.
