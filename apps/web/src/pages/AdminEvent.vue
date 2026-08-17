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
/**
 * Image size for the link about to be added. Starts unset, and Add link stays
 * disabled until the operator picks one.
 *
 * Deliberately not defaulted. Adding a link dispatches the indexing run in the
 * same request, so whatever this says is committed the moment the button is
 * pressed — and the row's own Original/Resized toggle is disabled while a job
 * is active, which it now is. A default here would therefore not be a starting
 * point the operator could correct; it would be the decision, made silently,
 * with the only way back a full re-index. That was the old behaviour: the form
 * sent no size at all and the API fell through to 'original', so every new
 * folder went to full-size downloads at ~25 photos a round.
 *
 * A photographer never sees this — the API forces 'thumb' for anyone who is not
 * the operator, so for them the form still sends nothing and nothing changes.
 */
const newLinkSource = ref<'original' | 'thumb' | null>(null);
let poll: number | undefined;

/**
 * Operator view. A photographer gets the same page with the machinery folded
 * away: no image-size control, no pass list, and problems in plain words rather
 * than the raw log.
 */
const owner = ref(false);

/** The only part of the log a photographer can act on. */
const problems = computed(() =>
  (report.value?.log ?? []).filter((l) => l.level === 'error' || l.level === 'warn'));
const problemsShown = ref(10);

const totals = computed(() =>
  report.value?.totals ??
  { links: 0, removed_links: 0, found: 0, found_known: true, indexed: 0, missing: 0 });
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

// 'stopped' stays neutral rather than warn: it is the outcome the organizer
// asked for, and colouring their own deliberate act as a problem sends them
// looking for a fault that is not there.
const jobState = (s: string) =>
  s === 'failed' ? 'err' : s === 'partial' ? 'warn' : s === 'done' ? 'ok' : 'idle';

/**
 * A stop already asked for but not yet acted on. The runner honours it between
 * batches, so there is a real interval — up to one batch — where the pass is
 * still indexing and the button must not invite a second press.
 */
const stopping = computed(() => !!activeJob.value?.stop_requested);

/**
 * There is no Resume, on purpose. Every photo a pass finishes is marked
 * faces_done and skipped by the next resume, so Continue — the button already
 * on the row — is the resume. A second control that did the same thing under a
 * different name would only raise the question of how they differ.
 */
function stopJob() {
  const job = activeJob.value;
  if (!job) return;
  run('stop', () => api.admin.stopJob(job.id),
      'Stopping — the pass ends after the batch in progress, which can take a '
      + 'few minutes. Everything indexed so far stays live.');
}

async function load(quiet = false) {
  if (!quiet) loading.value = true;
  try {
    const [e, r] = await Promise.all([api.admin.getEvent(props.id), api.admin.report(props.id)]);
    event.value = e.event; report.value = r; error.value = null;
  } catch (e: any) { error.value = e.message; } finally { loading.value = false; }
}

onMounted(async () => {
  // A failure here is not worth a banner: it can only mean the page is about to
  // fail its own load, which load() reports properly.
  await api.admin.me().then((me) => { owner.value = me.owner; }).catch(() => {});
  await load();
  // 15s and only while visible, not 6s regardless.
  //
  // load() fetches getEvent AND the report, and the report is eight aggregate
  // queries — COUNT(*) over photos, faces, jobs and ingest_log, COUNT(DISTINCT)
  // over faces and bibs twice, plus two GROUP BYs. A rate-limited album polls this
  // for hours across up to 61 continuation passes. The author had already bounded
  // the jobs and log LISTS for exactly this reason; the aggregates were missed.
  //
  // Still the same endpoint on purpose: it is the only source of the server-computed
  // `stale` flag that activeJob and stalledJob depend on, so swapping to the cheap
  // /jobs route would break stall detection and the jobs pager.
  poll = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (activeJob.value) load(true);
  }, 15000) as unknown as number;
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
      // Named by what it does, not by what the button says: the label on that
      // row is Continue or Recheck depending on whether photos are missing, and
      // a message that hardcodes one of them is wrong half the time.
      v === 'thumb'
        ? 'Switched to resized copies — run the album again to carry on at the faster rate.'
        : 'Switched to full originals — run the album again to carry on.');

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
  run(id, () => api.admin.reindexSource(id), 'Indexing started — photos already done are skipped.');

type Source = Report['sources'][number];

