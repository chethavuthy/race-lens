<script setup lang="ts">
const props = withDefaults(defineProps<{ count?: number }>(), { count: 12 });

// The grid this stands in for is masonry, so a column of identical boxes would
// settle into a noticeably different silhouette than the photos replacing them.
// These are the two ratios the albums actually contain: 3:2 off a DSLR, 3:4 off
// a phone.
const RATIOS = ['3 / 2', '3 / 4', '3 / 2', '3 / 2', '3 / 4', '3 / 2'];

// Mirrors PhotoGrid's structure so the placeholder occupies the same shape the
// real grid will. Fixed at three columns: this is a brief loading state, not
// something worth wiring a resize listener to.
const COLUMNS = 3;
const columns = Array.from({ length: COLUMNS }, (_, c) =>
  Array.from({ length: Math.ceil(props.count / COLUMNS) }, (_, r) => c + r * COLUMNS).filter(
    (i) => i < props.count,
  ),
);
</script>

<template>
  <!-- Placeholder tiles hold the grid's real shape while photos load, so the
       page does not reflow underneath the user when they arrive. -->
  <div class="masonry" aria-hidden="true">
    <div v-for="(col, c) in columns" :key="c" class="masonry-col">
      <div
        v-for="i in col" :key="i"
        class="skeleton"
        :style="{ aspectRatio: RATIOS[i % RATIOS.length] }" />
    </div>
  </div>
</template>
