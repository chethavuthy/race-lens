<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError, type Credit, type EventSummary, type Photo } from '../lib/api';
import { embedLargestFace, loadModels, NoFaceError, type LoadPhase } from '../lib/face';
import PhotoGrid from '../components/PhotoGrid.vue';
import type { GridItem } from '../lib/grid';
import PhotoGridSkeleton from '../components/PhotoGridSkeleton.vue';
import { plural } from '../lib/format';
import { bibSearchCache, eventPageCache, type Tab } from '../lib/cache';

const props = defineProps<{ slug: string }>();

const route = useRoute();
const router = useRouter();

const ALL_TABS: { id: Tab; label: string }[] = [
  { id: 'bib', label: 'Bib' },
  { id: 'selfie', label: 'Selfie' },
  { id: 'upload', label: 'Upload' },
];

/* ------------------------------------------------------------- back button --
   Everything this page fetched last time, so that coming back is a re-render
   rather than a reload. Read here, during setup, so the first paint is the
   finished page — see lib/cache.ts. */
const restored = eventPageCache.read(props.slug);

const tab = ref<Tab>(restored?.tab ?? 'bib');
const tabRefs = ref<HTMLButtonElement[]>([]);

/* The photo array is stored by reference, so the pages this mount appends are
   already in the cache — `remember` is only ever updating the cursor and the
   tab alongside them. */
const event = ref<EventSummary | null>(restored?.event ?? null);
const credits = ref<Credit[]>(restored?.credits ?? []);
const browse = ref<Photo[]>(restored?.photos ?? []);
const cursor = ref<string | null>(restored?.cursor ?? null);
const loadingEvent = ref(!restored);
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

/* A face search is the one result set nothing can rebuild: it leaves no trace in
   the URL and the selfie that produced it is gone the moment it is embedded. If
   it is not carried across the unmount it is simply lost, and the reader is back
   at "All photos" having to take another picture of themselves. */
const results = ref<GridItem[] | null>(restored?.results ?? null);
const searchedBy = ref<Tab | null>(restored?.searchedBy ?? null);
const searching = ref(false);
const searchError = ref<string | null>(null);
const searchNote = ref<string | null>(restored?.searchNote ?? null);

const bib = ref('');

/**
 * Stable wrapper objects for the browse grid.
 *
 * `:items="browse.map(...)"` in the template allocated a fresh array — and fresh
 * item objects — on every render of this component, so PhotoGrid's `columns`
 * computed saw a new dependency value each time and re-dealt all 8,523 tiles for
 * an unrelated state change like a keystroke in the bib field.
 */
const browseItems = computed<GridItem[]>(() => browse.value.map((photo) => ({ photo })));

/**
 * Crop face results to the runner who actually matched.
 *
 * OFF by default: what the reader is here for is the photograph, and a crop is
 * not one — it is a thumbnail of a face, taken out of the frame the photographer
 * composed. The identification problem it was meant to solve (these albums
 * average about nine faces per frame) is real but smaller than the cost, because
 * every result already links to the untouched original.
 *
 * Kept as an opt-in beside the count, for the group shot where someone genuinely
 * cannot tell which runner is them.
 */
const cropToFace = ref(restored?.cropToFace ?? false);
const faceSearched = computed(() => searchedBy.value === 'selfie' || searchedBy.value === 'upload');
// Set when an exact search found nothing but a looser one might. Widening is
// offered as a labelled choice, never done silently: a suffix match can return
// a different runner's photos and the runner has no way to tell.
const fuzzyOffered = ref(false);
/**
 * Same number, different category — at a race numbering by category, 0001,
 * F-0001 and M-0001 are three runners. Offered as a next step rather than merged
 * into the results: a runner shown three people's photos cannot tell which are
 * theirs, and that is the one thing this product has to get right.
 */
const bibAlternatives = ref<string[]>([]);

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

/* ------------------------------------------------------------------ credit --
   Every frame on this page is somebody's work, and an event absorbs folders from
   several photographers at once.

   The byline sits in the meta line under the title, and OPENS A DIALOG rather
   than jumping to a block at the foot of the page. The grid loads as the reader
   scrolls — 8,523 photos in the largest album, three screens of prefetch at a
   time — so the bottom of this page is somewhere nobody arrives. A credit and a
   takedown route that live down there are, in practice, not on the page at all.
   One tap from the line under the title is. */

/** The one route a photographer has for taking their album back off the site. */
const TELEGRAM = 'https://t.me/chethavuthy';

