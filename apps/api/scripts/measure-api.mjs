// A scripted API session for the performance baseline (#1242).
//
// Run against a built API (`node dist/main.js`) and worker started with
// OPS_JSONL_ENABLED=true and OPS_QUERY_COUNT_ENABLED=true, under AUTH_MODE=none,
// then read the stream with `make backtest ARGS="--report"`. Writes PERF_PAGES
// typical pages into a throwaway project (the e2e flow: create → finalize →
// poll indexed), then repeats the main reads and searches PERF_RUNS times.
// The project and its pages are left in place so the run can be inspected.
const api = process.env.PERF_API_URL ?? 'http://localhost:3000'
const workspaceId = process.env.PERF_WORKSPACE_ID
const longDocumentId = process.env.PERF_DOCUMENT_ID
if (!workspaceId || !longDocumentId) throw new Error('Set PERF_WORKSPACE_ID and PERF_DOCUMENT_ID')
const runs = Number(process.env.PERF_RUNS ?? 20)
const pages = Number(process.env.PERF_PAGES ?? 10)
const queries = ['performance budget', 'how does search ranking work', 'merge request approvals', 'deploy the worker', 'page permissions', 'release process', 'embedding model', 'glossary terms', 'connector sync', 'database migration']

async function call(method, path, body) {
  const res = await fetch(api + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : undefined
}

// About 4 KB, eight sections: a typical page, not a stress fixture.
const typicalPage = (i) =>
  Array.from({ length: 8 }, (_, s) => `## Section ${s + 1}\n\nPage ${i} explains step ${s + 1} of the deployment runbook: the worker drains its queue, migrations run against the previous image, and the search index is rebuilt for the pages whose embeddings changed. ${'Operators check the health endpoint before and after. '.repeat(4)}`).join('\n\n')

const { project } = await call('POST', '/v1/projects', { workspaceId, name: `perf-walk ${new Date().toISOString()}` })
const created = []
for (let i = 0; i < pages; i++) {
  const doc = await call('POST', '/v1/documents', {
    workspaceId,
    projectId: project.projectId,
    title: `Runbook step ${i}`,
    content: { mode: 'inline', format: 'markdown', text: typicalPage(i) },
  })
  created.push(doc.documentId)
}
const deadline = Date.now() + 5 * 60_000
for (const id of created) {
  for (;;) {
    const doc = await call('GET', `/v1/documents/${id}`)
    const status = doc.revision?.status
    if (status === 'indexed') break
    if (status === 'failed') throw new Error(`ingestion failed for ${id}`)
    if (Date.now() > deadline) throw new Error(`not indexed in 5 min: ${id} (${status})`)
    await new Promise((r) => setTimeout(r, 500))
  }
}
console.error(`indexed ${created.length} pages in project ${project.projectId}`)

const q = (o) => new URLSearchParams(o).toString()
for (let run = 0; run < runs; run++) {
  await call('GET', '/v1/me')
  await call('GET', `/v1/projects?${q({ workspaceId })}`)
  await call('GET', `/v1/documents/tree?${q({ workspaceId, projectId: project.projectId })}`)
  await call('GET', `/v1/documents?${q({ workspaceId })}`)
  await call('GET', `/v1/documents/${longDocumentId}`)
  await call('GET', `/v1/documents/${longDocumentId}/content`)
  await call('GET', `/v1/documents/${longDocumentId}/revisions`)
  await call('GET', `/v1/documents/${created[run % created.length]}/content`)
  const query = queries[run % queries.length]
  await call('POST', '/v1/search', { workspaceId, query, mode: 'hybrid', limit: 10 })
  await call('POST', '/v1/search', { workspaceId, query, mode: 'hybrid', limit: 10, groupBy: 'page' })
}
console.error(`done: ${runs} read rounds`)
