<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

withDefaults(defineProps<{ placeholder?: string; busy?: boolean; submitLabel?: string }>(), {
  placeholder: 'Write a comment (markdown supported)…',
  busy: false,
  submitLabel: 'Comment',
})
const emit = defineEmits<{ submit: [body: string] }>()

const body = ref('')

function submit() {
  const text = body.value.trim()
  if (!text) return
  emit('submit', text)
  body.value = ''
}
</script>

<template>
  <form class="space-y-2" @submit.prevent="submit">
    <Textarea v-model="body" :placeholder="placeholder" rows="3" class="font-mono text-sm" />
    <div class="flex justify-end">
      <Button type="submit" size="sm" :disabled="busy || !body.trim()">{{ submitLabel }}</Button>
    </div>
  </form>
</template>
