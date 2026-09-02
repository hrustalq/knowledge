<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
</script>

<template>
  <div class="mx-auto mt-24 max-w-md text-center">
    <p class="text-6xl font-bold text-muted-foreground">403</p>
    <h1 class="mt-3 text-xl font-semibold">You don't have access to this page</h1>
    <p class="mt-2 text-sm text-muted-foreground">
      Ask a workspace admin to grant you the required role, or switch to an account that has it.
    </p>
    <Button class="mt-6" as-child>
      <RouterLink to="/documents">Back to documents</RouterLink>
    </Button>
  </div>
</template>
