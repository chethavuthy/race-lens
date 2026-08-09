<script setup lang="ts">
/**
 * Per-event operations page.
 *
 * The organizer pastes a link and walks away. When an album comes back short
 * they need to answer "which link, how many, and why" — and the only place that
 * lived before was CI logs they have no access to.
 *
 * Two questions are answered separately on purpose:
 *   Coverage — did every photo get in?
 *   Search quality — can a runner actually find themselves?
 * An album can be 100% indexed and still useless if no bibs were read.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type EventSummary } from '../lib/api';
import { formatDate, plural } from '../lib/format';

const props = defineProps<{ id: string }>();
type Report = Awaited<ReturnType<typeof api.admin.report>>;

const event = ref<EventSummary | null>(null);
const report = ref<Report | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref<string | null>(null);
const levelFilter = ref<'all' | 'error' | 'warn'>('all');
const newLink = ref('');
let poll: number | undefined;

const totals = computed(() =>
  report.value?.totals ?? { links: 0, found: 0, found_known: true, indexed: 0, missing: 0 });
const quality = computed(() => report.value?.quality ?? null);

// A stalled job is NOT active: treating it as such would keep the spinner up
// and the Re-index button disabled indefinitely.
const activeJob = computed(() =>
  (report.value?.jobs ?? []).find(
    (j) => (j.status === 'running' || j.status === 'queued') && !j.stale) ?? null);

const stalledJob = computed(() => (report.value?.jobs ?? []).find((j) => j.stale) ?? null);

const visibleLog = computed(() => {
  const log = report.value?.log ?? [];
  return levelFilter.value === 'all' ? log : log.filter((l) => l.level === levelFilter.value);
});

const jobState = (s: string) =>
  s === 'failed' ? 'err' : s === 'partial' ? 'warn' : s === 'done' ? 'ok' : 'idle';

async function load(quiet = false) {
  if (!quiet) loading.value = true;
  try {
    const [e, r] = await Promise.all([api.admin.getEvent(props.id), api.admin.report(props.id)]);
    event.value = e.event; report.value = r; error.value = null;
  } catch (e: any) { error.value = e.message; } finally { loading.value = false; }
}

onMounted(async () => {
  await load();
  poll = setInterval(() => { if (activeJob.value) load(true); }, 6000) as unknown as number;
});
onBeforeUnmount(() => clearInterval(poll));

async function run<T>(key: string, fn: () => Promise<T>, ok?: string) {
  busy.value = key;
  try {
    await fn();
    // Replace the notice in place; do NOT blank it before the request.
    // Clearing it up front unmounts the banner for the whole round-trip, so the
    // content below collapses and then re-expands — which reads as a flicker on
    // every click of the image-source toggle, the one control people press
    // repeatedly. Swapping the text leaves the element mounted and the layout still.
    notice.value = ok ?? null;
    error.value = null;
    await load(true);
  } catch (e: any) {
    notice.value = null;
    error.value = e.message;
  } finally { busy.value = null; }
}

/**
 * Originals are what a photographer uploads, and for most albums they are the
 * right choice. But Drive's download quota is measured in BYTES, so a folder of
 * 20 MB originals moves ~25 photos per window while the same folder of ~1.6 MB
 * resized copies moves roughly 12x that — for identical faces and bibs, which
 * the benchmark measured rather than assumed.
 */
const setSource = (id: string, v: 'original' | 'thumb') =>
  run(`src-${id}`, () => api.admin.setImageSource(id, v),
      v === 'thumb'
        ? 'Switched to resized copies — press Re-index to continue at the faster rate.'
        : 'Switched to full originals — press Re-index to continue.');

/** Passes needed for what is still missing, at the measured per-window rates. */
const passesLeft = (s: { missing: number; image_source: string }) =>
  Math.ceil(s.missing / (s.image_source === 'thumb' ? 300 : 25));

const reindex = (id: string) =>
  run(id, () => api.admin.reindexSource(id), 'Re-indexing started — already-indexed photos are skipped.');

const setStatus = (s: EventSummary['status']) => run('status', () => api.admin.setStatus(props.id, s));

function addLink() {
  const url = newLink.value.trim();
  if (!url) return;
  run('add', async () => { await api.admin.ingest(props.id, url); newLink.value = ''; },
      'Link added — indexing started.');
}

function onBanner(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) run('banner', () => api.admin.uploadBanner(props.id, file));
}

const when = (iso: string) => new Date(iso).toLocaleString();
</script>

