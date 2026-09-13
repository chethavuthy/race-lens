/**
 * The pass queue.
 *
 * Every "start indexing" control used to dispatch a GitHub workflow on the spot.
 * Three problems with that, all of which the organizer sees:
 *
 *   * Re-reading bibs on a five-link album fired five dispatches at once and
 *     relied on the workflow's `concurrency` group to line them up. That works,
 *     but the queue then lives in GitHub where nothing here can show it, reorder
 *     it, or cancel it — the event page shows five jobs as "queued" with no way to
 *     tell which is actually moving.
 *   * The group is per EVENT, so passes on two different albums ran together,
 *     competing for the same Drive quota — the one resource that actually limits
 *     this pipeline.
 *   * A dispatch that failed left the operator with a job row and no runner.
 *
 * So a job row is now the queue: `dispatched_at IS NULL` means "waiting here",
 * and exactly one pass is handed to CI at a time. The rest is drain(), called
 * wherever the answer to "is a slot free?" can have changed — after a job is
 * enqueued, when one reaches a terminal state, and on the report the event page
 * polls, which makes the queue self-healing if a terminal ping is ever missed.
 *
 * Those opportunistic calls are not enough on their own, and the reason is worth
 * stating: not one of them is a clock. The runner swallows failed pings, a runner
 * GitHub reclaims never pings at all, and the admin page polls only while its tab
 * is visible. Lose a terminal ping with nobody watching and everything behind it
 * waits forever. So there is also a five-minute cron (see index.ts and
 * wrangler.toml) whose only job is to call drain() — cheap, because a drain over
 * an empty queue is one indexed count.
 */
import type { Env } from './types';
import { nowIso } from './lib';

/**
 * How long a dispatched job may go without a word before the queue writes it off.
 *
 * Same 20 minutes the report uses to grey out a stale job, and for the same
 * reason: GitHub can reclaim a runner without telling anyone, and a queue that
 * waits forever on a pass that will never ping is worse than one that occasionally
 * runs a duplicate — the indexer's resume path skips whatever is already done, so
 * a duplicate costs time, while a stall costs the album.
 *
 * The clock starts at DISPATCH, not at enqueue: a job sitting in this queue is not
 * late, it is waiting, and it must never be treated as stale.
 */
const STALE_MS = 20 * 60 * 1000;

/**
 * How long a DISPATCHED pass has to say its first word before the queue writes it
 * off. Much longer than STALE_MS, and it has to be.
 *
 * The 20-minute clock starts at dispatch, but the runner's first ping happens only
 * after GitHub queues the event, allocates a hosted runner, checks out, installs
 * apt and pip dependencies and downloads ~100 MB of insightface models. On a
 * congested runner pool that can pass twenty minutes on its own — and the workflow
 * ALSO has a per-event concurrency group, so a dispatch for an album that already
 * has a run in progress sits in GitHub's queue pinging nothing at all.
 *
 * With one clock for both, every 20 minutes the queue wrote off a pass that was
 * merely booting and dispatched another, which then queued behind it and was also
 * written off: one leaked real dispatch per 20 minutes, all of which eventually
 * run, and across different events they run side by side — precisely the Drive
 * quota contention this queue exists to prevent.
 *
 * A pass that has spoken once is 'running' and back on the tighter clock.
 */
const BOOT_MS = 90 * 60 * 1000;

/** What the workflow needs beyond the ids on the job row. */
export interface PassPayload {
  folder_id: string;
  image_source: string;
  bibs_only?: boolean;
  no_resume?: boolean;
  rebuild?: boolean;
}

/** Add a pass to the queue. Does NOT dispatch — call drain() after. */
export async function enqueue(env: Env, job: {
  id: string;
  event_id: string;
  source_id: string;
  total?: number;
  payload: PassPayload;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jobs (id, event_id, source_id, status, total, payload, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
  ).bind(
    job.id, job.event_id, job.source_id, job.total ?? 0,
    JSON.stringify(job.payload), nowIso(),
  ).run();
}

/**
 * Is a queue-managed pass in CI right now?
 *
 * Dispatched, not finished, and heard from recently. Two exclusions, both
 * deliberate:
 *
 *   * Undispatched rows are the queue itself. Counting them would have the first
 *     queued job block its own dispatch.
 *   * `payload IS NULL` rows never came through here. A one-photo re-index
 *     (POST /photos/:id/reindex) dispatches itself, because it is seconds of work
 *     on a single file and must not wait behind a 32,000-photo album. It sets
 *     dispatched_at so drain() cannot mistake it for a waiting job, and that same
 *     timestamp would otherwise hold this slot shut for twenty minutes over one
 *     photo. It costs a runner, not the Drive quota this queue exists to protect.
 */
export async function busy(env: Env): Promise<boolean> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM jobs
      WHERE dispatched_at IS NOT NULL
        AND payload IS NOT NULL
        AND ((status = 'running' AND updated_at > ?1)
          OR (status = 'queued'  AND dispatched_at > ?2))`,
  ).bind(
    new Date(now - STALE_MS).toISOString(),
    new Date(now - BOOT_MS).toISOString(),
  ).first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

/**
 * How many passes are waiting, and which is next — for the event page to show.
 *
 * Ordered by rowid, not by id. nowIso() is millisecond resolution and the bib
 * re-read enqueues one pass per link in a tight loop, so same-millisecond ties are
 * normal — and the old tiebreaker was newId(), twelve random characters. The
 * positions this returns are shown to an organizer as "2 ahead of you", so they
 * have to be insertion order rather than a shuffle.
 */
export async function pending(env: Env): Promise<{ id: string; event_id: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, event_id FROM jobs
      WHERE dispatched_at IS NULL AND status = 'queued'
      ORDER BY updated_at, rowid LIMIT 200`,
  ).all<{ id: string; event_id: string }>();
  return results;
}