/**
 * Whether this album is finished as of the last walk of the folder.
 *
 * Same condition as the "complete" badge, deliberately — the badge and the
 * button beside it are two readings of one fact, and letting them drift is how
 * a row comes to say "complete" next to a control that claims work is left.
 *
 * `discovered_known` is part of it: a source whose total Drive has not reported
 * yet has missing === 0 without being finished, and calling that complete would
 * be a guess.
 */
const isComplete = (s: Source) => s.missing === 0 && s.discovered_known;

/* ------------------------------------------------------------------ credit --
   The byline under the event title. Held as a per-row draft rather than bound
   straight to the report, because the report is re-fetched every 15s while a
   pass runs and that would wipe half-typed names. */
const creditEdits = ref<Record<string, string>>({});
const creditValue = (s: Source) => creditEdits.value[s.id] ?? s.credit_name ?? '';
const creditDirty = (s: Source) => creditValue(s).trim() !== (s.credit_name ?? '');

const saveCredit = (s: Source) =>
  run(`credit-${s.id}`, async () => {
    await api.admin.setCredit(s.id, creditValue(s).trim());
    // Drop the draft so the row falls back to the stored value the reload brings.
    delete creditEdits.value[s.id];
  }, 'Credit saved — it shows under the event title and above the photos.');

/* --------------------------------------------------------------- takedown --
   A photographer messages @chethavuthy on Telegram; this is the control that
   answers them. */

/** Photos deleted so far in the current removal, for the button's progress. */
const removing = ref<{ id: string; purged: number } | null>(null);

/**
 * Take one link off the site and delete everything indexed from it.
 *
 * The API purges in batches and reports what is left, so this loops until the
 * album is gone: a single request cannot delete 8,000 photos inside a Worker's
 * limits, and the albums where this matters most are the big ones. The link is
 * already invisible to the public site after the first call — the loop is
 * finishing the deletion, not the hiding.
 */
async function removeLink(s: Source) {
  const label = s.credit_name || s.drive_folder_id;
  const ok = confirm(
    `Take ${label}'s link off the site?\n\n` +
    `${plural(s.indexed, 'indexed photo')} will be deleted — thumbnails, faces and bibs with ` +
    `them. The link cannot be re-indexed until you restore it.\n\nThis cannot be undone.`,
  );
  if (!ok) return;

  busy.value = `rm-${s.id}`;
  removing.value = { id: s.id, purged: 0 };
  try {
    for (;;) {
      const r = await api.admin.removeSource(s.id);
      removing.value = { id: s.id, purged: removing.value.purged + r.purged };
      if (r.remaining === 0) break;
      // A round that deleted nothing while claiming photos remain would spin this
      // loop against the API forever. Stop and say so; the link is already hidden,
      // and pressing Remove again resumes the purge.
      if (r.purged === 0) {
        throw new Error(
          `The link is off the site, but ${r.remaining.toLocaleString()} photos could not be ` +
          `deleted. Press Remove again to retry.`,
        );
      }
    }
    notice.value =
      `Link removed — ${removing.value.purged.toLocaleString()} photos deleted. It is off the ` +
      `public page and will not be re-indexed.`;
    error.value = null;
  } catch (e: any) {
    error.value = e.message;
    notice.value = null;
  } finally {
    busy.value = null;
    removing.value = null;
    await load(true);
  }
}

/** Clear a removal. Does not restore the photos — another indexing round does. */
const restoreLink = (s: Source) =>
  run(`restore-${s.id}`, () => api.admin.restoreSource(s.id),
      'Removal cleared. The photos are still deleted — run the album again to fetch it.');

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
        ? 'Bib numbers on — the next round will read bibs. Run the album again to read them for photos already done.'
        : 'Bib numbers off — bib search is hidden and later rounds skip reading numbers. Existing bibs are kept.');

/**
 * Shortest number that counts as a bib at this race, as printed.
 *
 * Defaults to 3 while the event loads and for any event that predates the
 * setting — the value bibs.py hard-coded, which is what Angkor was tuned for.
 */
const bibMinDigits = computed(() => event.value?.bib_min_digits ?? 3);

/** Per-option wording. 5 is exactly five, because the ceiling is 5 everywhere. */
const BIB_DIGIT_HINTS: Record<number, string> = {
  2: 'Bibs as short as two digits, like 46',
  3: 'Bibs as short as three digits, like 056 — the usual case',
  4: 'Bibs as short as four digits, like 0092',
  5: 'Only five-digit bibs, like 10092',
};

