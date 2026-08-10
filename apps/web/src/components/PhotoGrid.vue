<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Photo } from '../lib/api';
import type { GridItem } from '../lib/grid';
import { clockTime } from '../lib/format';

const props = withDefaults(
  defineProps<{
    items: GridItem[];
    showScore?: boolean;
    /** Stagger the tiles in. Only for search results — never for the browse grid. */
    animate?: boolean;
    /**
     * Crop each tile to the matched face instead of showing the whole frame.
     * Only meaningful when items carry a bbox.
     */
    crop?: boolean;
    /** Show the capture time under each tile. */
    showTime?: boolean;
  }>(),
  { showScore: false, animate: false, crop: false, showTime: false },
);

/* ------------------------------------------------------------ columns --
   Items are dealt into whichever column is currently shortest, and the deal is
   recomputed from the full list every time. That sounds wasteful and is the
   whole point: the algorithm is deterministic and order-dependent, so the
   placement of the first N items is identical before and after item N+1
   arrives. Nothing already on screen can move when a page is appended.

   Predicted height, not measured height. Every photo carries its real pixel
   dimensions, so a column's height is known before a single image has decoded —
   which is what lets the balance be right on first paint instead of settling
   after the images land. */
const BREAKPOINTS = [
  { min: 1101, columns: 4 },
  { min: 561, columns: 3 },
  { min: 0, columns: 2 },
];

const columnCount = ref(BREAKPOINTS[0].columns);

function measureColumns() {
  const w = window.innerWidth;
  columnCount.value = (BREAKPOINTS.find((b) => w >= b.min) ?? BREAKPOINTS[2]).columns;
}

let frame = 0;
function onResize() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(measureColumns);
}

onMounted(() => {
  measureColumns();
  window.addEventListener('resize', onResize, { passive: true });
});
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  window.removeEventListener('resize', onResize);
});

interface Placed { item: GridItem; index: number }

const columns = computed<Placed[][]>(() => {
  const n = columnCount.value;
  const cols: Placed[][] = Array.from({ length: n }, () => []);
  // Height relative to column width, so it is unit-free and needs no measuring.
  const heights = new Array<number>(n).fill(0);

  props.items.forEach((item, index) => {
    let shortest = 0;
    for (let i = 1; i < n; i++) if (heights[i] < heights[shortest]) shortest = i;
    cols[shortest].push({ item, index });
    const { width, height } = item.photo;
    // A cropped tile is always square; otherwise fall back to 3:2, the ratio
    // the tile itself falls back to when a row predates the stored dimensions.
    heights[shortest] += props.crop
      ? 1
      : width && height
        ? height / width
        : 2 / 3;
  });

  return cols;
});

const loaded = ref(new Set<string>());
// Thumbnails live in OUR R2 bucket. If one fails to load that is our problem —
// a bad key, a misconfigured base URL, a network blip — and NOT evidence that
// the photographer revoked anything. Blaming them for a config bug is exactly
// what happened when R2_PUBLIC_BASE was relative and every tile in production
// read "No longer available from the photographer".
//
// Whether a Drive *original* has been revoked cannot be detected from here at
// all: it is a cross-origin link we never fetch.
const failed = ref(new Set<string>());

// A photo row with no thumb key never renders an image element, so no error
// event ever fires — mark it up front or its tile sits on the skeleton forever.
props.items.forEach((it) => { if (!it.photo.thumb_url) failed.value.add(it.photo.id); });

/**
 * Reserve the tile's exact box before the image decodes.
 *
 * This is what makes a masonry column stable: without it every image resolves
 * at its natural height and the columns re-flow underneath the reader's thumb.
 * width/height come off Drive's imageMediaMetadata at index time and are
 * already on the Photo the client receives, so it costs nothing.
 */
function ratio(p: Photo): string {
  return p.width && p.height ? `${p.width} / ${p.height}` : '3 / 2';
}

/**
 * Position the image inside a square tile so the matched face fills it.
 *
 * Around nine faces are detected per frame in these albums, so a result is
 * usually a pack of runners and the person cannot tell at thumbnail size which
 * one matched. The search already tells us — it returns the winning face's box
 * — and nothing was using it.
 *
 * PAD pulls back from the box so the crop is a head-and-shoulders portrait
 * rather than a tight cut at the hairline. The region is then clamped inside
 * the frame, because a face near an edge would otherwise crop past it and leave
 * a transparent wedge.
 */
const PAD = 2.4;

function cropStyle(item: GridItem): Record<string, string> | null {
  const { width: W, height: H } = item.photo;
  const box = item.bbox;
  if (!box || !W || !H) return null;

  const [x, y, bw, bh] = box;
  if (!(bw > 0 && bh > 0)) return null;

  const side = Math.min(Math.max(bw, bh) * PAD, W, H);
  const half = side / 2;
  const cx = Math.min(Math.max(x + bw / 2, half), W - half);
  const cy = Math.min(Math.max(y + bh / 2, half), H - half);

  return {
    width: `${(W / side) * 100}%`,
    left: `${(-(cx - half) / side) * 100}%`,
    top: `${(-(cy - half) / side) * 100}%`,
  };
}

/** True only when this item can actually be cropped. */
function cropped(item: GridItem): boolean {
  return props.crop && cropStyle(item) !== null;
}

function label(item: GridItem, i: number) {
  const n = `Photo ${i + 1} of ${props.items.length}`;
  return failed.value.has(item.photo.id)
    ? `${n} — preview unavailable`
    : `${n} — open the full-size original on Google Drive`;
}
</script>

<template>
  <div class="masonry" :class="{ stagger: animate }">
    <div v-for="(col, c) in columns" :key="c" class="masonry-col">
      <figure v-for="{ item, index } in col" :key="item.photo.id" :style="{ '--i': index }">
      <a
        :class="cropped(item) ? 'crop-tile' : 'photo-tile'"
        :style="cropped(item) ? undefined : { '--ar': ratio(item.photo) }"
        :href="item.photo.original_url"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="label(item, index)">
        <!-- Skeleton sits underneath and is revealed by the image's own
             transparency until it decodes, so tiles never flash empty. -->
        <div v-if="!loaded.has(item.photo.id)" class="skeleton" style="position: absolute; inset: 0" />
        <!-- Rendered only when there is a real URL. An empty src re-requests
             the current page in some browsers and always paints a broken-image
             box; a thumb we do not have is a failed tile, not a blank one. -->
        <img
          v-if="item.photo.thumb_url"
          :src="item.photo.thumb_url"
          :style="cropped(item) ? cropStyle(item)! : undefined"
          :class="{ loaded: loaded.has(item.photo.id) }"
          alt=""
          loading="lazy"
          decoding="async"
          @load="loaded.add(item.photo.id)"
          @error="failed.add(item.photo.id); loaded.add(item.photo.id)" />
        <span v-if="showScore && item.score != null" class="badge">
          {{ item.score.toFixed(3) }}
        </span>
      </a>

      <figcaption v-if="failed.has(item.photo.id)" class="muted small" style="margin-top: 6px">
        Preview unavailable — the full-size photo may still open
      </figcaption>
      <figcaption v-else-if="showTime && clockTime(item.photo.taken_at)" class="tile-cap">
        <span class="t">{{ clockTime(item.photo.taken_at) }}</span>
        <span v-if="cropped(item)">cropped to you</span>
        </figcaption>
      </figure>
    </div>
  </div>
</template>
