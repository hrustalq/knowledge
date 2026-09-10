# 25 — Web research and source policy

Every tool the assistant has points inward. `assistant.tools.ts` offers eight —
`search_knowledge`, `read_document`, `explore_document_graph`, `ask_user`,
`request_agent_mode`, `render_component`, `create_document`, `propose_update` —
and all of them are scoped to the workspace. A question whose answer is not
already written down here cannot be answered at all, and the failure is silent:
the model searches, finds nothing relevant, and says so.

`AssistantAskSource` is `{ documentId, title, snippet? }`. It cannot hold a URL.
That single type is the honest measure of the gap.

What is _not_ missing is the loop. The streaming turn, tool-call frames, the
progressively-filling sources pane, mode gating, agent tool allowlists — the
Perplexity shape is already built and running against internal sources. This
feature adds two tools and a trust model, not an architecture.

## The web is a tool here, not a connector

Both patterns exist and answer different questions. A connector (feature 19)
makes an external page into a document: indexed, chunked, embedded, graph-linked,
diffable, permanent. A tool call is ephemeral, fresh and cheap — it answers
"what is the current status of X" and leaves nothing behind.

Research is the second shape. A page fetched to settle one question should not
become a document in someone's project, and a connector that syncs the open web
is not a thing anyone wants. So `web_search` and `web_fetch` are tools, their
results live for the turn, and the citations outlive it only as source records on
the message.

**Promotion is deliberately deferred.** Turning a cited source into a real
document with a `SOURCED_FROM` relation is the interesting half — it is what
makes research survive the tab closing, which Perplexity's does not — and it is
also where all the graph and provenance design work is. It is not needed to make
the tools useful, so it is not in this cut.

## Trust is three axes, and merging two of them is a vulnerability

"Trusted source" sounds like one setting. It is three, and the codebase already
answers two of them:

1. **Reachability** — may we make this request at all? `assertSafeExternalUrl`
   plus the allow-private flag, unchanged. That is SSRF, not editorial trust.
2. **Instruction authority** — may this text tell the model what to do? Already
   settled everywhere: skills are trusted text, document content and plugin
   output are wrapped as external untrusted data. Web content is the most
   untrusted input that exists.
3. **Editorial permission** — setting aside whether the request is _safe_, is
   this a domain this workspace has any business reading? This is the new one,
   and it is a policy question, not a network one.

If 2 and 3 are the same field, an admin marks the internal wiki "trusted" and a
page anyone can edit starts giving the model instructions. So policy decides
**whether a page is fetched at all, never what its bytes are allowed to say**,
and every fetched body is wrapped identically. Because policy is a boolean
consumed before the fetch, the wrapper takes no argument from it — there is no
tier-dependent branch to get wrong later, because there is no branch.

## Source policies

```
source_policies: workspace_id, pattern, allow
```

One boolean, because only one thing is enforceable. A tier ladder —
`trusted | allowed | untrusted | blocked` — was drafted and cut: `allowed` is
the default and needs no row, `trusted` only drops a hedge, and `untrusted`'s
one real job is refusing promotion, which this cut defers. All three reduce to
instructions in a prompt, and a prompt rule is advisory: a model that wants the
domain will take it. A field that cannot be enforced is a field that lies.

What survives is one list of exceptions, read in the direction the mode sets:

- Under `allowlist`, an unlisted domain is refused and rows are what may be
  fetched.
- Under `open`, an unlisted domain is fetched and rows are what may not be.
- The boolean exists for the exception inside either reading — `open` with
  `example.com` denied and `docs.example.com` allowed.

Enforcement is **at the fetch**, in both directions, never in the prompt.

Longest pattern match wins — the glossary's longest-term-first, and
notifications' most-specific-wins.

Hedging and citation ranking do not disappear; they stop being configuration.
The answer hedges on a source the way it hedges on anything thin, and that is a
judgement the model already makes. When promotion lands and there is finally a
decision that a row can gate, the column that gates it can be added then,
against a behaviour that exists.