/**
 * Hand one pass to CI.
 *
 * Returns null on success, or the upstream status. Zero means the fetch itself
 * threw — DNS, a reset connection, a subrequest limit — which is emphatically NOT
 * the same as a rejection, and the caller must put the job back in the queue
 * rather than fail it: nothing was handed over, so nothing is running.
 */
async function dispatch(env: Env, payload: Record<string, unknown>): Promise<number | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'race-lens-worker', 'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event_type: 'index-event', client_payload: payload }),
    });
    if (res.ok) return null;
    // The body names the repository and the API behind it, so it goes to the log
    // rather than to a job row an organizer can read.
    console.error('index dispatch failed', res.status,
                  await res.text().then((t) => t.slice(0, 300)).catch(() => ''));
    return res.status;
  } catch (e) {
    console.error('index dispatch threw', (e as Error).message);
    return 0;
  }
}

/** Is this status worth another go, or is the pass simply not startable? */
const retryable = (status: number) => status === 0 || status === 429 || status >= 500;

/**
 * Hand the next waiting pass to CI, if nothing is running.
 *
 * Never throws: this is called from the middle of other work — an enqueue, a
 * progress ping, a page poll — and none of those should fail because GitHub was
 * briefly unreachable. The pass stays queued and the next drain picks it up.
 *
 * At most one dispatch per call, except when a dispatch FAILS: that job is marked
 * failed and the next is tried, so one bad row cannot wedge the queue behind it.
 */
export async function drain(env: Env, budget = 3): Promise<{ dispatched: string | null }> {
  try {
    for (let i = 0; i < budget; i++) {
      if (await busy(env)) return { dispatched: null };

      const next = await env.DB.prepare(
        `SELECT id, event_id, source_id, payload FROM jobs
          WHERE dispatched_at IS NULL AND status = 'queued'
          ORDER BY updated_at, rowid LIMIT 1`,
      ).first<{ id: string; event_id: string; source_id: string; payload: string | null }>();
      if (!next) return { dispatched: null };

      // Claim it before dispatching, and only if nobody else has. D1 serialises
      // writes, so `changes === 1` is a real lock: two polls landing together
      // cannot both send the same job to CI.
      //
      // updated_at moves to now as well, which is what starts the staleness clock
      // at the dispatch rather than at the enqueue.
      // `status` is re-checked here as well as in the SELECT above: stopping a
      // WAITING pass leaves dispatched_at NULL and only moves the status, so a
      // drain that read the row just before the stop would otherwise still claim
      // it afterwards and send a stopped pass to CI.
      const ts = nowIso();
      const claim = await env.DB.prepare(
        `UPDATE jobs SET dispatched_at = ?, updated_at = ?
          WHERE id = ? AND dispatched_at IS NULL AND status = 'queued'`,
      ).bind(ts, ts, next.id).run();
      if ((claim.meta.changes ?? 0) !== 1) continue;

      if (!next.payload) {
        // Every row this queue creates carries a payload, and migration 014 marked
        // every pre-existing row as already dispatched — so reaching this means a
        // hand-inserted row. It used to fall back to the source's folder, which
        // turned a row that meant one photo into a pass over the entire album.
        // Refusing is the only safe reading of "we do not know what this is for".
        await env.DB.prepare(
          "UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
        ).bind('This pass did not say what it was for.', nowIso(), next.id).run();
        continue;
      }
      const payload = JSON.parse(next.payload) as PassPayload;

      const status = await dispatch(env, {
        event_id: next.event_id, source_id: next.source_id, job_id: next.id, ...payload,
      });
      if (status === null) return { dispatched: next.id };

      if (retryable(status)) {
        // Nothing was handed over: GitHub was rate-limiting, unreachable, or the
        // fetch threw. Put it back in line rather than failing it — this used to
        // mark up to three albums permanently failed over one blip, each needing
        // the organizer to notice and press the button again, and a throw left the
        // row claimed forever, invisible to pending() and to every future drain.
        //
        // Returning rather than continuing: whatever is wrong with GitHub is wrong
        // for the next job too, and hammering it is how a 429 becomes a longer 429.
        await env.DB.prepare(
          `UPDATE jobs SET dispatched_at = NULL, error = ?, updated_at = ?
            WHERE id = ?`,
        ).bind('Waiting — could not reach GitHub to start it. It retries by itself.',
               nowIso(), next.id).run();
        return { dispatched: null };
      }

      // A rejection that will not read differently next time: a bad token, a repo
      // that is gone. Mark it and move on, so one dead row cannot wedge the queue.
      await env.DB.prepare(
        "UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
      ).bind(`Could not start indexing (${status}).`, nowIso(), next.id).run();
    }
    return { dispatched: null };
  } catch (e) {
    console.error('drain failed', (e as Error).message);
    return { dispatched: null };
  }
}
