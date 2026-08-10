<script setup lang="ts">
withDefaults(defineProps<{ count?: number }>(), { count: 12 });

// The grid this stands in for is masonry, so a column of identical boxes would
// settle into a noticeably different silhouette than the photos replacing them.
// These are the two ratios the albums actually contain: 3:2 off a DSLR, 3:4 off
// a phone.
const RATIOS = ['3 / 2', '3 / 4', '3 / 2', '3 / 2', '3 / 4', '3 / 2'];
</script>

<template>
  <!-- Placeholder tiles hold the grid's real shape while photos load, so the
       page does not reflow underneath the user when they arrive. -->
  <div class="masonry" aria-hidden="true">
    <figure v-for="i in count" :key="i">
      <div class="skeleton" :style="{ aspectRatio: RATIOS[i % RATIOS.length] }" />
    </figure>
  </div>
</template>