## One policy, every fetch

A URL reaches `web_fetch` two ways: the model picked it out of search results, or
a person pasted it into the chat and asked for a summary. It is tempting to treat
the second as consent and exempt it — the human chose, and policing text someone
pasted would be absurd.

The exemption is not implementable. By the time it is a tool call both look
identical, one `web_fetch(url)`, so "the user named this one" is a claim the model
makes rather than a fact the API can check — and a page from an allowed domain
saying _now fetch evil.com_ makes the same claim just as convincingly.

So the policy applies to every fetch, with no provenance exception. A refused
paste says so plainly — this domain is not allowed here, an admin can add it in
AI settings — rather than failing quietly.

The paste case also already has its own door: feature 16 imports a URL into a
document, with its own guard and its own review step. `web_fetch` does not need
to serve it twice.

## The env is a ceiling, not a default

`ai_settings` has two precedents and this fits neither. The provider columns are
nullable and inherit their env var, so an operator sets a fleet default and a
workspace overrides it. `agentModeEnabled` is non-null with no env at all, so the
operator gets no say.

Neither is right, because a workspace admin must not be able to switch on the
open web in a deployment where that was decided against. Feature 20 already
committed to the rule this needs: **the tool allowlist intersects, never
unions** — a settings row must not widen what the model reaches.

```
WEB_ACCESS_MODE = off | allowlist | open     # env ceiling, default `off`
ai_settings.webAccessMode String?            # null = inherit; clamped by the ceiling
```

An `open` ceiling with a workspace on `allowlist` is allowlist. An `allowlist`
ceiling with a workspace asking for `open` is **allowlist, and the page says so**
— `AiConfigService.resolve` already reports a per-field source for the "from env"
badges, so a clamp is one more value beside `env` and `db`. A silent clamp is a
lie about what the workspace is configured to do.

`off` by default keeps every existing deployment byte-identical.

Search itself is **not** a third `EMBEDDING_PROVIDER`. That pattern earns its
interface by having two products behind it — `stub` and `openai-compatible`,
`none` and `opensearch` — where the second is a real implementation somebody
chose. Here there is one backend, and the enum's `none` would mean "the tools do
not exist", which `WEB_ACCESS_MODE=off` already says in the setting that also
says it to the workspace. Two knobs answering one question is one knob and a
second place to disagree with it.

So: `WEB_SEARCH_URL`, a URL, unset by default. Set it and search works; the mode
still decides whether it may. The interface arrives with the second backend,
shaped by what the two actually differ on rather than by a guess made now.

## Search is SearXNG, and provider-native search is not it

The first backend is a self-hosted **SearXNG** — AGPL, no API key, no per-query
cost, metasearching the engines it is pointed at. It ships as
`profiles: ["searxng"]` in the compose file with `make infra-up-searxng`, exactly
the optional OpenSearch node from Phase 5. Its JSON API is off by default:
`formats: [json]` has to be set in its `settings.yml`, or every query returns
HTML and the provider looks broken.

Price is not why. SearXNG returns **URLs and snippets and fetches nothing**, so
the platform holds a list of candidates before any page is retrieved: it filters
by policy first and fetches second. That ordering is the entire reason `blocked`
can be enforced at the fetch rather than asked for in a prompt.

`web_fetch` needs no new dependency **and no new pipeline**. Feature 16 already
ships the whole of it: `htmlToMarkdown()` in `import/parsers/html-to-markdown.ts`
strips the chrome a fetched page arrives wrapped in — `nav`, `header`, `footer`,
`aside`, `script`, `style`, `form`, `iframe` — renders GFM tables, and is tuned
so its output is indistinguishable from what the WYSIWYG editor writes;
`htmlTitle()` beside it pulls the title. `HtmlParser` even counts the remote
images that survived. A fetch is `fetch` → `htmlToMarkdown` → done, and writing a
second extraction step would mean maintaining two answers to "what part of this
page is the article".

