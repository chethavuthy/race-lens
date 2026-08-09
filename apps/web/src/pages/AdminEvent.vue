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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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

const filteredLog = computed(() => {
  const log = report.value?.log ?? [];
  return levelFilter.value === 'all' ? log : log.filter((l) => l.level === levelFilter.value);
});

// Both lists grow without bound on a rate-limited album — one pass per
// continuation, one log line per event — and rendering hundreds of rows buries
// the few that matter. Show a page at a time, newest first, and let the reader
// ask for more.
const PAGE = 10;
const jobsShown = ref(PAGE);
const logShown = ref(PAGE);

const visibleJobs = computed(() => (report.value?.jobs ?? []).slice(0, jobsShown.value));
const visibleLog = computed(() => filteredLog.value.slice(0, logShown.value));

// Narrowing the filter can leave the page size above the result count; reset so
// "Show more" never appears with nothing left to show.
watch(levelFilter, () => { logShown.value = PAGE; });

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

/**
 * Passes needed for what is still missing, at the observed per-window rates.
 *
 * 600 for resized, not 300: a real pass moved 601 photos with no rate limit at
 * all, so 300 overstated the work by 2x — on a 24k-photo folder that is the
 * difference between "81 more passes" and "41", which is the number an organizer
 * uses to decide whether resized is worth switching to.
 *
 * 25 for originals stays deliberately conservative. Observed passes ranged 25 to
 * 50, and for "how much is left" it is better to over-estimate than to promise a
 * finish that does not arrive.
 *
 * Both are estimates, and the resized one is a floor rather than a ceiling: no
 * resized pass has ever actually been stopped by the quota — every one ended
 * because its folder ran out — so the true rate may be well above 600.
 */
const passesLeft = (s: { missing: number; image_source: string }) =>
  Math.ceil(s.missing / (s.image_source === 'thumb' ? 600 : 25));

const reindex = (id: string) =>
  run(id, () => api.admin.reindexSource(id), 'Re-indexing started — already-indexed photos are skipped.');

const setStatus = (s: EventSummary['status']) => run('status', () => api.admin.setStatus(props.id, s));

// Defaults to true while the event is still loading, so the bib panels do not
// flash out and back in on every page load.
const bibsEnabled = computed(() => event.value?.bibs_enabled !== false);

/**
 * Turning bibs off does not delete bibs already read — it stops future passes
 * reading more and hides the ones that exist, so turning it back on restores
 * them without a re-index. Photos already indexed are not re-fetched either
 * way; the change applies to whatever a later pass covers.
 */
const setBibs = (on: boolean) =>
  run('bibs', () => api.admin.setBibsEnabled(props.id, on),
      on
        ? 'Bib numbers on — the next pass will read bibs. Re-index to read them for photos already done.'
        : 'Bib numbers off — bib search is hidden and later passes skip OCR. Existing bibs are kept.');

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
          <template v-if="bibsEnabled">
            <div>
              <div class="stat-label">Photos with a bib</div>
              <div class="stat-value">{{ quality.photos_with_bib }}</div>
            </div>
            <div><div class="stat-label">Distinct bib numbers</div><div class="stat-value">{{ quality.distinct_bibs }}</div></div>
          </template>
        </div>
        <p v-if="bibsEnabled" class="muted small" style="margin-top: var(--s-3)">
          {{ quality.photos_without_bib }} photos have no readable bib and
          {{ quality.photos_without_face }} have no detected face. Some of that is real —
          backs turned, bibs folded or hidden — so treat it as a ceiling on bib search, not a fault.
          Face search is unaffected by a missing bib.
        </p>
        <p v-else class="muted small" style="margin-top: var(--s-3)">
          This event has no bib numbers, so runners find themselves by face.
          {{ quality.photos_without_face }} photos have no detected face — backs turned or
          too distant — and those are the only ones face search cannot return.
        </p>
        <p style="margin-top: var(--s-3)">
          <RouterLink :to="`/admin/e/${id}/photos`" class="btn file-btn">
            Inspect photos — see faces and bibs drawn on each frame
          </RouterLink>
        </p>
        <template v-if="bibsEnabled && report?.top_bibs.length">
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
        <h2>Passes ({{ report?.jobs_total ?? 0 }})</h2>
        <p v-if="!report?.jobs.length" class="muted" style="margin: 0">No indexing passes yet.</p>
        <div v-for="j in visibleJobs" :key="j.id" class="row row-tight">
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
        <div v-if="report?.jobs.length" class="pager">
          <button v-if="visibleJobs.length < report.jobs.length"
                  @click="jobsShown += PAGE">Show more</button>
          <button v-if="jobsShown > PAGE" @click="jobsShown = PAGE">Show fewer</button>
          <span class="muted small">
            Showing {{ visibleJobs.length }} of {{ report.jobs.length }}<template
              v-if="report.jobs_total > report.jobs_returned"> most recent ({{ report.jobs_total }} in total)</template>
          </span>
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
        <p v-if="!filteredLog.length" class="muted small" style="margin: 0">Nothing logged at this level.</p>
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
        <div v-if="filteredLog.length" class="pager">
          <button v-if="visibleLog.length < filteredLog.length"
                  @click="logShown += PAGE">Show more</button>
          <button v-if="logShown > PAGE" @click="logShown = PAGE">Show fewer</button>
          <span class="muted small">
            Showing {{ visibleLog.length }} of {{ filteredLog.length }}<template
              v-if="report && report.log_total > report.log_returned"> most recent ({{ report.log_total }} in total)</template>
          </span>
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
        <p class="muted small">
          Unpublishing hides the event from runners. Photos and search data are kept.
        </p>

        <div class="field-group" style="margin-top: var(--s-4)">
          <label>Bib numbers</label>
          <div class="segmented" role="radiogroup" aria-label="Does this event use bib numbers?">
            <button role="radio" :aria-checked="bibsEnabled" :aria-selected="bibsEnabled"
                    :disabled="busy === 'bibs'"
                    @click="setBibs(true)">Runners wear bibs</button>
            <button role="radio" :aria-checked="!bibsEnabled" :aria-selected="!bibsEnabled"
                    :disabled="busy === 'bibs'"
                    @click="setBibs(false)">No bibs</button>
          </div>
          <p class="muted small" style="margin: var(--s-2) 0 0">
            <template v-if="bibsEnabled">
              Bib numbers are read from each photo so runners can search by number.
            </template>
            <template v-else>
              Bib search is hidden and later passes skip OCR entirely — faster, and no numbers
              invented from signage. Face search is unaffected. Bibs already read are kept, so
              turning this back on restores them without a re-index.
            </template>
          </p>
        </div>
      </div>
    </div>
  </template>
</template>