const creditDialog = ref<HTMLDialogElement | null>(null);
/* showModal() over an `open` attribute: it is what gives the dialog the top
   layer, the backdrop, Escape-to-close and the focus trap for free. */
const openCredits = () => creditDialog.value?.showModal();
const closeCredits = () => creditDialog.value?.close();

/**
 * Close on a click outside the panel — and only outside it.
 *
 * A backdrop click reports the DIALOG as its target, which is the usual way to
 * detect one, but so does a click on the dialog's own rounded corners: measured,
 * a ~10px band along the edge hits the dialog element rather than the padded box
 * inside it, so target alone shut the panel when you clicked its top-left corner.
 *
 * Both tests together are what make it exact. The target test rules out clicks on
 * anything inside, including a keyboard-activated button — Enter dispatches a
 * click at (0, 0), which the geometry test alone would read as the backdrop.
 */
function onDialogClick(e: MouseEvent) {
  const d = creditDialog.value;
  if (!d || e.target !== d) return;
  const r = d.getBoundingClientRect();
  const outside =
    e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if (outside) d.close();
}

/**
 * What to call a source with no name recorded.
 *
 * Numbered once there is more than one, because every live event today is
 * unnamed — Angkor has five folders, and five rows all reading "Album from
 * Google Drive" is a list nobody can tell apart. The number at least says which
 * row is which until the credits are filled in.
 */
const creditLabel = (g: { name: string | null }, i: number) =>
  g.name || (creditGroups.value.length > 1 ? `Album ${i + 1} from Google Drive` : 'Album from Google Drive');

/**
 * One entry per photographer, not per Drive folder.
 *
 * A photographer commonly hands over two or three folders for one race, and each
 * is a separate source row credited with the same name — so the page was reading
 * "by Unity Run Club and Unity Run Club", and the dialog listed the same person
 * twice. Same name (trimmed, case-insensitively) is the same person: their photo
 * counts add up and their albums are listed together.
 *
 * Unnamed sources are NOT grouped with each other. Two anonymous folders are two
 * unknowns, and merging them would assert something nobody told us.
 */
interface CreditGroup { name: string | null; photo_count: number; albums: string[] }

const creditGroups = computed<CreditGroup[]>(() => {
  const groups: CreditGroup[] = [];
  const byName = new Map<string, CreditGroup>();

  for (const c of credits.value) {
    const key = (c.name ?? '').trim().toLowerCase();
    const existing = key ? byName.get(key) : undefined;
    if (existing) {
      existing.photo_count += c.photo_count;
      existing.albums.push(c.album_url);
      continue;
    }
    const group: CreditGroup = {
      name: c.name?.trim() || null,
      photo_count: c.photo_count,
      albums: [c.album_url],
    };
    groups.push(group);
    if (key) byName.set(key, group);
  }
  return groups;
});

/**
 * The byline for the meta line: "Sok Dara and Chan Nita".
 *
 * Truncates past three, because this shares one line with the photo count and a
 * four-name list wraps it on any handset. The dialog names all of them
 * regardless, so nothing is lost — only deferred.
 */
