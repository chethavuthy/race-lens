<script setup lang="ts">
/**
 * Per-event operations page.
 *
 * The organizer pastes a link and walks away. When an album comes back short
 * they need to answer "which link, how many, and why" — and the only place that
 * lived before was CI logs they have no access to. Everything here is aimed at
 * that one question, plus the action that follows from the answer.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type EventSummary } from '../lib/api';
import { plural } from '../lib/format';

const props = defineProps<{ id: string }>();

type Report = Awaited<ReturnType<typeof api.admin.report>>;

const event = ref<EventSummary | null>(null);
const report = ref<Report | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const busy = ref<string | null>(null);
const notice = ref<string | null>(null);
const levelFilter = ref<'all' | 'error' | 'warn'>('all');
let poll: number | undefined;

const totals = computed(() => {
  const s = report.value?.sources ?? [];
  return {
    links: s.length,
    found: s.reduce((n, x) => n + (x.discovered || 0), 0),
    indexed: s.reduce((n, x) => n + (x.indexed || 0), 0),
    missing: s.reduce((n, x) => n + (x.missing || 0), 0),
  };
});

const activeJob = computed(() =>
  (report.value?.jobs ?? []).find((j) => j.status === 'running' || j.status === 'queued') ?? null,
);

const visibleLog = computed(() => {
  const log = report.value?.log ?? [];
  if (levelFilter.value === 'all') return log;
  return log.filter((l) => l.level === levelFilter.value);
});

async function load(quiet = false) {
  if (!quiet) loading.value = true;
  try {
    const [e, r] = await Promise.all([api.admin.getEvent(props.id), api.admin.report(props.id)]);
    event.value = e.event;
    report.value = r;
    error.value = null;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  // Refresh while a job is in flight so counts and log entries appear live.
  poll = setInterval(() => { if (activeJob.value) load(true); }, 6000) as unknown as number;
});
onBeforeUnmount(() => clearInterval(poll));

async function reindex(sourceId: string) {
  busy.value = sourceId;
  notice.value = null;
  try {
    await api.admin.reindexSource(sourceId);
    notice.value = 'Re-indexing started. Photos already indexed are skipped.';
    await load(true);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = null;
  }
}

async function setStatus(status: EventSummary['status']) {
  busy.value = 'status';
  try {
    await api.admin.setStatus(props.id, status);
    await load(true);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = null;
  }
}

async function onBanner(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  busy.value = 'banner';
  try {
    await api.admin.uploadBanner(props.id, file);
    await load(true);
  } catch (err: any) {
    error.value = err.message;
  } finally {
    busy.value = null;
  }
}

const when = (iso: string) => new Date(iso).toLocaleString();
const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;
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
      <a :href="`/e/${event.slug}`" target="_blank" rel="noopener" style="text-decoration: underline">
        /e/{{ event.slug }}
      </a>
      · {{ event.status }} · {{ plural(event.photo_count, 'photo') }} ·
      {{ plural(event.face_count, 'face') }}
    </p>

    <p v-if="notice" class="notice ok" style="margin-bottom: var(--s-4)">{{ notice }}</p>

    <!-- at-a-glance reconciliation ------------------------------------ -->
    <div class="card" style="margin-bottom: var(--s-4)">
      <h2>Coverage</h2>
      <div style="display: flex; gap: var(--s-6); flex-wrap: wrap">
        <div><div class="muted small">Drive links</div><div style="font-size: var(--t-lg)">{{ totals.links }}</div></div>
        <div><div class="muted small">Found on Drive</div><div style="font-size: var(--t-lg)">{{ totals.found }}</div></div>
        <div><div class="muted small">Indexed</div><div style="font-size: var(--t-lg)">{{ totals.indexed }}</div></div>
        <div>
          <div class="muted small">Still missing</div>
          <div style="font-size: var(--t-lg)" :style="{ color: totals.missing ? 'var(--warn)' : 'var(--ok)' }">
            {{ totals.missing }}
          </div>
        </div>
      </div>
      <p v-if="activeJob" class="notice" style="margin-top: var(--s-4)">
        <span class="spinner" /> A pass is running — {{ activeJob.done }} / {{ activeJob.total }}.
        Indexing continues automatically after a Drive rate limit.
      </p>
      <p v-else-if="totals.missing > 0" class="notice warn" style="margin-top: var(--s-4)">
        {{ totals.missing }} {{ totals.missing === 1 ? 'photo is' : 'photos are' }} not indexed.
        Use <strong>Re-index</strong> on the link below — already-indexed photos are skipped.
      </p>
    </div>

    <!-- per link ------------------------------------------------------- -->
    <div class="card" style="margin-bottom: var(--s-4)">
      <h2>Drive links ({{ totals.links }})</h2>
      <p v-if="!report?.sources.length" class="muted" style="margin: 0">No links bound to this event yet.</p>
      <div v-for="s in report?.sources ?? []" :key="s.id"
           style="padding: var(--s-3) 0; border-bottom: 1px solid var(--line)">
        <div style="display: flex; gap: var(--s-4); align-items: center; flex-wrap: wrap">
          <a :href="folderUrl(s.drive_folder_id)" target="_blank" rel="noopener"
             class="small" style="text-decoration: underline; word-break: break-all; flex: 1; min-width: 220px">
            {{ s.drive_folder_id }}
          </a>
          <span class="small">
            <strong>{{ s.indexed }}</strong> / {{ s.discovered || '?' }} indexed
            <span v-if="s.missing > 0" style="color: var(--warn)"> · {{ s.missing }} missing</span>
            <span v-else-if="s.discovered" style="color: var(--ok)"> · complete</span>
          </span>
          <button :disabled="busy === s.id || !!activeJob" @click="reindex(s.id)">
            <span v-if="busy === s.id" class="spinner" /> Re-index
          </button>
        </div>
      </div>
    </div>

    <!-- jobs ----------------------------------------------------------- -->
    <div class="card" style="margin-bottom: var(--s-4)">
      <h2>Passes ({{ report?.jobs.length ?? 0 }})</h2>
      <p v-if="!report?.jobs.length" class="muted" style="margin: 0">No indexing passes yet.</p>
      <div v-for="j in report?.jobs ?? []" :key="j.id"
           style="padding: var(--s-2) 0; border-bottom: 1px solid var(--line)">
        <div class="small">
          <strong :style="{ color: j.status === 'failed' ? 'var(--err)'
                                 : j.status === 'partial' ? 'var(--warn)'
                                 : j.status === 'done' ? 'var(--ok)' : 'var(--text)' }">
            {{ j.status }}
          </strong>
          · {{ j.done }} / {{ j.total }}
          <span v-if="j.skipped"> · {{ j.skipped }} could not be fetched</span>
          <span v-if="j.attempts"> · {{ j.attempts }} auto-continuation{{ j.attempts === 1 ? '' : 's' }}</span>
          <span class="muted"> · {{ when(j.updated_at) }}</span>
        </div>
        <div v-if="j.error" class="muted small" style="margin-top: 2px">{{ j.error }}</div>
      </div>
    </div>

    <!-- log ------------------------------------------------------------ -->
    <div class="card" style="margin-bottom: var(--s-4)">
      <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--s-4); flex-wrap: wrap">
        <h2 style="margin: 0">Ingest log</h2>
        <div class="btn-row">
          <button v-for="f in (['all', 'error', 'warn'] as const)" :key="f"
                  :aria-pressed="levelFilter === f" @click="levelFilter = f"
                  :style="levelFilter === f ? 'background: var(--accent); border-color: var(--accent); color: var(--accent-ink)' : ''">
            {{ f }}
          </button>
        </div>
      </div>

      <p v-if="report?.summary.length" class="muted small" style="margin: var(--s-3) 0 0">
        <span v-for="c in report.summary" :key="`${c.level}-${c.code}`" style="margin-right: var(--s-3)">
          {{ c.code || c.level }}: {{ c.n }}
        </span>
      </p>

      <p v-if="!visibleLog.length" class="muted small" style="margin: var(--s-3) 0 0">
        Nothing logged at this level.
      </p>
      <div v-for="(l, i) in visibleLog" :key="i"
           style="padding: var(--s-2) 0; border-bottom: 1px solid var(--line)">
        <div class="small">
          <strong :style="{ color: l.level === 'error' ? 'var(--err)' : l.level === 'warn' ? 'var(--warn)' : 'var(--muted)' }">
            {{ l.code || l.level }}
          </strong>
          — {{ l.message }}
        </div>
        <a v-if="l.drive_file_id" class="muted small"
           :href="`https://drive.google.com/file/d/${l.drive_file_id}/view`"
           target="_blank" rel="noopener" style="text-decoration: underline">
          open the photo on Drive
        </a>
      </div>
    </div>

    <!-- actions -------------------------------------------------------- -->
    <div class="card">
      <h2>Actions</h2>
      <div class="btn-row">
        <button v-if="event.status !== 'ready'" class="primary" :disabled="busy === 'status'"
                @click="setStatus('ready')">Publish</button>
        <button v-else :disabled="busy === 'status'" @click="setStatus('draft')">Unpublish</button>
        <label for="ev-banner" class="btn" style="display: inline-flex; align-items: center;
               min-height: var(--tap); cursor: pointer; margin: 0; color: var(--text)">
          <span v-if="busy === 'banner'" class="spinner" style="margin-right: 6px" />
          {{ event.banner_url ? 'Replace banner' : 'Add banner' }}
        </label>
        <input id="ev-banner" type="file" accept="image/*" class="sr-only" @change="onBanner" />
      </div>
      <img v-if="event.banner_url" class="thumb" :src="event.banner_url" alt=""
           style="width: 240px; aspect-ratio: 16/9; margin-top: var(--s-3)" />
      <p class="muted small" style="margin-bottom: 0">
        Unpublishing hides the event from runners; already-indexed photos are kept.
      </p>
    </div>
  </template>
</template>
