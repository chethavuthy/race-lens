<script setup lang="ts">
/**
 * Visual debugger: every photo with its detected faces boxed and its read bib
 * printed on the box.
 *
 * Counts tell you 46 photos have no bib; they cannot tell you WHY. Seeing the
 * frame with nothing boxed, or a box over a runner whose number was misread, is
 * the difference between guessing at thresholds and knowing which stage failed.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../lib/api';

const props = defineProps<{ id: string }>();
type Row = Awaited<ReturnType<typeof api.admin.photos>>['photos'][number];

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'no_face', label: 'No face' },
  { id: 'no_bib', label: 'No bib' },
  { id: 'has_bib', label: 'Has bib' },
] as const;

const filter = ref<(typeof FILTERS)[number]['id']>('all');
const photos = ref<Row[]>([]);
const cursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref<string | null>(null);
const zoom = ref<Row | null>(null);

async function load(reset = false) {
  if (reset) { photos.value = []; cursor.value = null; loading.value = true; }
  else loadingMore.value = true;
  try {
    const r = await api.admin.photos(props.id, reset ? null : cursor.value, filter.value);
    photos.value = reset ? r.photos : [...photos.value, ...r.photos];
    cursor.value = r.cursor;
    error.value = null;
  } catch (e: any) { error.value = e.message; }
  finally { loading.value = false; loadingMore.value = false; }
}

onMounted(() => load(true));
watch(filter, () => load(true));

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const summary = computed(() => {
  const p = photos.value;
  return {
    shown: p.length,
    noFace: p.filter((x) => !x.faces.length).length,
    noBib: p.filter((x) => !x.bibs.length).length,
  };
});
</script>

<template>
  <p style="margin: 0 0 var(--s-4)">
    <RouterLink :to="`/admin/e/${id}`" class="muted small">← Event</RouterLink>
  </p>
  <h1>Inspect photos</h1>
  <p class="lede">
    Green boxes are detected faces. The label on a box is the bib read from that
    runner's torso; <strong>?</strong> means a face was found but no number could be read.
  </p>

  <div class="segmented" role="tablist" aria-label="Filter photos">
    <button v-for="f in FILTERS" :key="f.id" role="tab"
            :aria-selected="filter === f.id" @click="filter = f.id">{{ f.label }}</button>
  </div>

  <p v-if="error" class="notice err">{{ error }}</p>
  <p v-if="loading" class="muted"><span class="spinner" /> Loading…</p>

  <template v-else>
    <p class="muted small">
      Showing {{ summary.shown }} · {{ summary.noFace }} with no face · {{ summary.noBib }} with no bib
    </p>

    <div class="photo-grid" style="grid-template-columns: repeat(auto-fill, minmax(260px, 1fr))">
      <figure v-for="p in photos" :key="p.id">
        <button class="inspect-tile" @click="zoom = p">
          <img :src="p.thumb_url ?? ''" alt="" loading="lazy" decoding="async" />
          <span v-for="(f, i) in p.faces" :key="i" class="face-box"
                :style="{ left: pct(f.x), top: pct(f.y), width: pct(f.w), height: pct(f.h) }">
            <span class="face-tag">{{ f.bib || '?' }}</span>
          </span>
          <span v-if="!p.faces.length" class="no-face-flag">no face detected</span>
        </button>
        <figcaption class="muted small" style="margin-top: 4px">
          <span v-if="p.bibs.length">
            bibs: {{ p.bibs.map((b) => b.bib).join(', ') }}
          </span>
          <span v-else>no bib read</span>
          ·
          <a :href="p.original_url" target="_blank" rel="noopener" class="mono-id">original</a>
        </figcaption>
      </figure>
    </div>

    <p v-if="!photos.length" class="muted">No photos match this filter.</p>
    <div v-if="cursor" style="margin-top: var(--s-5)">
      <button :disabled="loadingMore" @click="load(false)">
        <span v-if="loadingMore" class="spinner" /> Load more
      </button>
    </div>
  </template>

  <!-- zoom -->
  <div v-if="zoom" class="zoom-backdrop" @click="zoom = null">
    <div class="zoom-inner" @click.stop>
      <div class="inspect-tile" style="max-height: 76vh">
        <img :src="zoom.thumb_url ?? ''" alt="" />
        <span v-for="(f, i) in zoom.faces" :key="i" class="face-box"
              :style="{ left: pct(f.x), top: pct(f.y), width: pct(f.w), height: pct(f.h) }">
          <span class="face-tag">{{ f.bib || '?' }}</span>
        </span>
      </div>
      <div class="row" style="border-bottom: 0">
        <div class="row-main small">
          <strong>{{ zoom.faces.length }}</strong> faces ·
          bibs: {{ zoom.bibs.length ? zoom.bibs.map((b) => `${b.bib} (${(b.conf ?? 0).toFixed(2)})`).join(', ') : 'none' }}
        </div>
        <div class="row-actions">
          <a class="btn file-btn" :href="zoom.original_url" target="_blank" rel="noopener">Open original</a>
          <button @click="zoom = null">Close</button>
        </div>
      </div>
    </div>
  </div>
</template>
