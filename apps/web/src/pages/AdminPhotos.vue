<script setup lang="ts">
/**
 * Visual debugger: every photo with its detected faces boxed and its read bib
 * printed on the box.
 *
 * Counts tell you 46 photos have no bib; they cannot tell you WHY. Seeing the
 * frame with nothing boxed, or a box over a runner whose number was misread, is
 * the difference between guessing at thresholds and knowing which stage failed.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../lib/api';

const props = defineProps<{ id: string }>();
type Row = Awaited<ReturnType<typeof api.admin.photos>>['photos'][number];

const ALL_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'no_face', label: 'No face' },
  { id: 'no_bib', label: 'No bib' },
  { id: 'has_bib', label: 'Has bib' },
] as const;

const filter = ref<(typeof ALL_FILTERS)[number]['id']>('all');

/**
 * An event with no bibs has no bib filters, no bib counts, and no bib copy.
 *
 * Offering "No bib" on a fun run is not a harmless extra tab: every photo
 * matches it, so the one filter that looks like a problem list is the whole
 * album, and "0 with no bib" reads as a failure of something that was never
 * switched on. Defaults to true so nothing flickers out while the event loads.
 */
const bibsEnabled = ref(true);
const FILTERS = computed(() =>
  ALL_FILTERS.filter((f) => bibsEnabled.value || !f.id.includes('bib')));
const photos = ref<Row[]>([]);
const cursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref<string | null>(null);
const zoom = ref<Row | null>(null);
const draft = ref('');
const saving = ref(false);
const editError = ref<string | null>(null);
const bibInput = ref<HTMLInputElement | null>(null);
// Which face box is being edited, and the value being typed into it.
const editingFace = ref<string | null>(null);
const faceDraft = ref('');
// An ARRAY, because the input it binds lives inside `v-for="f in zoom.faces"` and
// Vue sets ref_for on refs there. Typed as a single element, `faceInput.value` was
// the array itself, so `?.focus()` resolved to Array.prototype.focus — undefined —
// and threw a TypeError inside the setTimeout on every open. The editor still
// appeared, it just never focused or selected, so each correction cost an extra
// click and a manual clear. bibInput sits outside any v-for, which is why that one
// always worked and this one looked inexplicable.
const faceInput = ref<HTMLInputElement[]>([]);

async function startFace(f: { id: string; bib: string | null }) {
  editingFace.value = f.id;
  faceDraft.value = f.bib ?? '';
  // nextTick rather than a 30 ms guess at when the DOM has caught up.
  await nextTick();
  const el = faceInput.value[0];
  el?.focus();
  el?.select();
}

async function saveFace() {
  if (!editingFace.value || !zoom.value) return;
  saving.value = true; editError.value = null;
  try {
    await api.admin.setFaceBib(editingFace.value, faceDraft.value);
    editingFace.value = null; faceDraft.value = '';
    await patchPhoto(zoom.value.id);
  } catch (e: any) { editError.value = e.message; }
  finally { saving.value = false; }
}

/** Keep the zoomed row pointing at the live object after a reload. */
function syncZoom() {
  if (!zoom.value) return;
  const fresh = photos.value.find((p) => p.id === zoom.value!.id);
  if (fresh) zoom.value = fresh;
}

async function patchPhoto(id: string) {
  // Refresh just this photo rather than the whole page, so the grid position and
  // scroll survive a long run of corrections.
  //
  // This used to request page ONE with filter 'all' and grep the response, so any
  // photo past the first 24 was simply never in it: every correction from #25 on
  // silently did nothing visible, and the organizer would retype it. Keyset
  // pagination gives us an exact fetch instead — ask for rows after the PREVIOUS
  // photo in the current view, under the SAME filter, and the target is the first
  // row back.
  const i = photos.value.findIndex((p) => p.id === id);
  if (i < 0) return;
  const after = i > 0 ? photos.value[i - 1].id : null;

  let r: Awaited<ReturnType<typeof api.admin.photos>>;
  try {
    r = await api.admin.photos(props.id, after, filter.value);
  } catch (e: any) {
    // Was `.catch(() => null)`, which swallowed the reason entirely.
    editError.value = `Saved, but the view could not be refreshed: ${e.message}`;
    return;
  }

  const fresh = r.photos.find((p) => p.id === id);
  if (fresh) {
    photos.value[i] = fresh;
  } else if (filter.value !== 'all') {
    // The edit moved it out of the active filter — adding a bib under "No bib",
    // say. Dropping it is the truthful result; leaving a stale row is not.
    photos.value.splice(i, 1);
    if (zoom.value?.id === id) zoom.value = null;
    return;
  }
  syncZoom();
}

