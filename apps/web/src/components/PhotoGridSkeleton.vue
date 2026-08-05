<script setup lang="ts">
withDefaults(defineProps<{ count?: number }>(), { count: 12 });
</script>

<template>
  <!-- Placeholder tiles hold the grid's real shape while photos load, so the
       page does not reflow underneath the user when they arrive. -->
  <div class="photo-grid" aria-hidden="true">
    <div v-for="i in count" :key="i" class="skeleton skeleton-tile" />
  </div>
</template>
