<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { ApiError, api, type EventSummary, type Job, type Organizer } from '../lib/api';

type Inspection = Awaited<ReturnType<typeof api.admin.inspect>>;

const events = ref<EventSummary[]>([]);
const loadError = ref<string | null>(null);

const TELEGRAM = 'https://t.me/chethavuthy';

/**
 * Set when this visitor is outside the Access door, and which side of it.
 *
 * The page itself is public on purpose — Access fronts /api/admin and
 * /admin/signin, not /admin — so a photographer who has never heard of this can
 * read what it does and ask to be let in. Everything below the invitation needs
 * the API, so when the API refuses there is nothing else worth rendering.
 *
 * These are not the same person, and the difference decides what the invitation
 * offers them. 'anonymous' has no session and needs the sign-in link. 'unlisted'
 * is signed in as somebody this service does not know — most often the wrong
 * Google account, since Access sends you back in with whatever session the
 * browser already has — and needs the way out. 'removed' had access and lost it;
 * signing out and back in changes nothing, so it is not offered.
 */
type Gate = 'anonymous' | 'unlisted' | 'removed';
const gated = ref<Gate | null>(null);

/**
 * Cloudflare's own logout. Same origin, because the app-domain endpoint clears
 * the authorization cookie from this host immediately; the team-domain one
 * revokes the same session but leaves the cookie here to expire on its own.
 * The cookies are gone from the browser at once, so this page reverts to the
 * invitation on the very next load; Cloudflare's own revocation reaches the edge
 * 20-30 seconds later, which only matters to a token already in flight.
 *
 * returnTo brings them back here instead of stranding them on Cloudflare's
 * "you have been logged out" page, which says nothing about Race Lens and offers
 * no way back. It is UNDOCUMENTED — the session-management page describes no such
 * parameter — but it is what the endpoint actually does, verified against the
 * live host: with it the response is a 302 to this URL that also expires
 * CF_Authorization, CF_Binding, CF_Device and CF_Session; without it the response
 * is a 200 carrying Cloudflare's page and no Set-Cookie at all.
 *
 * If Cloudflare ever drops the parameter this degrades to what it replaced —
 * still logged out, just landing on their page — so it is safe to depend on for
 * the destination and not for the logout itself.
 *
 * Built from location.origin rather than a constant: two hostnames serve this
 * app, the Access cookie is scoped to whichever one you are on, and sending a
 * photographer to the other one would land them signed out on a host they never
 * signed in to. Same-origin by construction, so it cannot become an open
 * redirect for someone else's URL.
 */
const LOGOUT = `/cdn-cgi/access/logout?returnTo=${encodeURIComponent(`${location.origin}/admin`)}`;

/**
 * Nothing is rendered until the answer is known.
 *
 * `gated` cannot be read from the URL — only the API knows — so a page that
 * assumes either answer while it asks will show the wrong one first. Assuming
 * "not gated" put the indexing tool and an empty "All events" list in front of
 * every stranger for the length of a round trip, then swapped it for the
 * invitation. Assuming the opposite would flash the invitation at the operator.
 * A moment of one honest line is better than either.
 */
const checking = ref(true);

/**
 * Several different failures all mean "not through the door", and none deserves
 * a red banner — but they are told apart here, because the way out differs.
 *
 * The Worker's `code` decides it, NOT the 403 alone. It answers 403 for four
 * distinct reasons, and reading only the status told the operator "this account
 * isn't on the list" while running against the workers.dev origin, where admin
 * is refused by hostname and no list was ever consulted. A wrong diagnosis sends
 * someone hunting for the wrong fix; 'no_access' means the request never
 * presented an identity this Worker would look up, which is the anonymous case.
 *
 * A caller with no Access cookie at all never reaches the Worker: Access 302s
 * the XHR to the cross-origin login page, and fetch() reports only "Failed to
 * fetch" with no status to read. The public API separates that from a genuinely
 * dead connection — same origin, no gate, so if it answers, the problem was the
 * gate.
 */
async function accessDenial(e: unknown): Promise<Gate | null> {
  if (e instanceof ApiError) {
    if (e.status !== 403) return null;
    if (e.code === 'not_invited') return 'unlisted';
    if (e.code === 'banned') return 'removed';
    return 'anonymous';
  }
  try {
    await api.listEvents();
    return 'anonymous';
  } catch {
    return null;
  }
}

