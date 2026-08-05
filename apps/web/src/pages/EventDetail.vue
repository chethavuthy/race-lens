<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, ApiError, type EventSummary, type Photo } from '../lib/api';
import { embedLargestFace, loadModels, NoFaceError, type LoadPhase } from '../lib/face';
import PhotoGrid from '../components/PhotoGrid.vue';
import PhotoGridSkeleton from '../components/PhotoGridSkeleton.vue';
import { plural } from '../lib/format';

const props = defineProps<{ slug: string }>();

type Tab = 'bib' | 'selfie' | 'upload';
const TABS: { id: Tab; label: string }[] = [
  { id: 'bib', label: 'Bib' },
  { id: 'selfie', label: 'Selfie' },
  { id: 'upload', label: 'Upload' },
];
const tab = ref<Tab>('bib');
const tabRefs = ref<HTMLButtonElement[]>([]);

const event = ref<EventSummary | null>(null);
const browse = ref<Photo[]>([]);
const cursor = ref<string | null>(null);
const loadingEvent = ref(true);
const loadingMore = ref(false);
const loadError = ref<string | null>(null);

const results = ref<{ photo: Photo; score?: number }[] | null>(null);
const searchedBy = ref<Tab | null>(null);
const searching = ref(false);
const searchError = ref<string | null>(null);
const searchNote = ref<string | null>(null);

const bib = ref('');

const video = ref<HTMLVideoElement | null>(null);
const stream = ref<MediaStream | null>(null);
const cameraError = ref<string | null>(null);

const modelPhase = ref<LoadPhase | null>(null);
const modelsReady = ref(false);
const showScore = import.meta.env.DEV;

const usesCamera = computed(() => tab.value !== 'bib');

onMounted(async () => {
  try {
    const r = await api.getEvent(props.slug);
    event.value = r.event;
    browse.value = r.photos;
    cursor.value = r.cursor;
  } catch (e: any) {
    loadError.value = e.message;
  } finally {
    loadingEvent.value = false;
  }
});

onBeforeUnmount(stopCamera);

async function loadMore() {
  if (!cursor.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const r = await api.getPhotos(props.slug, cursor.value);
    browse.value.push(...r.photos);
    cursor.value = r.cursor;
  } finally {
    loadingMore.value = false;
  }
}

function resetSearch() {
  results.value = null;
  searchedBy.value = null;
  searchError.value = null;
  searchNote.value = null;
}

function selectTab(t: Tab) {
  tab.value = t;
  resetSearch();
  if (t !== 'selfie') stopCamera();
  // Start the 16 MB model download the moment the user shows intent, so it
  // overlaps with them framing a selfie or picking a file.
  if (t !== 'bib' && !modelsReady.value) {
    loadModels((p) => {
      modelPhase.value = p;
      if (p === 'ready') modelsReady.value = true;
    }).catch(() => {});
  }
}

/** Roving arrow-key navigation, which the tab role contract requires. */
function onTabKey(e: KeyboardEvent, i: number) {
  const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!delta) return;
  e.preventDefault();
  const next = (i + delta + TABS.length) % TABS.length;
  selectTab(TABS[next].id);
  tabRefs.value[next]?.focus();
}

async function searchBib() {
  const value = bib.value.trim();
  if (!value) return;
  resetSearch();
  searching.value = true;
  try {
    const r = await api.searchBib(props.slug, value);
    results.value = r.photos.map((photo) => ({ photo }));
    searchedBy.value = 'bib';
    if (r.matched === 'suffix') {
      searchNote.value = `No exact match for ${value}. These bibs end in ${value} — the first digit may not have been readable.`;
    }
  } catch (e: any) {
    searchError.value = e.message;
  } finally {
    searching.value = false;
  }
}