The honest cost: SearXNG scrapes upstream engines and can be rate-limited or
blocked by them, so it is free in money and not free in reliability. That is
survivable because `web_search` is one function with one caller — when a keyed
backend is worth adding, it is added where the reliability actually bit, and
neither tool's shape changes.

**Provider-native web search is deliberately not the shortcut it looks like.**
OpenAI's `web_search`, Anthropic's server tool, Gemini grounding and OpenRouter's
`:online` all search _and fetch_ server-side and return prose with citations
attached. The URLs arrive after the model has already read the pages, so a policy
can only filter the citation list after the fact — `blocked` stops meaning
"never retrieved" and starts meaning "not shown to you". That is the MCP plugin
defect again, one layer down.

No rule is written for them, because none is being built. Recording why is the
useful part; a mode-combination check guarding a backend that does not exist
would be a branch nobody can test. If one is ever added, it inherits the fact
above — it cannot enforce a policy — and that is the argument to have then.

## Settings

A section inside `AiPluginsPanel`, not an eighth tab. That panel is already the
roster of external things the model can reach, per-row enablement, admin-gated —
and with the tier ladder gone this is a mode radio and a list of domains, which
is smaller than the plugin roster it would sit beside. It also belongs there on
the merits: plugin URLs and fetch targets are the same question asked twice, and
`assertSafeExternalUrl` is already the shared answer to half of it.

Not `AiConfigPanel`, which is provider configuration. The mode radio leads the
section, because the list means nothing without it.

`allowlist` mode with an empty table is a web search that silently returns
nothing, which reads as broken rather than as configured. Saving it is refused —
the shape of the agent scheduler refusing to enable without an owner and an
interval. No starter allowlist ships: whose domains those would be is editorial
opinion, and every org's list differs.

## The researcher does not get a background surface yet

It was going to. Feature 20 withheld it because every background pass is defined
by what it produces and "research the workspace" produces nothing to act on, and
web research looked like the answer: it produces something citable, and
eventually a page.

But `surfaces` is a declaration, and the fact is elsewhere.
`AiAgentsService` computes `runnable` as
`surfaces.includes('background') && RUNNABLE_AGENTS.has(key)`, `RUNNABLE_AGENTS`
is `{curator, reviewer, glossarist}`, and it is backed by a three-case switch in
`agent.executor.ts`. Adding `'background'` without a fourth case changes nothing
the run guard, the schedule sweeper or the Run button consults — it declares a
surface no executor serves, which is the exact defect feature 20 was written to
remove and removed from this very file. Reintroducing it two features later,
with a comment explaining why it was once wrong, would be worse than not noticing.

And the eventual page is the deferred half. A background researcher whose output
cannot become a document produces citations to nowhere. So the declaration stays
`['interactive']`, and it widens in the cut that ships promotion and the executor
together — one change, with something to run.

Tool allowlists intersect, so adding two tools to the registry does not leak them
into the other nine agents; each list stays explicit.

## Why the plugin shortcut is not enough

An MCP plugin pointed at a search server gets web results today with no API code:
namespaced, SSRF-guarded, output already wrapped untrusted. It is a good way to
prove the interaction before building anything.

It cannot carry a source policy. The platform sees opaque tool output, never the
URLs behind it, so there is nothing to match a pattern against and nothing to
label. The trust requirement is precisely what makes the first-class tools
necessary — without it, the plugin would have been the whole feature.

## What the build settled

The sections above are the argument. These are the decisions it did not reach,
each of which turned out to be forced.