const driveUrl = ref('');
const inspecting = ref(false);
const inspection = ref<Inspection | null>(null);
const inspectError = ref<string | null>(null);

const mode = ref<'existing' | 'new'>('new');
const targetEventId = ref('');
const newName = ref('');
// Most races pin a number on every runner, so bibs default to on. Fun runs and
// community runs often hand out none at all, and for those the bib pipeline can
// only waste OCR time and invent numbers off signage.
const bibsEnabled = ref(true);
const newDate = ref('');
const newSlug = ref('');
const bannerFile = ref<File | null>(null);

/**
 * Photographers never see this, and never send anything but 'thumb'.
 *
 * Resized copies are what actually finishes an album: Google Drive limits how
 * many bytes come out per window, so full-size originals crawl and need
 * somebody watching them. The faces and bibs come out the same. The API forces
 * the same thing, so this is a default rather than the rule itself.
 */
const imageSource = ref<'original' | 'thumb'>('thumb');

/** Operator view: image sizes, the folder comparison, passes and the log. */
const owner = ref(false);

// The comparison is opt-in: it spends a processing run, and the answer differs
// per folder.
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
/** Which event the running job is filling, since the form no longer says. */
const jobEvent = ref<{ id: string; name: string } | null>(null);
/** Bumped to remount the file input, whose value the DOM owns. */
const formNonce = ref(0);
let poll: number | undefined;

const canStart = computed(() =>
  !!inspection.value &&
  !starting.value &&
  (mode.value === 'existing' ? !!targetEventId.value : !!newName.value.trim()),
);

/**
 * Mine and everyone else's, separated.
 *
 * One flat list stopped being readable the moment photographers could publish:
 * the operator's own races sat interleaved with albums somebody else uploaded,
 * with nothing on the row to say which was which. Ownership is the only
 * distinction that matters here — it decides who to talk to when an album looks
 * wrong — so it splits the list rather than hiding in a column.
 *
 * NULL owner_email means the event predates ownership, which makes it the
 * operator's. `me` is unset for a photographer, but they only ever receive their
 * own events, so everything lands in "mine" and the other group stays empty.
 */
const me = ref<string | null>(null);

const isMine = (e: EventSummary) =>
  !owner.value || !e.owner_email || e.owner_email.toLowerCase() === (me.value ?? '').toLowerCase();

const eventGroups = computed(() => {
  const mine = events.value.filter(isMine);
  const theirs = events.value.filter((e) => !isMine(e));
  const groups = [
    { key: 'mine', title: owner.value ? 'My events' : 'Your events', events: mine, showOwner: false },
  ];
  if (owner.value && theirs.length) {
    groups.push({ key: 'theirs', title: "Photographers' events", events: theirs, showOwner: true });
  }
  return groups;
});

const progressPct = computed(() => {
  const j = job.value;
  if (!j || !j.total) return 0;
  return Math.min(100, Math.round((j.done / j.total) * 100));
});

async function refreshEvents() {
  try {
    events.value = (await api.admin.listEvents()).events;
  } catch (e: any) {
    gated.value = await accessDenial(e);
    if (gated.value) return;
    loadError.value = e.message;
  }
}

onMounted(async () => {
  try {
    const who = await api.admin.me();
    owner.value = who.owner;
    me.value = who.email;
    if (owner.value) imageSource.value = 'original';
  } catch (e) {
    gated.value = await accessDenial(e);
    if (gated.value) return;
    // Anything else is a live connection answering badly; the events call below
    // reports it in the one place errors belong on this page.
  } finally {
    // The question this page opens with is answered. Everything after it — the
    // events, the people — fills in under a UI that no longer changes shape.
    checking.value = false;
  }
  await refreshEvents();
  if (owner.value) await refreshPeople();
});
// BOTH intervals. benchPoll was left running: it only clears itself when the
// benchmark reaches done/failed, so navigating away mid-run left a 5s poll of
// /api/admin/benchmarks/:id firing for the rest of the SPA session.
onBeforeUnmount(() => { clearInterval(poll); clearInterval(benchPoll); });

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
        bibs_enabled: bibsEnabled.value,
      });
      eventId = created.event.id;
      if (bannerFile.value) await api.admin.uploadBanner(eventId, bannerFile.value);
      await refreshEvents();
      targetEventId.value = eventId;
      mode.value = 'existing';
    }

    const { job_id } = await api.admin.ingest(eventId, driveUrl.value, imageSource.value);

    // Remember which event this job belongs to BEFORE clearing the form, since
    // clearing it is what removes the only other place that said so.
    const target = events.value.find((e) => e.id === eventId);
    jobEvent.value = { id: eventId, name: target?.name ?? 'this event' };

    startPolling(job_id);
    resetForm();
  } catch (e: any) {
    startError.value = e.message;
  } finally {
    starting.value = false;
  }
}

