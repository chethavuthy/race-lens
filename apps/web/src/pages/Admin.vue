<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type EventSummary, type Job } from '../lib/api';

type Inspection = Awaited<ReturnType<typeof api.admin.inspect>>;

const events = ref<EventSummary[]>([]);
const loadError = ref<string | null>(null);

const driveUrl = ref('');
const inspecting = ref(false);
const inspection = ref<Inspection | null>(null);
const inspectError = ref<string | null>(null);

const mode = ref<'existing' | 'new'>('new');
const targetEventId = ref('');
const newName = ref('');
const newDate = ref('');
const newSlug = ref('');
const bannerFile = ref<File | null>(null);

const imageSource = ref<'original' | 'thumb'>('original');

// Benchmark is opt-in: it costs a CI run, and the answer differs per folder.
type Bench = Awaited<ReturnType<typeof api.admin.getBenchmark>>['benchmark'];
const bench = ref<Bench | null>(null);
const benchBusy = ref(false);
const benchError = ref<string | null>(null);
let benchPoll: number | undefined;

async function runBenchmark() {
  benchError.value = null; benchBusy.value = true; bench.value = null;
  try {
    const { benchmark_id } = await api.admin.startBenchmark(driveUrl.value);
    clearInterval(benchPoll);
    benchPoll = setInterval(async () => {
      try {
        const r = await api.admin.getBenchmark(benchmark_id);
        bench.value = r.benchmark;
        if (['done', 'failed'].includes(r.benchmark.status)) {
          clearInterval(benchPoll); benchBusy.value = false;
          // Only preselect when the sample shows no loss — never silently.
          if (r.benchmark.result && !r.benchmark.result.bibs_only_in_original.length) {
            imageSource.value = 'thumb';
          }
        }
      } catch { /* transient; the next tick retries */ }
    }, 5000) as unknown as number;
  } catch (e: any) { benchError.value = e.message; benchBusy.value = false; }
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

const starting = ref(false);
const startError = ref<string | null>(null);
const job = ref<Job | null>(null);
let poll: number | undefined;

const canStart = computed(() =>
  !!inspection.value &&
  !starting.value &&
  (mode.value === 'existing' ? !!targetEventId.value : !!newName.value.trim()),
);

const progressPct = computed(() => {
  const j = job.value;
  if (!j || !j.total) return 0;
  return Math.min(100, Math.round((j.done / j.total) * 100));
});

async function refreshEvents() {
  try {
    events.value = (await api.admin.listEvents()).events;
  } catch (e: any) {
    loadError.value = e.message;
  }
}

onMounted(refreshEvents);
onBeforeUnmount(() => clearInterval(poll));

async function inspect() {
  inspection.value = null;
  inspectError.value = null;
  inspecting.value = true;
  try {
    inspection.value = await api.admin.inspect(driveUrl.value);
  } catch (e: any) {
    inspectError.value = e.message;
  } finally {
    inspecting.value = false;
  }
}

async function start() {
  startError.value = null;
  starting.value = true;
  try {
    let eventId = targetEventId.value;

    if (mode.value === 'new') {
      const created = await api.admin.createEvent({
        name: newName.value.trim(),
        event_date: newDate.value || undefined,
        slug: newSlug.value.trim() || undefined,
      });
      eventId = created.event.id;
      if (bannerFile.value) await api.admin.uploadBanner(eventId, bannerFile.value);
      await refreshEvents();
      targetEventId.value = eventId;
      mode.value = 'existing';
    }

    const { job_id } = await api.admin.ingest(eventId, driveUrl.value, imageSource.value);
    startPolling(job_id);
  } catch (e: any) {
    startError.value = e.message;
  } finally {
    starting.value = false;
  }
}

function startPolling(jobId: string) {
  clearInterval(poll);
  const tick = async () => {
    try {
      job.value = (await api.admin.getJob(jobId)).job;
      if (['done', 'partial', 'failed'].includes(job.value.status)) {
        clearInterval(poll);
        await refreshEvents();
      }
    } catch {
      // A transient poll failure is not worth tearing the UI down over;
      // the next tick will pick it back up.
    }
  };
  tick();
  poll = setInterval(tick, 4000) as unknown as number;
}

function onBanner(e: Event) {
  bannerFile.value = (e.target as HTMLInputElement).files?.[0] ?? null;
}

const bannerBusy = ref<string | null>(null);
const bannerError = ref<string | null>(null);

/** Upload a banner for any event, not just one being created. */
async function onEventBanner(ev: EventSummary, e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // allow re-picking the same file after a failure
  if (!file) return;
  bannerError.value = null;
  bannerBusy.value = ev.id;
  try {
    await api.admin.uploadBanner(ev.id, file);
    await refreshEvents();
  } catch (err: any) {
    bannerError.value = `${ev.name}: ${err.message}`;
  } finally {
    bannerBusy.value = null;
  }
}

async function publish(ev: EventSummary) {
  await api.admin.setStatus(ev.id, 'ready');
  await refreshEvents();
}
</script>

<template>
  <h1>Organizer</h1>
  <p class="muted" style="margin-top: 0">Paste a public Google Drive folder to index an album.</p>

  <p v-if="loadError" class="notice err">{{ loadError }}</p>

  <!-- Step 1: validate the link before committing to a 40-minute job. -->
  <div class="card" style="margin-top: 20px">
    <h2>1 · Check the Drive folder</h2>
    <form style="display: flex; gap: 10px" @submit.prevent="inspect">
      <input v-model="driveUrl" placeholder="https://drive.google.com/drive/folders/…" aria-label="Drive folder URL" />
      <button class="primary" type="submit" :disabled="inspecting || !driveUrl.trim()">Check</button>
    </form>

    <p v-if="inspecting" class="muted small" style="margin-top: 12px"><span class="spinner" /> Reading the folder…</p>
    <p v-if="inspectError" class="notice err" style="margin-top: 12px">{{ inspectError }}</p>

    <template v-if="inspection">
      <p class="notice ok" style="margin-top: 12px">
        Found {{ inspection.image_count.toLocaleString() }} images
        <template v-if="inspection.subfolder_count">
          across {{ inspection.subfolder_count }} subfolder{{ inspection.subfolder_count === 1 ? '' : 's' }}
        </template>
        <template v-if="inspection.truncated"> (capped — only the first batch will be indexed)</template>
      </p>
      <div class="photo-grid" style="margin-top: var(--s-3); grid-template-columns: repeat(4, 1fr)">
        <figure v-for="s in inspection.samples" :key="s.id">
          <img class="thumb" :src="s.thumb" :alt="s.name" referrerpolicy="no-referrer" loading="lazy" />
        </figure>
      </div>

      <h2 style="margin-top: var(--s-5)">Image quality vs speed</h2>
      <p class="muted small" style="margin-top: 0">
        Full originals are ~21 MB each. Drive also serves a resized copy about 12×
        smaller, which on one album found identical faces and bibs — and because
        Drive's download quota is what stops a pass, that is roughly 12× more
        photos per pass. Whether it holds for <em>this</em> folder is worth checking.
      </p>
      <div class="btn-row">
        <button :disabled="benchBusy" @click="runBenchmark">
          <span v-if="benchBusy" class="spinner" /> Compare on {{ 6 }} photos from this folder
        </button>
      </div>
      <p v-if="benchError" class="notice err" style="margin-top: var(--s-3)">{{ benchError }}</p>
      <p v-if="benchBusy" class="muted small" style="margin-top: var(--s-3)">
        Running in CI — usually 2-4 minutes. You can keep working; the result appears here.
      </p>
      <p v-else-if="bench?.status === 'failed'" class="notice err" style="margin-top: var(--s-3)">
        Benchmark failed: {{ bench.error }}
      </p>

      <template v-if="bench?.result">
        <div class="stats" style="margin-top: var(--s-4)">
          <div>
            <div class="stat-label">Resized (thumb)</div>
            <div class="stat-value">{{ bench.result.thumb.faces }} faces · {{ bench.result.thumb.bibs }} bibs</div>
            <div class="muted small">{{ mb(bench.result.thumb.bytes) }} for {{ bench.result.sampled }} photos</div>
          </div>
          <div>
            <div class="stat-label">Full original</div>
            <div class="stat-value">{{ bench.result.original.faces }} faces · {{ bench.result.original.bibs }} bibs</div>
            <div class="muted small">{{ mb(bench.result.original.bytes) }} for {{ bench.result.sampled }} photos</div>
          </div>
          <div>
            <div class="stat-label">Photos per pass (est.)</div>
            <div class="stat-value">
              {{ bench.result.est_photos_per_pass.thumb }} vs {{ bench.result.est_photos_per_pass.original }}
            </div>
            <div class="muted small">before Drive's quota stops it</div>
          </div>
        </div>
        <p v-if="bench.result.bibs_only_in_original.length" class="notice warn" style="margin-top: var(--s-3)">
          The resized copy MISSED these bibs the original found:
          <strong>{{ bench.result.bibs_only_in_original.join(', ') }}</strong>.
          Use full originals for this folder unless the speed matters more.
        </p>
        <p v-else class="notice ok" style="margin-top: var(--s-3)">
          No loss on this sample — the resized copy found every bib the original did,
          about {{ bench.result.size_ratio }}× smaller.
        </p>
      </template>

      <div class="field-group" style="margin-top: var(--s-4)">
        <label>Download for indexing</label>
        <div class="segmented" role="radiogroup" aria-label="Image source">
          <button role="radio" :aria-checked="imageSource === 'original'"
                  :aria-selected="imageSource === 'original'" @click="imageSource = 'original'">
            Full originals
          </button>
          <button role="radio" :aria-checked="imageSource === 'thumb'"
                  :aria-selected="imageSource === 'thumb'" @click="imageSource = 'thumb'">
            Resized (faster)
          </button>
        </div>
      </div>
    </template>
  </div>

  <!-- Step 2 -->
  <div v-if="inspection" class="card" style="margin-top: 18px">
    <h2>2 · Where do these photos go?</h2>
    <div class="segmented" role="radiogroup" aria-label="Destination for these photos">
      <button role="radio" :aria-checked="mode === 'new'" :aria-selected="mode === 'new'"
              @click="mode = 'new'">New event</button>
      <button role="radio" :aria-checked="mode === 'existing'" :aria-selected="mode === 'existing'"
              @click="mode = 'existing'">Existing event</button>
    </div>

    <template v-if="mode === 'existing'">
      <div class="field-group">
        <label for="target">Event</label>
        <select id="target" v-model="targetEventId">
          <option value="">Choose…</option>
          <option v-for="e in events" :key="e.id" :value="e.id">
            {{ e.name }} ({{ e.photo_count }} photos, {{ e.status }})
          </option>
        </select>
      </div>
    </template>

    <template v-else>
      <div class="field-group">
        <label for="name">Event name</label>
        <input id="name" v-model="newName" placeholder="Phnom Penh Half Marathon 2026" />
      </div>
      <div class="field-group">
        <label for="date">Date</label>
        <input id="date" v-model="newDate" type="date" />
      </div>
      <div class="field-group">
        <label for="slug">URL slug (optional)</label>
        <input id="slug" v-model="newSlug" placeholder="derived from the name" />
      </div>
      <div class="field-group">
        <label for="banner">Banner image (optional)</label>
        <input id="banner" type="file" accept="image/*" @change="onBanner" />
      </div>
    </template>

    <button class="primary" :disabled="!canStart" @click="start">Start indexing</button>
    <p v-if="startError" class="notice err" style="margin-top: 12px">{{ startError }}</p>
  </div>

  <!-- Step 3 -->
  <div v-if="job" class="card" style="margin-top: 18px">
    <h2>3 · Indexing</h2>
    <div class="progress" role="progressbar" :aria-valuenow="progressPct"
         aria-valuemin="0" aria-valuemax="100" :aria-label="`Indexing ${job.status}`">
      <div :style="{ transform: `scaleX(${progressPct / 100})` }" />
    </div>
    <p class="muted small" style="margin-top: 10px">
      {{ job.status }} — {{ job.done.toLocaleString() }} / {{ job.total.toLocaleString() }} photos ({{ progressPct }}%)
    </p>
    <p v-if="job.error" class="notice err">{{ job.error }}</p>
    <p v-if="job.status === 'partial'" class="notice warn">
      Google Drive rate-limits bulk downloads of large photos, so this album needs
      several passes. Indexing continues automatically — everything done so far is
      already live, and you can close this page.
    </p>
    <p v-else-if="job.status === 'queued' && job.done > 0" class="notice">
      <span class="spinner" /> Waiting for the next pass to start…
    </p>
  </div>

  <h2 style="margin-top: var(--s-7)">All events</h2>
  <p v-if="bannerError" class="notice err" style="margin-bottom: var(--s-3)">{{ bannerError }}</p>
  <div class="card">
    <p v-if="!events.length" class="muted" style="margin: 0">No events yet.</p>
    <div v-for="e in events" :key="e.id" class="row">
      <div class="row-main">
        <RouterLink :to="`/admin/e/${e.id}`" class="mono-id" style="font-weight: 600">
          {{ e.name }}
        </RouterLink>
        <div class="muted small">
          /e/{{ e.slug }} · {{ e.status }} · {{ e.photo_count.toLocaleString() }} photos ·
          {{ e.face_count.toLocaleString() }} faces
          <span v-if="bannerBusy === e.id"> · <span class="spinner" /> uploading banner…</span>
        </div>
      </div>
      <img v-if="e.banner_url" class="banner-thumb" :src="e.banner_url" alt="" />
      <div v-else class="banner-thumb" />
      <div class="row-actions">
        <RouterLink :to="`/admin/e/${e.id}`" class="btn file-btn">Open</RouterLink>
        <label :for="`bn-${e.id}`" class="btn file-btn">
          {{ e.banner_url ? 'Replace banner' : 'Add banner' }}
        </label>
        <input :id="`bn-${e.id}`" type="file" accept="image/*" class="sr-only"
               @change="onEventBanner(e, $event)" />
        <button v-if="e.status === 'draft'" @click="publish(e)">Publish</button>
      </div>
    </div>
  </div>
</template>