/**
 * Operator only, and deliberately not offered to photographers: it is the one
 * bib setting that can silently empty an album's search in either direction.
 * Too high discards every bib at a race printing shorter ones — SheRuns read 0
 * bibs across 199 faces under a floor of 3. Too low lets a partial read of a
 * longer number in, where it is indistinguishable from a real short bib.
 */
const bibMaxDigits = computed(() => event.value?.bib_max_digits ?? 5);
const bibPrefixes = computed(() => event.value?.bib_prefixes ?? '');
const bibPrefixRequired = computed(() => event.value?.bib_prefix_required === true);
const prefixInput = ref<string | null>(null);

/**
 * Every message here ends the same way, and it is the important half.
 *
 * A changed rule applies only to what LATER passes read. Tokens an earlier pass
 * rejected were never stored, so there is nothing to reinterpret — and Recheck
 * cannot do it either, since it skips photos already indexed. Only a bibs-only
 * pass re-reads them. Saying "run the album again" was not enough: it sent an
 * operator to Recheck, which correctly reported everything already indexed and
 * read no bibs at all.
 */
const REREAD_NOTE = ' Photos already indexed keep the numbers they have — Recheck '
  + 'will not change them, because it only looks at photos that are not indexed yet. '
  + 'Ask for a bib re-read to apply this to the whole album.';

const setBibDigits = (n: number) =>
  run('bibdigits', () => api.admin.setBibRules(props.id, { bib_min_digits: n }),
      `Shortest bib is now ${n} digits.` + REREAD_NOTE);

const setBibMax = (n: number) =>
  run('bibmax', () => api.admin.setBibRules(props.id, { bib_max_digits: n }),
      `Longest bib is now ${n} digits.` + REREAD_NOTE);

/**
 * "Every bib has a letter" — for a race with no bare numbers at all.
 *
 * It buys precision the letter whitelist alone cannot. When a pass reads the
 * digits but misses the letter, the bare number it would store belongs to
 * whoever owns those digits; where no bare numbers exist, rejecting the read
 * loses one photo instead of filing a runner under a stranger's bib.
 */
const setBibPrefixRequired = (on: boolean) =>
  run('bibreq', () => api.admin.setBibRules(props.id, { bib_prefix_required: on }),
      (on
        ? 'Every bib must now start with a letter — a number read without one is ignored.'
        : 'Plain numbers count as bibs again, alongside the lettered ones.')
      + REREAD_NOTE);

/** '' clears the list back to digits only. */
const saveBibPrefixes = () => {
  const value = (prefixInput.value ?? bibPrefixes.value).trim();
  run('bibprefix', async () => {
    await api.admin.setBibRules(props.id, { bib_prefixes: value });
    prefixInput.value = null;      // fall back to whatever the server stored
  }, value
    ? `Bibs may start with ${value.toUpperCase()}.` + REREAD_NOTE
    : 'Bibs are digits only now.' + REREAD_NOTE);
};

