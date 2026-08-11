<script setup lang="ts">
/**
 * Visual debugger: every photo with its detected faces boxed and its read bib
 * printed on the box.
 *
 * Counts tell you 46 photos have no bib; they cannot tell you WHY. Seeing the
 * frame with nothing boxed, or a box over a runner whose number was misread, is
 * the difference between guessing at thresholds and knowing which stage failed.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
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
    Green boxes are detected faces. The label is the bib read from that runner's
    torso; <strong>?</strong> means a face was found but no number could be read.
    Open a photo and <strong>click any label to type that runner's bib</strong> —
    Esc cancels, Enter saves.
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
        <button class="inspect-tile" @click="openZoom(p)">
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

        <div class="bib-chips">
          <span v-for="b in zoom.bibs" :key="b.bib_key" class="bib-chip" :class="b.source">
            {{ b.bib }}
            <span class="muted small">{{ b.source === 'manual' ? 'you' : (b.conf ?? 0).toFixed(2) }}</span>
            <button class="chip-x" :disabled="saving" title="Remove this bib"
                    @click="removeBib(b.bib_key)">×</button>
          </span>
          <span v-if="!zoom.bibs.length" class="muted small">No bib on this photo yet.</span>
        </div>

        <form style="display: flex; gap: var(--s-3); margin-top: var(--s-3)" @submit.prevent="addBib()">
          <input ref="bibInput" v-model="draft" inputmode="numeric" pattern="[0-9]*"
                 autocomplete="off" placeholder="Type a bib number and press Enter" />
          <button class="primary" type="submit" :disabled="saving || !draft.trim()">
            <span v-if="saving" class="spinner" /> Add
          </button>
        </form>
        <p v-if="editError" class="notice err" style="margin-top: var(--s-3)">{{ editError }}</p>
        <p v-if="reindexNote" class="notice" style="margin-top: var(--s-3)">{{ reindexNote }}</p>
        <p class="muted small" style="margin: var(--s-3) 0 0">
          Numbers you add or remove are kept as corrections — re-indexing will not overwrite them.
        </p>
      </div>
    </div>
  </div>
</template>