async function addBib() {
  const v = draft.value.trim();
  if (!v || !zoom.value) return;
  saving.value = true; editError.value = null;
  try {
    await api.admin.addBib(zoom.value.id, v);
    draft.value = '';
    await patchPhoto(zoom.value.id);
    bibInput.value?.focus();   // stay on the keyboard for the next number
  } catch (e: any) { editError.value = e.message; }
  finally { saving.value = false; }
}

async function reindexPhoto() {
  if (!zoom.value) return;
  saving.value = true; editError.value = null;
  try {
    await api.admin.reindexPhoto(zoom.value.id);
    editError.value = null;
    reindexNote.value = 'Re-indexing this photo — results appear in a minute or two.';
  } catch (e: any) { editError.value = e.message; }
  finally { saving.value = false; }
}
const reindexNote = ref<string | null>(null);

async function removeBib(key: string) {
  if (!zoom.value) return;
  saving.value = true; editError.value = null;
  try {
    await api.admin.removeBib(zoom.value.id, key);
    await patchPhoto(zoom.value.id);
  } catch (e: any) { editError.value = e.message; }
  finally { saving.value = false; }
}

function openZoom(p: Row) {
  zoom.value = p; draft.value = ''; editError.value = null; reindexNote.value = null;
  editingFace.value = null; faceDraft.value = '';
  setTimeout(() => bibInput.value?.focus(), 50);
}

/** Move between photos without leaving the editor. */
function step(delta: number) {
  if (!zoom.value) return;
  const i = photos.value.findIndex((p) => p.id === zoom.value!.id);
  const next = photos.value[i + delta];
  if (next) openZoom(next);
}

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

onMounted(async () => {
  measureColumns();
  window.addEventListener('resize', onResize, { passive: true });
  // Not fatal if it fails: the page still inspects photos, it just keeps the
  // bib controls it would otherwise hide.
  await api.admin.getEvent(props.id)
    .then((r) => { bibsEnabled.value = r.event.bibs_enabled !== false; })
    .catch(() => {});
  load(true);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(resizeFrame);
  window.removeEventListener('resize', onResize);
});
watch(filter, () => load(true));

/* ---------------------------------------------------------------- layout --
   Masonry, for the same reason the public grid uses it: these albums are a
   mixture of 3:2 landscape off a DSLR and 3:4 portrait off a phone, and a fixed
   grid row is as tall as its tallest tile — so every short tile sat above a
   band of empty background and half the screen showed nothing.

   Cropping to a uniform box is not an option HERE in particular: the face boxes
   are positioned as percentages of the tile, so a cover-crop would slide every
   box off the face it belongs to. Each tile keeps its own shape instead.

   Items are dealt into whichever column is currently shortest, using the stored
   pixel dimensions rather than measured ones — the balance is right on first
   paint, and appending a page cannot move anything already on screen. */
const COLUMN_BREAKPOINTS = [
  { min: 1101, columns: 4 },
  { min: 561, columns: 3 },
  { min: 0, columns: 2 },
];
const columnCount = ref(COLUMN_BREAKPOINTS[0].columns);

function measureColumns() {
  const w = window.innerWidth;
  columnCount.value = (COLUMN_BREAKPOINTS.find((b) => w >= b.min) ?? COLUMN_BREAKPOINTS[2]).columns;
}
let resizeFrame = 0;
function onResize() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(measureColumns);
}

