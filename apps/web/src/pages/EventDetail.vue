<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError, type EventSummary, type Photo } from '../lib/api';
import { embedLargestFace, loadModels, NoFaceError, type LoadPhase } from '../lib/face';
import PhotoGrid from '../components/PhotoGrid.vue';
import type { GridItem } from '../lib/grid';
import PhotoGridSkeleton from '../components/PhotoGridSkeleton.vue';
import { plural } from '../lib/format';

const props = defineProps<{ slug: string }>();

const route = useRoute();
const router = useRouter();

type Tab = 'bib' | 'selfie' | 'upload';
const ALL_TABS: { id: Tab; label: string }[] = [
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
/** Set when a page fails; latches auto-loading off until the reader retries. */
const browseError = ref<string | null>(null);

/* ------------------------------------------------------- infinite scroll --
   The grid loads as the reader approaches the end rather than making them hit
   a button every 60 photos — 8,523 of them in the largest event.

   The sentinel is watched rather than observed once, because it only exists
   while browsing: running a search unmounts it, and clearing the search mounts
   a new one. */
const sentinel = ref<HTMLElement | null>(null);
const hasAutoLoad = typeof IntersectionObserver !== 'undefined';

/**
 * How far below the fold the next page starts loading.
 *
 * Measured in screens rather than pixels, because a fixed 800px is most of a
 * phone and barely a third of a desktop — the same constant would mean two
 * very different amounts of warning.
 *
 * Three screens is enough that a reader scrolling at a normal pace arrives at
 * photographs rather than at skeletons, and because loadMore re-observes after
 * every page, the grid keeps pulling until that much runway exists. It stops
 * as soon as it does, so this buys lead time without walking the whole 8,523.
 */
const PREFETCH_SCREENS = 3;
const prefetchMargin = () =>
  `${Math.round(Math.max(1200, window.innerHeight * PREFETCH_SCREENS))}px 0px`;
let moreObserver: IntersectionObserver | null = null;

const results = ref<GridItem[] | null>(null);
const searchedBy = ref<Tab | null>(null);
const searching = ref(false);
const searchError = ref<string | null>(null);
const searchNote = ref<string | null>(null);

const bib = ref('');

/**
 * Crop face results to the runner who actually matched.
 *
 * On by default because it is the point: these albums average about nine faces
 * per frame, so an uncropped result is a pack of runners and the person cannot
 * tell which one is them. The photographer's full frame is never more than a
 * tap away — the tile links to the untouched original either way — and the
 * toggle beside the count switches the whole grid back.
 */
const cropToFace = ref(true);
const faceSearched = computed(() => searchedBy.value === 'selfie' || searchedBy.value === 'upload');
// Set when an exact search found nothing but a looser one might. Widening is
// offered as a labelled choice, never done silently: a suffix match can return
// a different runner's photos and the runner has no way to tell.
const fuzzyOffered = ref(false);

const video = ref<HTMLVideoElement | null>(null);
const stream = ref<MediaStream | null>(null);
/** True once there is a picture to align to, which is what the panel switches on. */
const live = computed(() => !!stream.value);
const cameraError = ref<string | null>(null);

const modelPhase = ref<LoadPhase | null>(null);
const modelsReady = ref(false);
const showScore = import.meta.env.DEV;

const usesCamera = computed(() => tab.value !== 'bib');

// Events that hand out no bibs drop the tab entirely rather than showing a
// search that can only ever return nothing. Defaults to true so the tab does not
// flash away while the event is still loading.
const bibsEnabled = computed(() => event.value?.bibs_enabled !== false);
const TABS = computed(() => ALL_TABS.filter((t) => t.id !== 'bib' || bibsEnabled.value));

/**
 * The URL drives the bib search — on first paint, on Back/Forward, and on every
 * submit. Routing all of them through one watcher means a shared link and a
 * typed search take exactly the same path, so there is no second code path to
 * keep in step.
 */
watch(
  () => [route.query.bib, route.query.fuzzy] as const,
  ([rawBib, rawFuzzy]) => {
    const value = typeof rawBib === 'string' ? rawBib.trim() : '';
    if (!value) {
      // Only the bib search is URL-backed. A face search puts nothing in the
      // query, so clearing here on an empty param would wipe its results the
      // moment it finished.
      if (searchedBy.value === 'bib') clearResults();
      return;
    }
    bib.value = value;
    tab.value = 'bib';
    void searchBib(value, rawFuzzy === '1');
  },
  { immediate: true },
);

onMounted(async () => {
  try {
    const r = await api.getEvent(props.slug);
    event.value = r.event;
    // 'bib' is the initial tab because it is the right default for a race. If
    // this event has no bibs, move off it before anything renders a dead search.
    if (r.event.bibs_enabled === false && tab.value === 'bib') tab.value = 'selfie';
    browse.value = r.photos;
    cursor.value = r.cursor;
  } catch (e: any) {
    loadError.value = e.message;
  } finally {
    loadingEvent.value = false;
  }
});

/* The sentinel only exists while browsing — running a search unmounts it and
   clearing the search mounts a new one — so the observer follows the element
   rather than being wired up once on mount. */
watch(sentinel, (el) => {
  moreObserver?.disconnect();
  moreObserver = null;
  if (!el || !('IntersectionObserver' in window)) return;
  moreObserver = new IntersectionObserver(
    (entries) => { if (entries.some((e) => e.isIntersecting)) void loadMore(); },
    { rootMargin: prefetchMargin() },
  );
  moreObserver.observe(el);
});

onBeforeUnmount(() => {
  stopCamera();
  moreObserver?.disconnect();
});

/**
 * Load the next page of the browse grid.
 *
 * `browseError` is what stops a failure becoming a hot loop: the observer below
 * fires whenever the sentinel is in view, so without a latch a failing endpoint
 * would be re-requested on every intersection for as long as the reader sat
 * there. Auto-loading stays off until they explicitly retry.
 */
async function loadMore() {
  if (!cursor.value || loadingMore.value || browseError.value) return;
  loadingMore.value = true;
  try {
    const r = await api.getPhotos(props.slug, cursor.value);
    browse.value.push(...r.photos);
    cursor.value = r.cursor;
  } catch (e: any) {
    browseError.value = e?.message ?? 'Could not load more photos.';
  } finally {
    loadingMore.value = false;
    // IntersectionObserver only reports CHANGES. If the page we just appended
    // was short enough that the sentinel is still on screen, nothing further
    // would fire and loading would stall halfway down. Re-observing makes it
    // re-report the current state, so the grid keeps filling until the
    // sentinel is genuinely pushed out of range.
    if (moreObserver && sentinel.value) {
      moreObserver.unobserve(sentinel.value);
      moreObserver.observe(sentinel.value);
    }
  }
}

function retryBrowse() {
  browseError.value = null;
  void loadMore();
}

/** Drop the current results without touching the URL. */
function clearResults() {
  fuzzyOffered.value = false;
  results.value = null;
  searchedBy.value = null;
  searchError.value = null;
  searchNote.value = null;
}

/**
 * Clear the results AND the query that produced them.
 *
 * The bib search lives in the URL (see the watcher below), so forgetting to
 * clear it here would leave the address bar claiming a search that is no
 * longer on screen — and a refresh would bring it straight back.
 */
function resetSearch() {
  clearResults();
  if (route.query.bib != null || route.query.fuzzy != null) {
    const query = { ...route.query };
    delete query.bib;
    delete query.fuzzy;
    router.replace({ query });
  }
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
  const next = (i + delta + TABS.value.length) % TABS.value.length;
  selectTab(TABS.value[next].id);
  tabRefs.value[next]?.focus();
}

/**
 * Put the search in the URL and let the watcher run it.
 *
 * The URL is the single source of truth for bib search, which is what makes a
 * result bookmarkable, shareable, and able to survive a refresh — a runner who
 * finds their photos can send that link to whoever they ran with. It also means
 * Back steps out of a search rather than off the page.
 */
function submitBib(fuzzy = false) {
  const value = bib.value.trim();
  if (!value) return;
  const query: Record<string, string> = { ...(route.query as Record<string, string>), bib: value };
  if (fuzzy) query.fuzzy = '1'; else delete query.fuzzy;
  router.push({ query });
}

async function searchBib(value: string, fuzzy: boolean) {
  clearResults();
  searching.value = true;
  try {
    const r = await api.searchBib(props.slug, value, fuzzy);
    results.value = r.photos.map((photo) => ({ photo }));
    searchedBy.value = 'bib';
    fuzzyOffered.value = r.fuzzy_available;
    if (r.matched === 'suffix') {
      searchNote.value =
        `No photo of bib ${value} was found. These bibs merely END in ${value}, so they may be ` +
        `other runners — check the photo before assuming it is you.`;
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
    // bbox rides along so the grid can crop the tile to the face that matched.
    results.value = r.matches.map((m) => ({ photo: m.photo, score: m.score, bbox: m.bbox }));
    cropToFace.value = true;
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

    <div class="finder">
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
        <h3 class="ask-title">What number did you wear?</h3>
        <p class="ask-why">The number printed on your race bib. Usually 3–5 digits.</p>
        <form class="bib-form" @submit.prevent="submitBib()">
          <label class="sr-only" for="bib-input">Race bib number</label>
          <input
            id="bib-input" class="bib-entry" v-model="bib" inputmode="numeric" pattern="[0-9]*"
            autocomplete="off" enterkeyhint="search" placeholder="1274" />
          <button
            class="primary" type="submit" style="width: 100%; margin-top: var(--s-4)"
            :disabled="searching || !bib.trim()">
            Find my photos
          </button>
        </form>
      </template>

      <template v-else-if="tab === 'selfie'">
        <!-- The reason and the promise sit ABOVE the control that acts on
             them. "Never uploaded" is what decides whether a stranger will
             point a camera at their own face, so it cannot be a footnote read
             only by people who already said yes. -->
        <h3 class="ask-title">{{ live ? 'Fill the oval' : 'Let’s find you' }}</h3>
        <!-- Once the camera is live the guidance moves into the frame itself,
             where the person is already looking. Repeating it above as well
             costs ~36px, which on a 667px handset is the difference between
             the shutter button being reachable and being below the fold. -->
        <p v-if="!live" class="ask-why">
          Matched <strong>on this phone</strong> — never uploaded, never stored.
        </p>

        <div class="lens" :data-live="live">
          <video ref="video" playsinline muted aria-label="Camera preview" />
          <!-- Before permission there is no video, so the frame previews what
               will fill it rather than sitting empty. -->
          <div v-if="!live" class="ghost" aria-hidden="true" />
          <div v-else class="oval" aria-hidden="true" />
          <span v-if="live" class="hint">Good light, no sunglasses</span>
        </div>

        <button
          v-if="!live" class="primary" style="width: 100%; margin-top: var(--s-4)"
          @click="startCamera">
          Turn on camera
        </button>
        <button
          v-else class="primary" style="width: 100%; margin-top: var(--s-4)"
          :disabled="searching" @click="capture">
          Find my photos
        </button>

        <!-- The other routes are offered here, so nobody has to discover a tab
             to escape a camera they do not want to grant. -->
        <div class="alt-row">
          <button v-if="live" @click="stopCamera">Turn off camera</button>
          <button v-else @click="selectTab('upload')">Upload a photo</button>
          <button v-if="bibsEnabled" @click="selectTab('bib')">Use bib number</button>
        </div>

        <p v-if="cameraError" class="notice warn" style="margin-top: var(--s-3)">{{ cameraError }}</p>
      </template>

      <template v-else>
        <h3 class="ask-title">Pick a photo of yourself</h3>
        <p class="ask-why">
          Face large in the frame, looking at the camera. Matched <strong>on this phone</strong> —
          never uploaded, never stored.
        </p>
        <label class="sr-only" for="photo-upload">Photo of yourself</label>
        <input id="photo-upload" type="file" accept="image/*" :disabled="searching" @change="onFile" />
        <div class="alt-row">
          <button @click="selectTab('selfie')">Use the camera</button>
          <button v-if="bibsEnabled" @click="selectTab('bib')">Use bib number</button>
        </div>
      </template>

      <p v-if="usesCamera && modelPhase && !modelsReady" class="muted small" style="margin-top: var(--s-3)">
        <span class="spinner" /> Getting the face model ready (one time, about 16 MB)…
      </p>
      </div>
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
        <div class="btn-row">
          <button v-if="faceSearched" @click="cropToFace = !cropToFace">
            {{ cropToFace ? 'Show full frames' : 'Crop to me' }}
          </button>
          <button @click="resetSearch">Show all photos</button>
        </div>
      </div>

      <p v-if="searchNote" class="notice" style="margin: var(--s-3) 0">{{ searchNote }}</p>

      <template v-if="results.length">
        <p class="muted small" style="margin: var(--s-3) 0 var(--s-4)">
          Tap a photo to open the full-size original from the photographer.
        </p>
        <PhotoGrid
          :items="results"
          :show-score="showScore"
          :crop="faceSearched && cropToFace"
          show-time
          animate />
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
            <button v-if="fuzzyOffered" @click="submitBib(true)">Try similar numbers</button>
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
            <li v-if="bibsEnabled">If you know your bib number, that search is exact.</li>
          </ul>
          <div class="btn-row">
            <button v-if="bibsEnabled" class="primary" @click="selectTab('bib')">Search by bib number</button>
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

      <!-- Sits a screen below the last row; crossing it fetches the next page. -->
      <div v-if="cursor && !browseError" ref="sentinel" class="load-sentinel" aria-hidden="true" />

      <div class="load-status">
        <!-- Scrolling is what triggers loading, and a screen reader user has no
             way to see that it happened — so it is announced. -->
        <p class="sr-only" role="status">
          {{ loadingMore ? 'Loading more photos' : cursor ? '' : 'All photos loaded' }}
        </p>

        <template v-if="browseError">
          <p class="notice err" style="margin-bottom: var(--s-3)">{{ browseError }}</p>
          <button @click="retryBrowse">Try again</button>
        </template>

        <p v-else-if="loadingMore" class="muted small">
          <span class="spinner" /> Loading more photos…
        </p>

        <!-- The button is the fallback for a browser with no IntersectionObserver,
             where nothing would ever trigger a fetch. -->
        <button v-else-if="cursor && !hasAutoLoad" @click="loadMore">Load more photos</button>

        <p v-else-if="!cursor && browse.length" class="muted small">
          That's all {{ plural(browse.length, 'photo') }}.
        </p>
      </div>
    </template>
  </template>
</template>
