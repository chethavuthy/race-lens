<script setup lang="ts">
import { ref } from 'vue';
import type { Photo } from '../lib/api';

const props = defineProps<{
  items: { photo: Photo; score?: number }[];
  showScore?: boolean;
  /** Stagger the tiles in. Only for search results — never for the browse grid. */
  animate?: boolean;
}>();

const loaded = ref(new Set<string>());
// A photographer can revoke Drive access at any time. The thumbnail still works
// (it lives in R2) but the original 404s, so warn instead of letting the user
// click into a dead page.
const gone = ref(new Set<string>());

function label(item: { photo: Photo; score?: number }, i: number) {
  const n = `Photo ${i + 1} of ${props.items.length}`;
  return gone.value.has(item.photo.id)
    ? `${n} — original no longer available`
    : `${n} — open the full-size original on Google Drive`;
}
</script>

<template>
  <div class="photo-grid" :class="{ stagger: animate }">
    <figure v-for="(item, i) in items" :key="item.photo.id" :style="{ '--i': i }">
      <a
        class="photo-tile"
        :href="item.photo.original_url"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="label(item, i)">
        <!-- Skeleton sits underneath and is revealed by the image's own
             transparency until it decodes, so tiles never flash empty. -->
        <div v-if="!loaded.has(item.photo.id)" class="skeleton" style="position: absolute; inset: 0" />
        <img
          :src="item.photo.thumb_url ?? ''"
          :class="{ loaded: loaded.has(item.photo.id) }"
          alt=""
          loading="lazy"
          decoding="async"
          @load="loaded.add(item.photo.id)"
          @error="gone.add(item.photo.id); loaded.add(item.photo.id)" />
        <span v-if="showScore && item.score != null" class="badge">
          {{ item.score.toFixed(3) }}
        </span>
      </a>
      <figcaption v-if="gone.has(item.photo.id)" class="muted small" style="margin-top: 6px">
        No longer available from the photographer
      </figcaption>
    </figure>
  </div>
</template>