<template>
  <p style="margin: 0 0 var(--s-4)">
    <RouterLink to="/admin" class="muted small">← All events</RouterLink>
  </p>

  <p v-if="loading" class="muted"><span class="spinner" /> Loading…</p>
  <p v-else-if="error" class="notice err">{{ error }}</p>

  <template v-else-if="event">
    <h1>{{ event.name }}</h1>
    <p class="muted" style="margin: 0 0 var(--s-5)">
      <a :href="`/e/${event.slug}`" target="_blank" rel="noopener" class="mono-id">/e/{{ event.slug }}</a>
      · {{ event.status }}
      <template v-if="event.event_date"> · {{ formatDate(event.event_date) }}</template>
      · {{ plural(totals.indexed || event.photo_count, 'photo') }}
    </p>

    <p v-if="notice" class="notice ok" style="margin-bottom: var(--s-4)">{{ notice }}</p>

    <div class="stack">
      <!-- did every photo get in? -->
      <div class="card">
        <h2>Coverage</h2>
        <div class="stats">
          <div><div class="stat-label">Drive links</div><div class="stat-value">{{ totals.links }}</div></div>
          <div>
            <div class="stat-label">Found on Drive</div>
            <div class="stat-value">{{ totals.found }}<span v-if="!totals.found_known" class="muted small">+</span></div>
          </div>
          <div><div class="stat-label">Indexed</div><div class="stat-value">{{ totals.indexed }}</div></div>
          <div>
            <div class="stat-label">Still missing</div>
            <div class="stat-value" :class="totals.missing ? 'warn' : 'ok'">{{ totals.missing }}</div>
          </div>
        </div>
        <p v-if="activeJob" class="notice" style="margin-top: var(--s-4)">
          <span class="spinner" /> A pass is running — {{ activeJob.done }} / {{ activeJob.total }}.
          Indexing continues automatically after a Drive rate limit.
        </p>
        <p v-else-if="stalledJob" class="notice warn" style="margin-top: var(--s-4)">
          A pass stopped without reporting back — the CI runner was cancelled or reclaimed.
          Nothing is lost; press <strong>Re-index</strong> to pick up where it left off.
        </p>
        <p v-else-if="totals.missing > 0" class="notice warn" style="margin-top: var(--s-4)">
          {{ plural(totals.missing, 'photo') }} not indexed. Press <strong>Re-index</strong> on the
          link below — photos already indexed are skipped.
        </p>
        <p v-else class="notice ok" style="margin-top: var(--s-4)">Every photo found on Drive is indexed.</p>
      </div>

      <!-- can a runner actually find themselves? -->
      <div v-if="quality" class="card">
        <h2>Search quality</h2>
        <div class="stats">
          <div><div class="stat-label">Faces detected</div><div class="stat-value">{{ quality.faces }}</div></div>
          <div>
            <div class="stat-label">Photos with a face</div>
            <div class="stat-value">{{ quality.photos_with_face }}</div>
          </div>
          <div>
            <div class="stat-label">Photos with a bib</div>
            <div class="stat-value">{{ quality.photos_with_bib }}</div>
          </div>
          <div><div class="stat-label">Distinct bib numbers</div><div class="stat-value">{{ quality.distinct_bibs }}</div></div>
        </div>
        <p class="muted small" style="margin-top: var(--s-3)">
          {{ quality.photos_without_bib }} photos have no readable bib and
          {{ quality.photos_without_face }} have no detected face. Some of that is real —
          backs turned, bibs folded or hidden — so treat it as a ceiling on bib search, not a fault.
          Face search is unaffected by a missing bib.
        </p>
        <p style="margin-top: var(--s-3)">
          <RouterLink :to="`/admin/e/${id}/photos`" class="btn file-btn">
            Inspect photos — see faces and bibs drawn on each frame
          </RouterLink>
        </p>
        <template v-if="report?.top_bibs.length">
          <div class="muted small" style="margin-top: var(--s-3)">Most-photographed bibs — use one to sanity-check search:</div>
          <div class="btn-row" style="margin-top: var(--s-2)">
            <a v-for="b in report.top_bibs" :key="b.bib" class="btn small"
               :href="`/e/${event.slug}?bib=${b.bib}`" target="_blank" rel="noopener"
               style="min-height: auto; padding: var(--s-1) var(--s-3)">
              {{ b.bib }} <span class="muted">×{{ b.n }}</span>
            </a>
          </div>
        </template>
      </div>

      <!-- per link -->
      <div class="card">
        <h2>Drive links ({{ totals.links }})</h2>
        <p v-if="!report?.sources.length" class="muted" style="margin: 0">No links bound yet.</p>
        <div v-for="s in report?.sources ?? []" :key="s.id" class="row">
          <div class="row-main">
            <a :href="`https://drive.google.com/drive/folders/${s.drive_folder_id}`"
               target="_blank" rel="noopener" class="mono-id">{{ s.drive_folder_id }}</a>
            <div class="muted small">added {{ when(s.added_at) }}</div>
          </div>
          <span class="small">
            <strong>{{ s.indexed }}</strong> / {{ s.discovered_known ? s.discovered : '?' }} indexed
            <span v-if="s.missing > 0" class="state warn"> · {{ s.missing }} missing</span>
            <span v-else-if="s.discovered_known" class="state ok"> · complete</span>
            <span v-else class="muted"> · total unknown until the next pass</span>
            <span v-if="s.missing > 0" class="muted small" style="display: block">
              ~{{ passesLeft(s) }} more {{ passesLeft(s) === 1 ? 'pass' : 'passes' }} at this setting
            </span>
          </span>
          <div class="row-actions">
            <div class="segmented tiny" role="group" aria-label="Image size to download">
              <button :aria-selected="s.image_source !== 'thumb'"
                      :disabled="busy === `src-${s.id}` || !!activeJob"
                      title="Download the full-size original from Drive"
                      @click="setSource(s.id, 'original')">Original</button>
              <button :aria-selected="s.image_source === 'thumb'"
                      :disabled="busy === `src-${s.id}` || !!activeJob"
                      title="Download Drive's resized copy — same faces and bibs, ~12x more photos per pass"
                      @click="setSource(s.id, 'thumb')">Resized</button>
            </div>
            <button :disabled="busy === s.id || !!activeJob" @click="reindex(s.id)">
              <span v-if="busy === s.id" class="spinner" /> Re-index
            </button>
          </div>
        </div>

        <form class="row" style="border-bottom: 0" @submit.prevent="addLink">
          <input v-model="newLink" class="row-main" placeholder="Add another Drive folder URL…" />
          <button class="primary" type="submit" :disabled="busy === 'add' || !newLink.trim()">
            <span v-if="busy === 'add'" class="spinner" /> Add link
          </button>
        </form>
      </div>

      <!-- passes -->
      <div class="card">
        <h2>Passes ({{ report?.jobs.length ?? 0 }})</h2>
        <p v-if="!report?.jobs.length" class="muted" style="margin: 0">No indexing passes yet.</p>
        <div v-for="j in report?.jobs ?? []" :key="j.id" class="row row-tight">
          <div class="row-main small">
            <span class="state" :class="j.stale ? 'err' : jobState(j.status)">
              {{ j.stale ? 'stalled' : j.status }}
            </span>
            · {{ j.done }} / {{ j.total }}
            <span v-if="j.skipped"> · {{ j.skipped }} could not be fetched</span>
            <span v-if="j.attempts"> · {{ j.attempts }} auto-continuation{{ j.attempts === 1 ? '' : 's' }}</span>
            <span class="muted"> · {{ when(j.updated_at) }}</span>
            <div v-if="j.error" class="muted small">{{ j.error }}</div>
          </div>
        </div>
      </div>

      <!-- log -->
      <div class="card">
        <div class="row" style="border-bottom: 0; padding-top: 0">
          <h2 class="row-main" style="margin: 0">Ingest log</h2>
          <div class="row-actions">
            <button v-for="f in (['all', 'error', 'warn'] as const)" :key="f"
                    :aria-pressed="levelFilter === f"
                    :class="{ primary: levelFilter === f }" @click="levelFilter = f">{{ f }}</button>
          </div>
        </div>
        <p v-if="report?.summary.length" class="muted small" style="margin: 0 0 var(--s-2)">
          <span v-for="c in report.summary" :key="`${c.level}-${c.code}`" style="margin-right: var(--s-3)">
            {{ c.code || c.level }}: {{ c.n }}
          </span>
        </p>
        <p v-if="!visibleLog.length" class="muted small" style="margin: 0">Nothing logged at this level.</p>
        <div v-for="(l, i) in visibleLog" :key="i" class="row row-tight">
          <div class="row-main small">
            <span class="state" :class="l.level === 'error' ? 'err' : l.level === 'warn' ? 'warn' : 'idle'">
              {{ l.code || l.level }}
            </span>
            — {{ l.message }}
            <a v-if="l.drive_file_id" class="muted small mono-id" style="margin-left: var(--s-2)"
               :href="`https://drive.google.com/file/d/${l.drive_file_id}/view`"
               target="_blank" rel="noopener">open photo</a>
          </div>
        </div>
      </div>

      <!-- actions -->
      <div class="card">
        <h2>Actions</h2>
        <div class="btn-row">
          <button v-if="event.status !== 'ready'" class="primary" :disabled="busy === 'status'"
                  @click="setStatus('ready')">Publish</button>
          <button v-else :disabled="busy === 'status'" @click="setStatus('draft')">Unpublish</button>
          <label for="ev-banner" class="btn file-btn">
            <span v-if="busy === 'banner'" class="spinner" />
            {{ event.banner_url ? 'Replace banner' : 'Add banner' }}
          </label>
          <input id="ev-banner" type="file" accept="image/*" class="sr-only" @change="onBanner" />
        </div>
        <img v-if="event.banner_url" class="banner-preview" :src="event.banner_url" alt="" />
        <p class="muted small" style="margin-bottom: 0">
          Unpublishing hides the event from runners. Photos and search data are kept.
        </p>
      </div>
    </div>
  </template>
</template>
