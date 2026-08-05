<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
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

    const { job_id } = await api.admin.ingest(eventId, driveUrl.value);
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
      <div class="photo-grid" style="margin-top: 12px; grid-template-columns: repeat(4, 1fr)">
        <figure v-for="s in inspection.samples" :key="s.id">
          <img :src="s.thumb" :alt="s.name" referrerpolicy="no-referrer" />
        </figure>
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
      Some photos could not be downloaded (Drive rate limit). Everything indexed so far is live.
    </p>
  </div>

  <h2 style="margin-top: 32px">All events</h2>
  <div class="card">
    <p v-if="!events.length" class="muted" style="margin: 0">No events yet.</p>
    <div
      v-for="e in events" :key="e.id"
      style="display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line)">
      <div style="flex: 1">
        <div style="font-weight: 600">{{ e.name }}</div>
        <div class="muted small">
          /e/{{ e.slug }} · {{ e.status }} · {{ e.photo_count.toLocaleString() }} photos ·
          {{ e.face_count.toLocaleString() }} faces
        </div>
      </div>
      <button v-if="e.status === 'draft'" @click="publish(e)">Publish</button>
    </div>
  </div>
</template>