async function runFaceSearch(source: Blob | HTMLVideoElement, via: Tab) {
  resetSearch();
  searching.value = true;
  try {
    await loadModels((p) => {
      modelPhase.value = p;
      if (p === 'ready') modelsReady.value = true;
    });
    const { vec, faceCount } = await embedLargestFace(source);
    const r = await api.searchFace(props.slug, vec);
    results.value = r.matches.map((m) => ({ photo: m.photo, score: m.score }));
    searchedBy.value = via;
    if (faceCount > 1 && r.matches.length) {
      searchNote.value = `Matched the largest of ${faceCount} faces in your photo.`;
    }
  } catch (e: any) {
    searchError.value =
      e instanceof NoFaceError
        ? 'We could not find a face in that image. Try a closer, front-facing photo in good light.'
        : e instanceof ApiError
          ? e.message
          : 'The search could not run on this device. Try the bib number instead.';
  } finally {
    searching.value = false;
  }
}

async function startCamera() {
  cameraError.value = null;
  try {
    stream.value = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    if (video.value) {
      video.value.srcObject = stream.value;
      await video.value.play();
    }
  } catch {
    cameraError.value = 'We could not open your camera. Check the permission in your browser, or use Upload instead.';
  }
}

function stopCamera() {
  stream.value?.getTracks().forEach((t) => t.stop());
  stream.value = null;
}

async function capture() {
  if (video.value && stream.value) await runFaceSearch(video.value, 'selfie');
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) await runFaceSearch(file, 'upload');
  // Reset so picking the same file twice fires change again.
  input.value = '';
}
</script>