function addLink() {
  const url = newLink.value.trim();
  if (!url) return;
  // An operator with no pick is a bug in the disabled state above, not something
  // to paper over with a default — see newLinkSource.
  if (owner.value && !newLinkSource.value) return;
  const size = newLinkSource.value ?? undefined;
  run('add', async () => {
    await api.admin.ingest(props.id, url, size);
    newLink.value = '';
    newLinkSource.value = null;
    // Named after what the API will actually do, which for a photographer is
    // 'thumb' regardless of what this form sent — so their message must not be
    // derived from `size`, which is always undefined for them.
  }, !owner.value
    ? 'Link added — indexing started.'
    : size === 'thumb'
      ? 'Link added — indexing started on Drive’s resized copies.'
      : 'Link added — indexing started on full originals.');
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
        <!-- Stop lives here rather than on the Drive-link row because it acts on
             the PASS, not the folder — and this banner is the only place the
             pass itself is represented. Operator only: a photographer cannot
             start one either. -->
        <!-- A div, not a p: the button was INSIDE the paragraph, so on a phone it
             wrapped into the middle of the sentence and landed after "page." as
             though it were a word. A control never belongs in running prose. -->
        <div v-if="activeJob" class="notice" style="margin-top: var(--s-4)">
          <p style="margin: 0">
            <template v-if="stopping">
              <span class="spinner" /> Stopping after the batch in progress —
              {{ activeJob.done }} / {{ activeJob.total }} done so far. Everything already
              indexed stays live, and <strong>Continue</strong> picks up from here.
            </template>
            <template v-else>
              <span class="spinner" /> Indexing now — {{ activeJob.done }} / {{ activeJob.total }}.
              A big album is done in rounds, and it carries on by itself. You can close
              this page.
            </template>
          </p>
          <button v-if="owner" class="notice-action"
                  :disabled="busy === 'stop' || stopping"
                  title="Finish the batch in progress, then stop. Nothing indexed is lost."
                  @click="stopJob">
            <span v-if="busy === 'stop'" class="spinner" />
            {{ stopping ? 'Stopping…' : 'Stop' }}
          </button>
        </div>
        <p v-else-if="stalledJob" class="notice warn" style="margin-top: var(--s-4)">
          A round stopped early. Nothing is lost — press <strong>Continue</strong> to pick up
          where it left off.
        </p>
        <p v-else-if="totals.missing > 0" class="notice warn" style="margin-top: var(--s-4)">
          {{ plural(totals.missing, 'photo') }} not indexed yet. Press <strong>Continue</strong> on the
          link below — photos already done are skipped.
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
        <h2>
          Drive links ({{ totals.links }})
          <span v-if="totals.removed_links" class="muted small">
            + {{ totals.removed_links }} removed
          </span>
        </h2>
        <p v-if="!report?.sources.length" class="muted" style="margin: 0">No links bound yet.</p>
        <div v-for="s in report?.sources ?? []" :key="s.id" class="row">
          <div class="row-main">
            <a :href="`https://drive.google.com/drive/folders/${s.drive_folder_id}`"
               target="_blank" rel="noopener" class="mono-id">{{ s.drive_folder_id }}</a>
            <div class="muted small">added {{ when(s.added_at) }}</div>
            <!-- The byline the event page shows. Left empty, that album is
                 credited by its link alone. -->
            <form class="credit-edit" @submit.prevent="saveCredit(s)">
              <label class="sr-only" :for="`credit-${s.id}`">Credit this photographer as</label>
              <input :id="`credit-${s.id}`" :value="creditValue(s)" maxlength="80"
                     :placeholder="s.removed_at ? 'Removed' : 'Credit as… e.g. Sok Dara'"
                     :disabled="!!s.removed_at"
                     @input="creditEdits[s.id] = ($event.target as HTMLInputElement).value" />
              <button type="submit" :disabled="!creditDirty(s) || busy === `credit-${s.id}`">
                <span v-if="busy === `credit-${s.id}`" class="spinner" /> Save
              </button>
            </form>
          </div>
          <span v-if="s.removed_at" class="small">
            <span class="state err">removed</span>
            <span class="muted"> · {{ when(s.removed_at) }}</span>
            <span v-if="s.indexed > 0" class="muted small" style="display: block">
              {{ s.indexed.toLocaleString() }} photos still to delete
            </span>
          </span>
          <span v-else class="small">
            <strong>{{ s.indexed }}</strong> / {{ s.discovered_known ? s.discovered : '?' }} indexed
            <span v-if="s.missing > 0" class="state warn"> · {{ s.missing }} missing</span>
            <span v-else-if="s.discovered_known" class="state ok"> · complete</span>
            <span v-else class="muted"> · total unknown until the next pass</span>
            <span v-if="s.missing > 0" class="muted small" style="display: block">
              about {{ passesLeft(s) }} more {{ passesLeft(s) === 1 ? 'round' : 'rounds' }} to go
            </span>
          </span>
          <div class="row-actions">
            <template v-if="s.removed_at">
              <!-- Enabled only while photos remain: a purge that was interrupted
                   (a closed tab, a failed round) is resumed by pressing it again,
                   and once the album is gone the control has nothing left to do. -->
              <button :disabled="busy === `rm-${s.id}` || s.indexed === 0" @click="removeLink(s)">
                <span v-if="busy === `rm-${s.id}`" class="spinner" />
                {{ s.indexed > 0 ? 'Finish deleting' : 'Deleted' }}
              </button>
              <button :disabled="busy === `restore-${s.id}`" @click="restoreLink(s)">
                <span v-if="busy === `restore-${s.id}`" class="spinner" /> Restore link
              </button>
            </template>
            <template v-else>
              <!-- Operator only, and the API refuses 'original' from anyone
                   else — the control is hidden because the choice is made, not
                   to keep it out of reach. -->
              <div v-if="owner" class="segmented tiny" role="group" aria-label="Image size to download">
                <button :aria-selected="s.image_source !== 'thumb'"
                        :disabled="busy === `src-${s.id}` || !!activeJob"
                        title="Download the full-size original from Drive"
                        @click="setSource(s.id, 'original')">Original</button>
                <button :aria-selected="s.image_source === 'thumb'"
                        :disabled="busy === `src-${s.id}` || !!activeJob"
                        title="Download Drive's resized copy — same faces and bibs, many more photos per round"
                        @click="setSource(s.id, 'thumb')">Resized</button>
              </div>
              <!-- One action, two honest names. It always starts a round that
                   re-walks the folder; what that is FOR depends on the row.
                   With photos missing it carries on ("Continue"). With none it
                   picks up whatever the photographer has added since, and
                   applies a changed setting to photos already done — neither of
                   which is "continuing" anything, and saying so beside a row
                   marked complete reads as a contradiction.

                   Recheck rather than "Check for new photos": .row-actions
                   sizes to its content, so a long label on some rows only would
                   knock Remove out of line with the rows above it. The title
                   carries the precision the seven characters cannot. -->
              <button :disabled="busy === s.id || !!activeJob"
                      :title="isComplete(s)
                        ? 'Re-scan the Drive folder for photos added since the last round'
                        : 'Index the photos not done yet'"
                      @click="reindex(s.id)">
                <span v-if="busy === s.id" class="spinner" />
                {{ isComplete(s) ? 'Recheck' : 'Continue' }}
              </button>
              <!-- The photographer's own request, and the only destructive control
                   on this page — so it is styled as one and confirms first. -->
              <button class="danger" :disabled="busy === `rm-${s.id}` || !!activeJob"
                      title="The photographer asked for this album to be taken down"
                      @click="removeLink(s)">
                <span v-if="busy === `rm-${s.id}`" class="spinner" />
                {{ removing?.id === s.id
                    ? `Removing… ${removing.purged.toLocaleString()} deleted`
                    : 'Remove' }}
              </button>
            </template>
          </div>
        </div>

        <!-- The size is chosen HERE, before the link is added, because adding it
             starts the run. The matching toggle on the row above only exists
             once the source row does, and it is disabled while a job is active
             — so by the time it appears, the download it governs is already
             under way and the setting cannot be changed without a re-index.
             type="button" on both: a bare <button> inside a <form> submits. -->
        <!-- Stacked rather than one flex row. On a phone the URL box, an unlabelled
             Original/Resized pair and Add link were sharing a line, so the size
             choice read as two dead buttons with nothing saying what they governed
             — and it is a REQUIRED choice, which makes that the worst thing to
             leave ambiguous. -->
        <form class="add-link" @submit.prevent="addLink">
          <input v-model="newLink" class="add-link-url"
                 placeholder="Add another Drive folder URL…" />
          <div v-if="owner" class="add-link-size">
            <span :class="['add-link-label', { req: newLink.trim() && !newLinkSource }]">
              Download at
            </span>
            <div class="segmented tiny" role="radiogroup"
                 aria-label="Image size to download for this link">
              <button type="button" role="radio"
                      :aria-checked="newLinkSource === 'original'"
                      :aria-selected="newLinkSource === 'original'"
                      :disabled="busy === 'add'"
                      title="Full-size originals — about 25 photos a round"
                      @click="newLinkSource = 'original'">Original</button>
              <button type="button" role="radio"
                      :aria-checked="newLinkSource === 'thumb'"
                      :aria-selected="newLinkSource === 'thumb'"
                      :disabled="busy === 'add'"
                      title="Drive's resized copy — same faces and bibs, about 600 photos a round"
                      @click="newLinkSource = 'thumb'">Resized</button>
            </div>
          </div>
          <button class="primary add-link-go" type="submit"
                  :title="owner && !newLinkSource ? 'Pick Original or Resized first' : undefined"
                  :disabled="busy === 'add' || !newLink.trim() || (owner && !newLinkSource)">
            <span v-if="busy === 'add'" class="spinner" /> Add link
          </button>
        </form>
        <!-- Only once there is something to decide about: an empty box asking
             for a size before a URL exists is noise. -->
        <p v-if="owner && newLink.trim() && !newLinkSource" class="muted small"
           style="margin: 0 0 var(--s-3)">
          Pick a size first — it cannot be changed once indexing starts. Resized
          moves about 600 photos a round against roughly 25 for originals, for the
          same faces and bibs.
        </p>
      </div>

      <!-- What a photographer needs from the pass list and the log: whether
           anything was skipped, and which photo. The counts, states, attempt
           chains and codes underneath answer questions only the operator asks. -->
      <div v-if="!owner" class="card">
        <h2>Photos that could not be read</h2>
        <p v-if="!problems.length" class="muted" style="margin: 0">
          None so far — every photo Race Lens fetched went in.
        </p>
        <template v-else>
          <p class="muted small" style="margin: 0 0 var(--s-2)">
            {{ plural(problems.length, 'photo') }} skipped. Usually the file is a video, is
            damaged, or was still uploading to Drive when indexing reached it.
          </p>
          <div v-for="(l, i) in problems.slice(0, problemsShown)" :key="i" class="row row-tight">
            <div class="row-main small">
              {{ l.message }}
              <a v-if="l.drive_file_id" class="muted small mono-id" style="margin-left: var(--s-2)"
                 :href="`https://drive.google.com/file/d/${l.drive_file_id}/view`"
                 target="_blank" rel="noopener">open photo</a>
            </div>
          </div>
          <div v-if="problems.length > 10" class="pager">
            <button v-if="problemsShown < problems.length" @click="problemsShown += 10">Show more</button>
            <button v-else @click="problemsShown = 10">Show fewer</button>
            <span class="muted small">
              Showing {{ Math.min(problemsShown, problems.length) }} of {{ problems.length }}
            </span>
          </div>
        </template>
      </div>

      <!-- passes -->
      <div v-if="owner" class="card">
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
      <div v-if="owner" class="card">
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
        <!-- Same presentation as the public listing, so this preview answers
             "how will runners see it" rather than showing a cropped variant
             nobody else gets. -->
        <div v-if="event.banner_url" class="banner-box banner-lg">
          <img class="banner-fill" :src="event.banner_url" alt="" aria-hidden="true" />
          <img class="banner-img" :src="event.banner_url" alt="Event banner" />
        </div>
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

        <!-- Only where it can matter: an event with no bibs has no shortest bib,
             and a photographer cannot act on this even if they knew the answer.
             Sits under the bibs toggle because it is meaningless without it. -->
        <div v-if="owner && bibsEnabled" class="field-group" style="margin-top: var(--s-4)">
          <label>Shortest bib number — digits</label>
          <div class="segmented" role="radiogroup" aria-label="Shortest bib number at this race, in digits">
            <!-- 2 to 5, matching what the API accepts and what MAX_DIGITS allows.
                 Offering fewer than the API does is how "what if it is 5 digits"
                 becomes an unanswerable question in the UI. 5 means exactly five,
                 since the ceiling is 5 for every event. -->
            <button v-for="n in [2, 3, 4, 5]" :key="n" role="radio"
                    :aria-checked="bibMinDigits === n" :aria-selected="bibMinDigits === n"
                    :disabled="busy === 'bibdigits' || !!activeJob"
                    :title="BIB_DIGIT_HINTS[n]"
                    @click="setBibDigits(n)">{{ n }}</button>
          </div>
          <p class="muted small" style="margin: var(--s-2) 0 0">
            How many digits the bibs at this race are printed with, at the
            shortest. Anything shorter is ignored, because a short number is
            usually half of a longer one misread — and a bib invented that way
            puts a stranger's photo in someone's results.
            <template v-if="bibMinDigits > 2">
              If this race hands out two-digit bibs, this is why none are found.
            </template>
            <template v-else>
              Two-digit bibs are read. Numbers on signage and kit are more likely
              to slip through at this setting, so check a few photos.
            </template>
          </p>
        </div>

        <!-- The ceiling, beside the floor: a floor alone cannot exclude numbers
             LONGER than the bibs, and at a two-digit race every longer number is
             junk. SheRuns stored 2025/2024/2026 off banners and 100 off a distance
             marker until this existed. -->
        <div v-if="owner && bibsEnabled" class="field-group" style="margin-top: var(--s-4)">
          <label>Longest bib number — digits</label>
          <div class="segmented" role="radiogroup" aria-label="Longest bib number at this race, in digits">
            <button v-for="n in [2, 3, 4, 5]" :key="n" role="radio"
                    :aria-checked="bibMaxDigits === n" :aria-selected="bibMaxDigits === n"
                    :disabled="busy === 'bibmax' || !!activeJob || n < bibMinDigits"
                    :title="n < bibMinDigits
                      ? `Cannot be shorter than the shortest bib (${bibMinDigits})`
                      : `Bibs no longer than ${n} digits`"
                    @click="setBibMax(n)">{{ n }}</button>
          </div>
          <p class="muted small" style="margin: var(--s-2) 0 0">
            <template v-if="bibMinDigits === bibMaxDigits">
              Bibs here are exactly {{ bibMinDigits }} digits. Every other number in
              the photo — a year on a banner, a distance marker — is ignored.
            </template>
            <template v-else>
              Longer numbers are ignored. Set this to match the race and numbers off
              signage stop being read as bibs.
            </template>
          </p>
        </div>

        <!-- Category letters. Only shown to the operator, and phrased around what
             is printed on the bib rather than around prefixes as a concept. -->
        <div v-if="owner && bibsEnabled" class="field-group" style="margin-top: var(--s-4)">
          <label for="bibpfx">Category letters on bibs</label>
          <div class="row" style="border-bottom: 0; padding-top: 0">
            <input id="bibpfx" class="row-main" placeholder="none — e.g. F, M"
                   :value="prefixInput ?? bibPrefixes"
                   :disabled="busy === 'bibprefix' || !!activeJob"
                   @input="prefixInput = ($event.target as HTMLInputElement).value"
                   @keyup.enter="saveBibPrefixes" />
            <button :disabled="busy === 'bibprefix' || !!activeJob" @click="saveBibPrefixes">
              <span v-if="busy === 'bibprefix'" class="spinner" /> Save
            </button>
          </div>
          <p class="muted small" style="margin: var(--s-2) 0 0">
            <template v-if="bibPrefixes">
              Bibs may be plain numbers or start with
              <strong>{{ bibPrefixes.split(',').join(' / ') }}</strong> —
              <code>{{ bibPrefixes.split(',')[0] }}-0001</code> and
              <code>0001</code> are different runners, and stay separate in search.
            </template>
            <template v-else>
              Leave empty if bibs are plain numbers. If this race numbers by
              category — <code>0001</code> for the marathon, <code>F-0001</code> and
              <code>M-0001</code> for the 10k — list the letters here. Without them
              a bib with a letter is read and then discarded, and no digit setting
              recovers it.
            </template>
          </p>

          <!-- Only once there are letters to require. Sits inside the prefixes
               block because it is meaningless without them, and the API refuses
               it in that state rather than storing a contradiction. -->
          <div v-if="bibPrefixes" style="margin-top: var(--s-4)">
            <label>Do any bibs have no letter?</label>
            <div class="segmented" role="radiogroup"
                 aria-label="Whether every bib at this race carries a category letter">
              <button role="radio" :aria-checked="!bibPrefixRequired"
                      :aria-selected="!bibPrefixRequired"
                      :disabled="busy === 'bibreq' || !!activeJob"
                      title="Some bibs are plain numbers, like 0001 for the marathon"
                      @click="setBibPrefixRequired(false)">Mixed — some plain</button>
              <button role="radio" :aria-checked="bibPrefixRequired"
                      :aria-selected="bibPrefixRequired"
                      :disabled="busy === 'bibreq' || !!activeJob"
                      title="Every bib starts with a category letter"
                      @click="setBibPrefixRequired(true)">Every bib has a letter</button>
            </div>
            <p class="muted small" style="margin: var(--s-2) 0 0">
              <template v-if="bibPrefixRequired">
                A number read without a letter is ignored rather than stored. That
                loses the occasional photo where the letter was folded or out of
                frame — but it cannot file a runner under someone else's number,
                which is what storing the bare digits would do.
              </template>
              <template v-else>
                Plain numbers count too, so <code>0001</code> and
                <code>{{ bibPrefixes.split(',')[0] }}-0001</code> are two different
                runners. If a pass reads the digits but misses the letter, that photo
                lands on the plain number — pick the other option if this race has no
                plain bibs at all.
              </template>
            </p>
          </div>
        </div>
      </div>
    </div>
  </template>
</template>