const columns = computed<Row[][]>(() => {
  const n = columnCount.value;
  const cols: Row[][] = Array.from({ length: n }, () => []);
  const heights = new Array<number>(n).fill(0);
  for (const p of photos.value) {
    let shortest = 0;
    for (let i = 1; i < n; i++) if (heights[i] < heights[shortest]) shortest = i;
    cols[shortest].push(p);
    // Height relative to column width, so no measuring is needed. 2/3 is the
    // fallback for rows indexed before dimensions were stored.
    heights[shortest] += p.width && p.height ? p.height / p.width : 2 / 3;
  }
  return cols;
});

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
  <p v-if="bibsEnabled" class="lede">
    Green boxes are detected faces. The label is the bib read from that runner's
    torso; <strong>?</strong> means a face was found but no number could be read.
    Open a photo and <strong>click any label to type that runner's bib</strong> —
    Esc cancels, Enter saves.
  </p>
  <p v-else class="lede">
    Green boxes are detected faces. This event has no bib numbers, so runners find
    themselves by face alone — a photo with no box is one face search cannot return.
  </p>

  <div class="segmented" role="tablist" aria-label="Filter photos">
    <button v-for="f in FILTERS" :key="f.id" role="tab"
            :aria-selected="filter === f.id" @click="filter = f.id">{{ f.label }}</button>
  </div>

  <p v-if="error" class="notice err">{{ error }}</p>
  <p v-if="loading" class="muted"><span class="spinner" /> Loading…</p>

  <template v-else>
    <p class="muted small">
      Showing {{ summary.shown }} · {{ summary.noFace }} with no face<template
        v-if="bibsEnabled"> · {{ summary.noBib }} with no bib</template>
    </p>

    <div class="masonry">
      <div v-for="(col, ci) in columns" :key="ci" class="masonry-col">
      <figure v-for="p in col" :key="p.id">
        <button class="inspect-tile" @click="openZoom(p)">
          <img :src="p.thumb_url ?? ''" alt="" loading="lazy" decoding="async" />
          <span v-for="(f, i) in p.faces" :key="i" class="face-box"
                :style="{ left: pct(f.x), top: pct(f.y), width: pct(f.w), height: pct(f.h) }">
            <span v-if="bibsEnabled" class="face-tag">{{ f.bib || '?' }}</span>
          </span>
          <span v-if="!p.faces.length" class="no-face-flag">no face detected</span>
        </button>
        <figcaption class="muted small" style="margin-top: 4px">
          <template v-if="bibsEnabled">
            <span v-if="p.bibs.length">
              bibs: {{ p.bibs.map((b) => b.bib).join(', ') }}
            </span>
            <span v-else>no bib read</span>
            ·
          </template>
          <a :href="p.original_url" target="_blank" rel="noopener" class="mono-id">original</a>
        </figcaption>
      </figure>
      </div>
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
      <div class="inspect-tile zoom">
        <img :src="zoom.thumb_url ?? ''" alt="" />
        <span v-for="f in zoom.faces" :key="f.id" class="face-box interactive"
              :class="{ editing: editingFace === f.id, tagged: !!f.bib }"
              :style="{ left: pct(f.x), top: pct(f.y), width: pct(f.w), height: pct(f.h) }">
          <button v-if="editingFace !== f.id" class="face-tag" :disabled="saving"
                  :title="f.bib ? 'Change this runner\'s bib' : 'Add this runner\'s bib'"
                  @click.stop="startFace(f)">{{ f.bib || '?' }}</button>
          <form v-else class="face-edit" @click.stop @submit.prevent="saveFace()">
            <input ref="faceInput" v-model="faceDraft" inputmode="numeric" pattern="[0-9]*"
                   autocomplete="off" placeholder="bib"
                   @keydown.esc="editingFace = null" />
          </form>
        </span>
      </div>
      <!-- editor -->
      <div class="card">
        <div class="row" style="border-bottom: 0; padding-top: 0">
          <div class="row-main small">
            <strong>{{ zoom.faces.length }}</strong> faces detected
          </div>
          <div class="row-actions">
            <button :disabled="!photos.length" @click="step(-1)" title="Previous photo">←</button>
            <button :disabled="!photos.length" @click="step(1)" title="Next photo">→</button>
            <button :disabled="saving" title="Run detection and OCR on this photo again"
                    @click="reindexPhoto">
              <span v-if="saving" class="spinner" /> Re-index
            </button>
            <a class="btn file-btn" :href="zoom.original_url" target="_blank" rel="noopener">Original</a>
            <button @click="zoom = null">Close</button>
          </div>
        </div>

        <div v-if="bibsEnabled" class="bib-chips">
          <span v-for="b in zoom.bibs" :key="b.bib_key" class="bib-chip" :class="b.source">
            {{ b.bib }}
            <span class="muted small">{{ b.source === 'manual' ? 'you' : (b.conf ?? 0).toFixed(2) }}</span>
            <button class="chip-x" :disabled="saving" title="Remove this bib"
                    @click="removeBib(b.bib_key)">×</button>
          </span>
          <span v-if="!zoom.bibs.length" class="muted small">No bib on this photo yet.</span>
        </div>

        <form v-if="bibsEnabled" style="display: flex; gap: var(--s-3); margin-top: var(--s-3)"
              @submit.prevent="addBib()">
          <input ref="bibInput" v-model="draft" inputmode="numeric" pattern="[0-9]*"
                 autocomplete="off" placeholder="Type a bib number and press Enter" />
          <button class="primary" type="submit" :disabled="saving || !draft.trim()">
            <span v-if="saving" class="spinner" /> Add
          </button>
        </form>
        <p v-if="editError" class="notice err" style="margin-top: var(--s-3)">{{ editError }}</p>
        <p v-if="reindexNote" class="notice" style="margin-top: var(--s-3)">{{ reindexNote }}</p>
        <p v-if="bibsEnabled" class="muted small" style="margin: var(--s-3) 0 0">
          Numbers you add or remove are kept as corrections — re-indexing will not overwrite them.
        </p>
      </div>
    </div>
  </div>
</template>
