<script setup lang="ts">
// Feature 06 (docs/features/06): dependency-free SVG graph with a small
// precomputed force layout (no animation — positions settle before render).
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { DocumentGraphResponse } from '@knowledge/contracts'
import { apiFetch } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'

const props = defineProps<{ documentId: string }>()
const router = useRouter()

const depth = ref(1)
const graph = ref<DocumentGraphResponse | null>(null)
const error = ref<string | null>(null)

const W = 860
const H = 560

interface Pos { x: number; y: number }
const positions = ref<Map<string, Pos>>(new Map())

function layout(g: DocumentGraphResponse) {
  const pos = new Map<string, Pos>()
  const cx = W / 2
  const cy = H / 2
  // Ring init by distance, deterministic angles.
  const byDistance = new Map<number, string[]>()
  for (const n of g.nodes) {
    byDistance.set(n.distance, [...(byDistance.get(n.distance) ?? []), n.id])
  }
  for (const [d, ids] of byDistance) {
    ids.forEach((id, i) => {
      if (d === 0) {
        pos.set(id, { x: cx, y: cy })
      } else {
        const angle = (2 * Math.PI * i) / ids.length + d * 0.5
        const r = 100 + d * 120
        pos.set(id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) })
      }
    })
  }
  // Force relaxation: pairwise repulsion + edge springs; root pinned.
  const ids = g.nodes.map((n) => n.id)
  for (let iter = 0; iter < 180; iter++) {
    const force = new Map<string, Pos>(ids.map((id) => [id, { x: 0, y: 0 }]))
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i])!
        const b = pos.get(ids[j])!
        let dx = a.x - b.x
        let dy = a.y - b.y
        const dist = Math.max(Math.hypot(dx, dy), 1)
        const rep = 5200 / (dist * dist)
        dx /= dist; dy /= dist
        force.get(ids[i])!.x += dx * rep
        force.get(ids[i])!.y += dy * rep
        force.get(ids[j])!.x -= dx * rep
        force.get(ids[j])!.y -= dy * rep
      }
    }
    for (const e of g.edges) {
      const a = pos.get(e.from)
      const b = pos.get(e.to)
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.max(Math.hypot(dx, dy), 1)
      const pull = (dist - 140) * 0.02
      const fx = (dx / dist) * pull
      const fy = (dy / dist) * pull
      force.get(e.from)!.x += fx
      force.get(e.from)!.y += fy
      force.get(e.to)!.x -= fx
      force.get(e.to)!.y -= fy
    }
    const damp = 0.85 ** (iter / 30)
    for (const id of ids) {
      if (id === props.documentId) continue // pin the root
      const p = pos.get(id)!
      const f = force.get(id)!
      p.x = Math.min(Math.max(p.x + f.x * damp, 40), W - 40)
      p.y = Math.min(Math.max(p.y + f.y * damp, 30), H - 30)
    }
  }
  positions.value = pos
}

async function load() {
  error.value = null
  graph.value = null
  try {
    const res = await apiFetch<DocumentGraphResponse>(
      `/v1/documents/${props.documentId}/graph?depth=${depth.value}`,
    )
    graph.value = res
    layout(res)
  } catch (e) {
    error.value = (e as Error).message
  }
}

const edgesWithPos = computed(() => {
  if (!graph.value) return []
  return graph.value.edges
    .map((e, i) => {
      const a = positions.value.get(e.from)
      const b = positions.value.get(e.to)
      return a && b ? { ...e, i, x1: a.x, y1: a.y, x2: b.x, y2: b.y } : null
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
})

function open(id: string, kind: string) {
  if (kind === 'document' && id !== props.documentId) void router.push(`/documents/${id}`)
}

onMounted(() => void load())
watch(depth, () => void load())
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-3">
      <label class="text-sm text-muted-foreground">Depth</label>
      <select v-model.number="depth" class="rounded-md border bg-background px-2 py-1.5 text-sm">
        <option :value="1">1 hop</option>
        <option :value="2">2 hops</option>
        <option :value="3">3 hops</option>
      </select>
      <span v-if="graph" class="text-xs text-muted-foreground">
        {{ graph.nodes.length }} nodes · {{ graph.edges.length }} edges · dashed = inferred
      </span>
    </div>

    <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
    <Skeleton v-else-if="!graph" class="h-96 w-full" />
    <p v-else-if="graph.edges.length === 0" class="text-sm text-muted-foreground">
      No relations yet — add frontmatter <code>relations:</code> or explicit relations, then index.
    </p>

    <svg v-else :viewBox="`0 0 ${W} ${H}`" class="w-full rounded-lg border bg-background">
      <g>
        <g v-for="e in edgesWithPos" :key="e.i">
          <line
            :x1="e.x1" :y1="e.y1" :x2="e.x2" :y2="e.y2"
            class="stroke-muted-foreground/40"
            :stroke-dasharray="e.extractor === 'inferred' ? '4 3' : undefined"
            stroke-width="1.2"
          />
          <text
            :x="(e.x1 + e.x2) / 2" :y="(e.y1 + e.y2) / 2 - 3"
            class="fill-muted-foreground text-[8px]"
            text-anchor="middle"
          >{{ e.type }}</text>
        </g>
      </g>
      <g v-for="n in graph.nodes" :key="n.id" :transform="`translate(${positions.get(n.id)?.x ?? 0}, ${positions.get(n.id)?.y ?? 0})`">
        <template v-if="n.kind === 'document'">
          <rect
            x="-56" y="-16" width="112" height="32" rx="8"
            :class="n.id === documentId ? 'fill-primary stroke-primary' : 'fill-background stroke-border hover:stroke-primary'"
            stroke-width="1.5"
            :style="{ cursor: n.id === documentId ? 'default' : 'pointer' }"
            @click="open(n.id, n.kind)"
          />
          <text
            y="4" text-anchor="middle"
            class="pointer-events-none text-[10px] font-medium"
            :class="n.id === documentId ? 'fill-primary-foreground' : 'fill-foreground'"
          >{{ n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label }}</text>
        </template>
        <template v-else>
          <circle r="7" class="fill-amber-500/80 stroke-amber-600" stroke-width="1" />
          <text y="20" text-anchor="middle" class="fill-muted-foreground text-[9px]">
            {{ n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label }}
          </text>
        </template>
      </g>
    </svg>
  </div>
</template>