const byline = computed(() => {
  const names = creditGroups.value.map((g) => g.name).filter((n): n is string => !!n);
  if (!names.length) return null;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]} and ${names.length - 1} others`;
});

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

/** Hand the current browse state back to the cache for the next mount. */
function remember() {
  if (!event.value) return;
  eventPageCache.write(props.slug, {
    event: event.value,
    credits: credits.value,
    photos: browse.value,
    cursor: cursor.value,
    tab: tab.value,
    results: results.value,
    searchedBy: searchedBy.value,
    searchNote: searchNote.value,
    cropToFace: cropToFace.value,
  });
}

onMounted(async () => {
  // Already on screen. Re-fetching would replace a grid the reader is looking
  // at — and, three pages deep, shrink it back to sixty photos underneath them.
  if (restored) return;
  try {
    const r = await api.getEvent(props.slug);
    event.value = r.event;
    // 'bib' is the initial tab because it is the right default for a race. If
    // this event has no bibs, move off it before anything renders a dead search.
    if (r.event.bibs_enabled === false && tab.value === 'bib') tab.value = 'selfie';
    credits.value = r.credits ?? [];
    browse.value = r.photos;
    cursor.value = r.cursor;
    remember();
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
  // Leaving is the one moment the tab is certainly final, and it costs nothing
  // to re-stamp the entry's age while we are here.
  remember();
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
    remember();
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
  bibAlternatives.value = [];
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

/**
 * Search one of the other categories carrying the same digits.
 *
 * Goes through the URL like every other bib search, so it is bookmarkable and
 * Back steps out of it — and so the generation guard below applies. Clears fuzzy:
 * this is an EXACT search for a different runner, not a widening of the last one.
 */
function searchAlternative(label: string) {
  bib.value = label;
  const query: Record<string, string> = { ...(route.query as Record<string, string>), bib: label };
  delete query.fuzzy;
  router.push({ query });
}

/**
 * Which search is current.
 *
 * The submit button is disabled while `searching`, but the URL watcher is not:
 * Back/Forward, or the empty state's "Try similar numbers", starts a second search
 * while the first is still out. A slow response for bib A landing after B then
 * replaced B's results with A's, under a header that only says "N photos found" —
 * so the runner is shown someone else's photos with nothing to indicate it. That is
 * precisely the failure the fuzzy-search opt-in exists to prevent, arriving by a
 * different route.
 */
let searchSeq = 0;

async function searchBib(value: string, fuzzy: boolean) {
  const seq = ++searchSeq;
  clearResults();

  /* A bib search is in the URL, so Back into one re-runs it — and re-ran it over
     the network, which meant stepping out of a search and back into it emptied
     the grid and spun. Applying the previous answer synchronously (this runs
     before the first await, and the URL watcher is `immediate`) means the page
     never renders the searching state at all. */
  const key = `${props.slug}:${value}:${fuzzy}`;
  const hit = bibSearchCache.read(key);
  if (hit) {
    results.value = hit.results;
    searchedBy.value = 'bib';
    fuzzyOffered.value = hit.fuzzyOffered;
    bibAlternatives.value = hit.alternatives ?? [];
    searchNote.value = hit.note;
    // An older request may still be out. Its own `seq` guard drops its results,
    // but it will no longer be the one that turns this back off.
    searching.value = false;
    return;
  }

  searching.value = true;
  try {
    const r = await api.searchBib(props.slug, value, fuzzy);
    if (seq !== searchSeq) return;      // a newer search has taken over
    const items = r.photos.map((photo) => ({ photo }));
    const note =
      r.matched === 'suffix'
        ? `No photo of bib ${value} was found. These bibs merely END in ${value}, so they may be ` +
          `other runners — check the photo before assuming it is you.`
        : null;
    results.value = items;
    searchedBy.value = 'bib';
    fuzzyOffered.value = r.fuzzy_available;
    bibAlternatives.value = r.alternatives ?? [];
    searchNote.value = note;
    bibSearchCache.write(key, {
      results: items, note, fuzzyOffered: r.fuzzy_available,
      alternatives: r.alternatives ?? [],
    });
  } catch (e: any) {
    if (seq === searchSeq) searchError.value = e.message;
  } finally {
    if (seq === searchSeq) searching.value = false;
  }
}

async function runFaceSearch(source: Blob | HTMLVideoElement, via: Tab) {
  // Same generation guard as searchBib, and it matters more here: this path spends
  // ~1s on local inference before it even reaches the network.
  const seq = ++searchSeq;
  resetSearch();
  searching.value = true;
  try {
    await loadModels((p) => {
      modelPhase.value = p;
      if (p === 'ready') modelsReady.value = true;
    });
    const { vec, faceCount } = await embedLargestFace(source);
    const r = await api.searchFace(props.slug, vec);
    if (seq !== searchSeq) return;
    // The matched face's box rides along — as fractions, already converted by the
    // API — so the grid CAN crop to that runner if the reader asks for it. A new
    // search resets to full frames rather than inheriting the last one's crop, so
    // every result set opens as the photographs it is.
    results.value = r.matches.map((m) => ({ photo: m.photo, score: m.score, box: m.box }));
    cropToFace.value = false;
    searchedBy.value = via;
    if (faceCount > 1 && r.matches.length) {
      searchNote.value = `Matched the largest of ${faceCount} faces in your photo.`;
    }
  } catch (e: any) {
    if (seq !== searchSeq) return;
    searchError.value =
      e instanceof NoFaceError
        ? 'We could not find a face in that image. Try a closer, front-facing photo in good light.'
        : e instanceof ApiError
          ? e.message
          : 'The search could not run on this device. Try the bib number instead.';
  } finally {
    if (seq === searchSeq) searching.value = false;
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
      <!-- Opens the credit dialog: who shot these, a link to each album, and how
           a photographer asks for theirs to come down. Named or not, the route is
           always here — an unnamed event still has albums to link and a takedown
           to offer. -->
      <template v-if="credits.length">
        ·
        <button class="byline" @click="openCredits">
          {{ byline ? `by ${byline}` : 'Photo credits' }}
        </button>
      </template>
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
      <!-- Shown even when the search DID find photos: these results are one
           runner's, but another category shares the number, and a runner who
           landed on the wrong one has no other way to discover that. Offered, not
           merged — mixing them would show three people's photos with no way to
           tell them apart. -->
      <p v-if="bibAlternatives.length && searchedBy === 'bib' && results.length"
         class="muted small" style="margin: var(--s-3) 0">
        Showing bib {{ bib.trim() }}. This race numbers by category and the same
        number also exists as
        <template v-for="(alt, i) in bibAlternatives" :key="alt"
          ><button class="link" @click="searchAlternative(alt)">{{ alt }}</button
          >{{ i < bibAlternatives.length - 1 ? ', ' : '' }}</template>.
      </p>

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
          <!-- Before the selfie suggestion: at a race numbering by category, a
               runner typing 0001 without their letter has an exact answer waiting,
               and telling them to photograph themselves instead would be absurd. -->
          <template v-if="bibAlternatives.length">
            <p class="muted" style="margin-top: 0">
              This race numbers by category. The same number exists as
              <strong>{{ bibAlternatives.join(', ') }}</strong> — if your bib has a
              letter on it, that is you.
            </p>
            <div class="btn-row" style="margin-bottom: var(--s-4)">
              <button v-for="alt in bibAlternatives" :key="alt" class="primary"
                      @click="searchAlternative(alt)">Show {{ alt }}</button>
            </div>
          </template>
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
      <PhotoGrid :items="browseItems" />
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

    <!-- credit ------------------------------------------------------------
         A dialog, not a footer. The grid keeps loading as the reader scrolls, so
         the foot of this page is not a place anyone lands — and neither the credit
         nor the takedown route can afford to live somewhere unreachable. It opens
         from the line under the title, which is on screen from the first paint.

         Rendered whenever there are credits, whether the reader is browsing or
         looking at search results: whose work this is does not depend on what
         they searched for. -->
    <dialog
      v-if="credits.length"
      ref="creditDialog"
      class="credit-modal"
      aria-labelledby="credit-modal-title"
      @click="onDialogClick">
      <!-- The inner box carries the padding, and the dialog itself carries none:
           a padded dialog is a strip that closes the panel when clicked inside it,
           since those clicks report the dialog as their target too. onDialogClick
           handles the corners the same problem leaves behind. -->
      <div class="credit-modal-body">
      <div class="credit-modal-head">
        <h2 id="credit-modal-title" style="margin: 0">Photos by</h2>
        <button class="icon-btn" aria-label="Close" @click="closeCredits">✕</button>
      </div>

      <ul class="credit-list">
        <li v-for="(g, i) in creditGroups" :key="g.albums[0]" class="credit">
          <span class="who">
            <!-- An unnamed source is not given an invented byline; its album
                 link is the whole of what we can honestly say about it. -->
            <span class="name">{{ creditLabel(g, i) }}</span>
            <span class="count muted small">{{ plural(g.photo_count, 'photo') }}</span>
          </span>
          <!-- One photographer, several folders: every album still gets its own
               link, numbered so they are told apart. -->
          <span class="credit-albums">
            <a v-for="(url, n) in g.albums" :key="url" class="btn"
               :href="url" target="_blank" rel="noopener">
              {{ g.albums.length > 1 ? `Album ${n + 1} ↗` : 'Open album ↗' }}
            </a>
          </span>
        </li>
      </ul>

      <p class="muted small credit-rights">
        Copyright stays with the photographer. Race Lens shows a small preview and links to
        their album — every full-size photo comes from them.
      </p>

      <h3 class="credit-takedown-title">Are these your photos?</h3>
      <p style="margin: 0">
        If you shared one of these albums and want it off Race Lens, send me the link on
        Telegram. The album and everything indexed from it comes down. No form, no reason
        needed.
      </p>
      <a class="btn tg" :href="TELEGRAM" target="_blank" rel="noopener">
        Message @chethavuthy
      </a>
      <p class="muted small" style="margin: 0">
        Opens Telegram. Send it from the account that shared the album so I know it's you.
      </p>
      </div>
    </dialog>
  </template>
</template>