/**
 * Empty the form once the job is queued.
 *
 * The work has left the page at this point — it runs for hours, and the only
 * thing worth looking at is the progress card. Leaving the link, the name and
 * the samples on screen said the opposite: it read as though nothing had
 * happened, and pressing Start again (which the filled-in form invites) queues
 * the same folder a second time.
 *
 * The file input is cleared by remounting it — its value is owned by the DOM,
 * not by bannerFile, so blanking the ref alone leaves the old filename showing.
 */
function resetForm() {
  driveUrl.value = '';
  inspection.value = null;
  inspectError.value = null;
  newName.value = '';
  newDate.value = '';
  newSlug.value = '';
  bannerFile.value = null;
  bibsEnabled.value = true;
  mode.value = 'new';
  targetEventId.value = '';
  bench.value = null;
  benchError.value = null;
  formNonce.value++;
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

/* ---------------------------------------------------------------- people --
   Operator only. Every other card on this page is about albums; this one is
   about the people who put them there. */
const organizers = ref<Organizer[]>([]);
const peopleBusy = ref<string | null>(null);
const peopleError = ref<string | null>(null);
const peopleNotice = ref<string | null>(null);

async function refreshPeople() {
  if (!owner.value) return;
  try {
    organizers.value = (await api.admin.organizers()).organizers;
  } catch (e: any) {
    peopleError.value = e.message;
  }
}

const when = (iso: string) => new Date(iso).toLocaleDateString();

const newOrganizer = ref('');

/** Let someone in. Also the control that lifts a removal, so Add never no-ops. */
async function addOrganizer() {
  const email = newOrganizer.value.trim();
  if (!email) return;
  peopleBusy.value = 'add';
  peopleError.value = null;
  try {
    await api.admin.addOrganizer(email);
    peopleNotice.value =
      `${email} can sign in now. They open race-lens.runlytics.fit/admin, enter that ` +
      `address, and Cloudflare emails them a code.`;
    newOrganizer.value = '';
    await refreshPeople();
  } catch (e: any) {
    peopleError.value = e.message;
    peopleNotice.value = null;
  } finally { peopleBusy.value = null; }
}

/** For an address typed wrong. The API refuses it once they own events. */
async function removeOrganizer(o: Organizer) {
  if (!confirm(`Take ${o.email} off the list? They have published nothing, so nothing else changes.`)) return;
  peopleBusy.value = o.email;
  peopleError.value = null;
  try {
    await api.admin.removeOrganizer(o.email);
    peopleNotice.value = `${o.email} is off the list.`;
    await refreshPeople();
  } catch (e: any) {
    peopleError.value = e.message;
    peopleNotice.value = null;
  } finally { peopleBusy.value = null; }
}

async function ban(o: Organizer) {
  // Unpublishing is the point of banning from here rather than from the
  // Cloudflare dashboard, so it is stated plainly and confirmed, not buried in
  // an option nobody reads.
  const ok = confirm(
    `Remove ${o.email}'s access?\n\n` +
    `They can no longer sign in or change anything. Their ${o.published} published ` +
    `event${o.published === 1 ? '' : 's'} will be unpublished — hidden from runners, ` +
    `with every photo kept.\n\nYou can let them back in from this page.`,
  );
  if (!ok) return;

  peopleBusy.value = o.email;
  peopleError.value = null;
  try {
    const r = await api.admin.ban(o.email);
    peopleNotice.value =
      `${o.email} can no longer sign in` +
      (r.unpublished ? `, and ${r.unpublished} event${r.unpublished === 1 ? '' : 's'} were unpublished.` : '.');
    await Promise.all([refreshPeople(), refreshEvents()]);
  } catch (e: any) {
    peopleError.value = e.message;
    peopleNotice.value = null;
  } finally { peopleBusy.value = null; }
}

async function unban(o: Organizer) {
  peopleBusy.value = o.email;
  peopleError.value = null;
  try {
    await api.admin.unban(o.email);
    peopleNotice.value =
      `${o.email} can sign in again. Their events are still unpublished — publish them ` +
      `from the list above if they should be back on the site.`;
    await refreshPeople();
  } catch (e: any) {
    peopleError.value = e.message;
    peopleNotice.value = null;
  } finally { peopleBusy.value = null; }
}

async function publish(ev: EventSummary) {
  // Every other action on this page surfaces its failure; this one threw into an
  // unhandled rejection, so a failed Publish looked exactly like a successful one
  // until the list happened to be refreshed.
  try {
    await api.admin.setStatus(ev.id, 'ready');
    loadError.value = null;
    await refreshEvents();
  } catch (e: any) {
    loadError.value = `Could not publish "${ev.name}": ${e.message}`;
  }
}
</script>

<template>
  <!-- Until the API has answered, this page does not know which of the two
       screens below it is. The heading is the half that is true either way. -->
  <template v-if="checking">
    <h1>Organizer</h1>
    <p class="muted" style="margin-top: 0"><span class="spinner" /> One moment…</p>
  </template>

  <!-- The open door. /admin itself is public — Access fronts the API and the
       sign-in path, not this page — so a photographer who has never heard of
       this can read what it does and ask to be let in. -->
  <template v-else-if="gated">
    <h1>Organizer</h1>
    <p class="lede">Turn your race photos into an album runners can search.</p>

    <div class="card invite">
      <p style="margin: 0">
        Send me a Google Drive link and I'll index it. Runners then find themselves
        by typing their bib number, or by taking a selfie. It's free.
      </p>

      <ul class="invite-points">
        <li><strong>Your photos stay yours.</strong> Race Lens shows a small preview and links to your album — every full-size photo still comes from you.</li>
        <li><strong>Your name is on it.</strong> Every page that shows your work credits you and links back.</li>
        <li><strong>Leave any time.</strong> One message and the album comes off, along with everything indexed from it.</li>
      </ul>

      <p style="margin: 0">
        To get in, message me on Telegram with the email you use for Google Drive,
        and which race you shot. I'll add you and send the link back.
      </p>

      <a class="btn tg" :href="TELEGRAM" target="_blank" rel="noopener">Message @chethavuthy</a>

      <p class="muted small" style="margin: 0">
        Opens Telegram. Send it from your own account so I know it's you.
      </p>

      <!-- Three different people read this box. One has never signed in and
           needs the door. One is signed in as an account this service does not
           know — usually a second Google account the browser picked for them —
           and needs to be told that, because from the outside the invitation
           looks like a flat refusal rather than a wrong key. The third was
           removed, and is not offered a sign-out that would change nothing. -->
      <p v-if="gated === 'unlisted'" class="invite-signin muted small">
        You're signed in as an account that hasn't been added yet.
        <a :href="LOGOUT">Sign out</a> to try a different one.
      </p>
      <p v-else-if="gated === 'removed'" class="invite-signin muted small">
        This account's access was removed. Message me above if that's a mistake.
      </p>
      <p v-else class="invite-signin muted small">
        Already added? <a href="/admin/signin">Sign in</a>.
      </p>
    </div>
  </template>

  <template v-else>
  <h1>Organizer</h1>
  <!-- Whose albums these are. It reads as a caption, but it is the only place
       the signed-in identity is visible — and on a shared machine, or with two
       Google accounts, "which one am I?" is answered before anything is
       indexed under the wrong name rather than after. -->
  <p v-if="me" class="muted small signed-in">
    Signed in as {{ me }} · <a :href="LOGOUT">Sign out</a>
  </p>
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

      <!-- Operator only. A photographer indexes from resized copies, which is
           the setting that finishes an album, and is not asked to weigh a
           trade-off whose terms are Drive's download limits. -->
      <template v-if="owner">
      <h2 style="margin-top: var(--s-5)">Image quality vs speed</h2>
      <p class="muted small" style="margin-top: 0">
        Full originals are ~21 MB each. Drive also serves a resized copy about 12×
        smaller, which on one album found identical faces and bibs — and because
        Drive's download limit is what stops a round, that is roughly 12× more
        photos per round. Whether it holds for <em>this</em> folder is worth checking.
      </p>
      <div class="btn-row">
        <button :disabled="benchBusy" @click="runBenchmark">
          <span v-if="benchBusy" class="spinner" /> Compare on {{ 6 }} photos from this folder
        </button>
      </div>
      <p v-if="benchError" class="notice err" style="margin-top: var(--s-3)">{{ benchError }}</p>
      <p v-if="benchBusy" class="muted small" style="margin-top: var(--s-3)">
        Usually 2-4 minutes. You can keep working; the result appears here.
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
            <div class="stat-label">Photos per round (est.)</div>
            <div class="stat-value">
              {{ bench.result.est_photos_per_pass.thumb }} vs {{ bench.result.est_photos_per_pass.original }}
            </div>
            <div class="muted small">before Drive slows it down</div>
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
        <input :key="formNonce" id="banner" type="file" accept="image/*" @change="onBanner" />
      </div>
      <div class="field-group">
        <label>Bib numbers</label>
        <div class="segmented" role="radiogroup" aria-label="Does this event use bib numbers?">
          <button role="radio" :aria-checked="bibsEnabled" :aria-selected="bibsEnabled"
                  @click="bibsEnabled = true">Runners wear bibs</button>
          <button role="radio" :aria-checked="!bibsEnabled" :aria-selected="!bibsEnabled"
                  @click="bibsEnabled = false">No bibs</button>
        </div>
        <p class="muted small" style="margin: var(--s-2) 0 0">
          {{ bibsEnabled
            ? 'Bib numbers are read from each photo so runners can search by number.'
            : 'Skips bib reading entirely — faster indexing, and no numbers invented from signage. Face search still works.' }}
        </p>
      </div>
    </template>

    <button class="primary" :disabled="!canStart" @click="start">Start indexing</button>
    <p v-if="startError" class="notice err" style="margin-top: 12px">{{ startError }}</p>
  </div>

  <!-- Step 3 -->
  <div v-if="job" class="card" style="margin-top: 18px">
    <h2>
      3 · Indexing
      <RouterLink v-if="jobEvent" :to="`/admin/e/${jobEvent.id}`" class="mono-id">
        {{ jobEvent.name }}
      </RouterLink>
    </h2>
    <div class="progress" role="progressbar" :aria-valuenow="progressPct"
         aria-valuemin="0" aria-valuemax="100" :aria-label="`Indexing ${job.status}`">
      <div :style="{ transform: `scaleX(${progressPct / 100})` }" />
    </div>
    <!-- A queued job with no totals is the normal first minute, not a stall:
         the count only exists once the indexer has walked the folder. Saying
         "0 / 0 photos (0%)" and nothing else read as a job that had failed. -->
    <p v-if="job.status === 'queued' && !job.total" class="muted small" style="margin-top: 10px">
      <span class="spinner" /> Queued — indexing starts within a minute or two, and the
      photo count appears once the folder has been read. You can close this page.
    </p>
    <p v-else class="muted small" style="margin-top: 10px">
      {{ job.status }} — {{ job.done.toLocaleString() }} / {{ job.total.toLocaleString() }} photos ({{ progressPct }}%)
    </p>
    <p v-if="job.error" class="notice err">{{ job.error }}</p>
    <p v-if="job.status === 'partial'" class="notice warn">
      Google Drive only lets photos be downloaded so fast, so a big album is indexed
      in rounds. It continues on its own — everything done so far is already live,
      and you can close this page.
    </p>
    <p v-else-if="job.status === 'queued' && job.done > 0" class="notice">
      <span class="spinner" /> Waiting for the next round to start…
    </p>
  </div>

  <p v-if="bannerError" class="notice err" style="margin: var(--s-7) 0 var(--s-3)">{{ bannerError }}</p>

  <!-- Two sections, one row template. The second exists only for the operator,
       and only once somebody else has published — a "Photographers' events"
       heading over nothing would suggest a list that failed to load. Their rows
       carry the owner's address, so it is never a guess whose album is being
       changed; the controls are the same, because the operator can still fix or
       take down anything. -->
  <template v-for="group in eventGroups" :key="group.key">
    <h2 style="margin-top: var(--s-7)">
      {{ group.title }}
      <span v-if="group.showOwner" class="muted small" style="font-weight: 400">
        ({{ group.events.length }})
      </span>
    </h2>
    <div class="card">
      <p v-if="!group.events.length" class="muted" style="margin: 0">No events yet.</p>
      <div v-for="e in group.events" :key="e.id" class="row">
        <div class="row-main">
          <RouterLink :to="`/admin/e/${e.id}`" class="mono-id" style="font-weight: 600">
            {{ e.name }}
          </RouterLink>
          <div v-if="group.showOwner" class="small" style="margin-top: 2px">
            by {{ e.owner_email }}
          </div>
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

  <!-- Who has been let in. Operator only, and the only place a ban can be
       undone — so someone banned before they ever published is listed here too. -->
  <template v-if="owner">
    <h2 style="margin-top: var(--s-7)">Photographers</h2>
    <p v-if="peopleNotice" class="notice ok" style="margin-bottom: var(--s-3)">{{ peopleNotice }}</p>
    <p v-if="peopleError" class="notice err" style="margin-bottom: var(--s-3)">{{ peopleError }}</p>
    <div class="card">
      <!-- The whole point of the guest list living here: a photographer messages
           on Telegram, their address is typed in, and they are in. -->
      <form class="row" style="padding-top: 0" @submit.prevent="addOrganizer">
        <input v-model="newOrganizer" class="row-main" type="email" inputmode="email"
               autocomplete="off" aria-label="Photographer's email"
               placeholder="Their Google Drive email…" />
        <button class="primary" type="submit"
                :disabled="peopleBusy === 'add' || !newOrganizer.trim()">
          <span v-if="peopleBusy === 'add'" class="spinner" /> Add photographer
        </button>
      </form>

      <p v-if="!organizers.length" class="muted" style="margin: var(--s-3) 0 0">
        Nobody else yet. Add an address above and they can sign in straight away.
      </p>

      <div v-for="o in organizers" :key="o.email" class="row">
        <div class="row-main">
          <div style="font-weight: 600">{{ o.email }}</div>
          <div class="muted small">
            <template v-if="o.events">
              {{ o.events }} event{{ o.events === 1 ? '' : 's' }} ·
              {{ o.published }} published ·
              {{ o.photos.toLocaleString() }} photos<template v-if="o.last_event">
              · last {{ when(o.last_event) }}</template>
            </template>
            <template v-else-if="o.added_at">added {{ when(o.added_at) }} · nothing published yet</template>
            <template v-else>no events</template>
            <template v-if="o.banned_at">
              · <span class="state err">no access since {{ when(o.banned_at) }}</span>
            </template>
          </div>
        </div>
        <div class="row-actions">
          <button v-if="o.banned_at" :disabled="peopleBusy === o.email" @click="unban(o)">
            <span v-if="peopleBusy === o.email" class="spinner" /> Restore access
          </button>
          <!-- Nothing published means nothing to take down, so the honest control
               is "delete the row", not a ban with a record nobody needs. -->
          <button v-else-if="!o.events" :disabled="peopleBusy === o.email"
                  @click="removeOrganizer(o)">
            <span v-if="peopleBusy === o.email" class="spinner" /> Remove
          </button>
          <button v-else class="danger" :disabled="peopleBusy === o.email" @click="ban(o)">
            <span v-if="peopleBusy === o.email" class="spinner" /> Remove access
          </button>
        </div>
      </div>

      <p class="muted small" style="margin: var(--s-3) 0 0">
        Anyone on this list can sign in with an emailed code and index their own albums.
        Removing access refuses every request they make and unpublishes their events.
      </p>
    </div>
  </template>
  </template>
</template>