<template>
  <template v-if="loadingEvent">
    <div class="skeleton" style="height: 30px; width: 60%; max-width: 380px" />
    <div class="skeleton skeleton-line short" style="margin-bottom: 28px" />
    <PhotoGridSkeleton />
  </template>

  <p v-else-if="loadError" class="notice err">{{ loadError }}</p>

  <template v-else-if="event">
    <h1>{{ event.name }}</h1>
    <p class="muted" style="margin: 0 0 var(--s-5)">
      {{ plural(event.photo_count, 'photo') }}
      <template v-if="event.status === 'partial'">
        · <span>some photos are still missing from the photographer</span>
      </template>
    </p>

    <div class="segmented" role="tablist" aria-label="How to find your photos">
      <button
        v-for="(t, i) in TABS"
        :key="t.id"
        ref="tabRefs"
        role="tab"
        :id="`tab-${t.id}`"
        :aria-selected="tab === t.id"
        :aria-controls="`panel-${t.id}`"
        :tabindex="tab === t.id ? 0 : -1"
        @click="selectTab(t.id)"
        @keydown="onTabKey($event, i)">
        {{ t.label }}
      </button>
    </div>

    <div
      class="card"
      role="tabpanel"
      :id="`panel-${tab}`"
      :aria-labelledby="`tab-${tab}`"
      tabindex="-1">
      <template v-if="tab === 'bib'">
        <label for="bib-input">Search by the number on your race bib</label>
        <form style="display: flex; gap: var(--s-3)" @submit.prevent="searchBib">
          <input
            id="bib-input" v-model="bib" inputmode="numeric" pattern="[0-9]*"
            autocomplete="off" placeholder="e.g. 1274" />
          <button class="primary" type="submit" :disabled="searching || !bib.trim()">Search</button>
        </form>
      </template>

      <template v-else-if="tab === 'selfie'">
        <video
          ref="video" playsinline muted aria-label="Camera preview"
          style="width: 100%; max-width: 420px; border-radius: var(--radius-sm);
                 background: var(--surface-2); aspect-ratio: 4 / 3; object-fit: cover" />
        <div class="btn-row" style="margin-top: var(--s-3)">
          <button v-if="!stream" @click="startCamera">Turn on camera</button>
          <template v-else>
            <button class="primary" :disabled="searching" @click="capture">Find my photos</button>
            <button @click="stopCamera">Turn off</button>
          </template>
        </div>
        <p v-if="cameraError" class="notice warn" style="margin-top: var(--s-3)">{{ cameraError }}</p>
      </template>

      <template v-else>
        <label for="photo-upload">Pick a clear, front-facing photo of yourself</label>
        <input id="photo-upload" type="file" accept="image/*" :disabled="searching" @change="onFile" />
      </template>

      <p v-if="usesCamera && modelPhase && !modelsReady" class="muted small" style="margin-top: var(--s-3)">
        <span class="spinner" /> Getting the face model ready (one time, about 16 MB)…
      </p>
      <!-- Only true when a photo is actually involved. On the bib tab there is
           no image, and claiming otherwise is just noise. -->
      <p v-if="usesCamera" class="muted small" style="margin: var(--s-3) 0 0">
        Your photo is matched on your device and is never uploaded.
      </p>
    </div>

    <p v-if="searchError" class="notice err" style="margin-top: var(--s-5)">{{ searchError }}</p>

    <!-- results ------------------------------------------------------- -->
    <template v-if="searching">
      <h2 style="margin-top: var(--s-6)"><span class="spinner" /> Searching {{ plural(event.photo_count, 'photo') }}…</h2>
      <PhotoGridSkeleton :count="8" />
    </template>

    <template v-else-if="results">
      <!-- The count header would only ever read "0 photos found" above a card
           that already says so. Show it when there is something to count. -->
      <div
        v-if="results.length"
        style="display: flex; align-items: baseline; justify-content: space-between;
               gap: var(--s-4); margin-top: var(--s-6); flex-wrap: wrap">
        <h2 style="margin: 0">
          {{ plural(results.length, 'photo') }} found
        </h2>
        <button @click="resetSearch">Show all photos</button>
      </div>

      <p v-if="searchNote" class="notice" style="margin: var(--s-3) 0">{{ searchNote }}</p>

      <template v-if="results.length">
        <p class="muted small" style="margin: var(--s-3) 0 var(--s-4)">
          Tap a photo to open the full-size original from the photographer.
        </p>
        <PhotoGrid :items="results" :show-score="showScore" animate />
      </template>

      <!-- An empty result is the moment the user is most likely to give up, so
           it teaches the next move rather than saying "nothing found". -->
      <div v-else class="card" style="margin-top: var(--s-6)">
        <h2>No matches yet</h2>
        <template v-if="searchedBy === 'bib'">
          <p class="muted" style="margin-top: 0">
            No photo of bib {{ bib }} has been indexed. Bib numbers get missed when they are
            folded, covered by a hand, or turned away from the camera.
          </p>
          <p class="muted small">Try finding yourself by face instead — it works even when your bib is hidden.</p>
          <div class="btn-row">
            <button class="primary" @click="selectTab('selfie')">Take a selfie</button>
            <button @click="selectTab('upload')">Upload a photo</button>
            <button @click="resetSearch">Show all photos</button>
          </div>
        </template>
        <template v-else>
          <p class="muted" style="margin-top: 0">
            Nobody matching that face turned up in this event's photos.
          </p>
          <ul class="muted small" style="padding-left: 1.1em; margin-bottom: var(--s-4)">
            <li>Use a photo where your face is large, lit from the front, and not in sunglasses.</li>
            <li>Race photos are often taken side-on — try a second, different photo.</li>
            <li>If you know your bib number, that search is exact.</li>
          </ul>
          <div class="btn-row">
            <button class="primary" @click="selectTab('bib')">Search by bib number</button>
            <button @click="resetSearch">Show all photos</button>
          </div>
        </template>
      </div>
    </template>

    <!-- browse -------------------------------------------------------- -->
    <template v-else>
      <h2 style="margin-top: var(--s-6)">All photos</h2>
      <PhotoGrid :items="browse.map((photo) => ({ photo }))" />
      <p v-if="!browse.length" class="muted">This event has no photos yet.</p>
      <div v-if="cursor" style="margin-top: var(--s-5)">
        <button :disabled="loadingMore" @click="loadMore">
          <span v-if="loadingMore" class="spinner" /> {{ loadingMore ? 'Loading…' : 'Load more photos' }}
        </button>
      </div>
    </template>
  </template>
</template>