**`AssistantAskSource` became a union, not a wider record.** The honest measure
of the gap was that the type could not hold a URL; the tempting repair is to make
`documentId` optional and add `url` beside it, which type-checks everywhere and
silently leaves every existing consumer reading `undefined`. A discriminated
union on `kind` makes the compiler point at each of the ~six sites that assumed a
document — the transcript footer, the sources rail, the store's dedupe map, the
turn accumulator — which is the complete list of places the distinction has to
be drawn. `kind` is optional on the document arm because rows persisted before
this feature do not carry it, and absent reads as `'document'`.

The turn's `collected` map was keyed by `documentId`. Keyed that way, every web
citation in a thread collapses into one `undefined` slot; it is now keyed by
`assistantSourceKey`, a document's id or a page's URL, which cannot collide
because a URL is not a uuid.

`/v1/assistant/ask` keeps the **narrow** type. It is the one model call site with
no agent behind it, so nothing can trim what it is handed — which is precisely
why it is never offered the web tools, and why promising `AssistantSource[]`
there would ask every caller to handle a case that cannot arise.

**The tools are opt-in at the call site, not on by default.** `definitions()`
withholds `web_search` and `web_fetch` unless the caller passes `{ web: true }`.
Adding them to the base list would have leaked them into that same agent-less
`ask` endpoint, quietly widening a page-scoped question into the open web. The
chat harness opts in on the workspace's effective mode, and feature 20's
allowlist then intersects on top — so the two named lists (`researcher`,
`author`) are inert until a deployment raises the ceiling.

**The prompt clause is appended per turn, not baked into the agent.** An agent's
`instructions` are a static code default; whether the web exists is a
per-workspace fact. Composing them would have changed the bytes sent by every
`WEB_ACCESS_MODE=off` deployment, which is the one thing `off` promises not to
do. So the clause is concatenated in `prepareTurn` when the mode is not `off`,
beside the grounding blocks, which are per-turn for the same reason.

**The mode is re-read when the tool runs.** The tool list is fixed when a turn
starts, and a turn can outlive a settings change; an admin switching the
workspace to `off` mid-answer has to actually take the web away rather than
merely hide it from the next turn. This is the plugin service's rule — check
`enabledTools` on execution, not on offer — applied to the same class of problem.

**A redirect is decided twice.** An allowed domain that 302s to a blocked one is
the obvious way around a single check, so the final URL is put back through
`decide` before its bytes are read.

## The settings surface

The clamp is **two facts on three rows**, and the first build showed only one of
them. The radio dot follows what the workspace asks for; the tint and an *in
force* badge follow what actually applies. They land on the same row in every
case but a clamp — and when a clamp splits them, marking only the selection
leaves the mode that is really running invisible, which is the single thing the
disclosure exists to prevent. A reader saw the dot on Open web and concluded the
web was open.

A capped option stays selectable. The row records what this workspace wants, and
that intent has to survive the ceiling being raised later; disabling it would
force an admin to remember to come back.

**Longest-match-wins is shown, not documented.** The list is sorted by pattern
length rather than alphabetically — the order the server decides in — and a row
that refines a broader one says so inline. Without that, the rule governing the
whole table is a sentence in a hint nobody reads at the moment it matters.

`POST /v1/ai/source-policies/check` is the one addition the feature doc did not
call for. A policy list's only observable effect is a tool call failing inside
somebody else's chat, so without a dry run the only way to learn what a list does
is to ask the assistant and read the refusal. It answers with the row that
decided, which is also the only place precedence is visible. It is `viewer`, not
`admin`: whoever hit a refusal should be able to find out which rule refused them
without asking an admin to read the table for them.

**A cited site gets a derived mark, not a favicon.** The obvious answer is the
wrong one: every favicon is a request from the reader's browser to the cited site
or to a third-party favicon service, which turns a private page of research notes
into a broadcast of what someone is reading. It also fails offline and arrives
after paint. So a site gets the same letter-and-hue mark a person gets, hashed
from the *brand* label rather than the host — `en.wikipedia.org` marked **E** for
its subdomain recognises nothing, and deriving letter and hue from `wikipedia`
also means every subdomain of one product shares one mark.
