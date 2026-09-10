<script setup lang="ts">
/**
 * Choose a picture (docs/features/23).
 *
 * The control is the face itself, not a file field beside one: what you are
 * changing is the thing you are looking at, so the preview *is* the button.
 * A file input cannot be styled, so a hidden one is triggered from a real
 * button — and clicking a file input is the one thing that must open the OS
 * picker rather than anything of ours.
 *
 * Projects get an emoji row underneath. A project tile renders at 20px in the
 * sidebar, where an emoji stays crisp and a downscaled screenshot turns to
 * mud — and picking one is two clicks against finding, cropping and uploading
 * an image. Whichever is set clears the other: a project has one face, and two
 * would leave every renderer choosing.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ImagePlus, Loader2, Trash2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { useAvatarUpload } from './use-avatar-upload'

const props = withDefaults(
  defineProps<{
    /** Route prefix the upload hangs off: `/v1/me` or `/v1/projects/<id>`. */
    base: string
    /** Whether a picture is currently set — decides if Remove is offered. */
    hasImage: boolean
    disabled?: boolean
  }>(),
  { disabled: false },
)

const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const { busy, progress, upload, remove, accept } = useAvatarUpload(() => props.base)
const fileEl = ref<HTMLInputElement | null>(null)

async function onPick(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Cleared unconditionally, so choosing the same file twice in a row (after a
  // failure, say) still fires a change event.
  input.value = ''
  if (!file) return
  if ((await upload(file)) !== undefined) emit('changed')
}

async function onRemove() {
  if (await remove()) emit('changed')
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <input
      ref="fileEl"
      type="file"
      :accept="accept"
      class="hidden"
      @change="onPick"
    />
    <Button
      type="button"
      variant="outline"
      size="sm"
      :disabled="disabled || busy"
      @click="fileEl?.click()"
    >
      <Loader2 v-if="busy" class="size-3.5 animate-spin" />
      <ImagePlus v-else class="size-3.5" />
      {{ busy ? t('avatar.uploading', { pct: progress }) : t(hasImage ? 'avatar.replace' : 'avatar.upload') }}
    </Button>
    <Button
      v-if="hasImage"
      type="button"
      variant="ghost"
      size="sm"
      class="text-muted-foreground"
      :disabled="disabled || busy"
      @click="onRemove"
    >
      <Trash2 class="size-3.5" />
      {{ t('common.remove') }}
    </Button>
    <slot />
  </div>
</template>
