/**
 * One album, from the operator's side.
 *
 * Two questions, answered separately because they fail independently: did every
 * photo get in (Coverage), and can a runner actually find themselves (Search).
 * An album can be 100% indexed and useless — SheRuns was, for a week, with every
 * bib it had stored read off signage.
 *
 * The register is Vercel's and Railway's: quiet rows, numbers in the display
 * face, status as small coloured text rather than badges. Colour means "this
 * needs you", so a healthy album has none.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Loader2, Square } from 'lucide-react';
import { api, type EventSummary } from '@/lib/api';
import { plural } from '@/lib/format';
import { Stat } from '../components/Stat';
import { AdminEventSkeleton } from '../components/AdminEventSkeleton';
import { useDeferredLoading } from '../useDeferredLoading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BibRules } from '../components/BibRules';
import { BackLink } from '../components/BackLink';
import { Button } from '@/components/ui/button';

type Report = Awaited<ReturnType<typeof api.admin.report>>;

const STALE_LABEL: Record<string, string> = {
  done: 'complete', partial: 'stopped short', failed: 'failed',
  stopped: 'stopped', running: 'running', queued: 'queued',
};

export default function AdminEvent() {
  const { id = '' } = useParams();
  const [event, setEvent] = useState<EventSummary | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const poll = useRef<number | undefined>(undefined);
  const [owner, setOwner] = useState(false);
  const [newLink, setNewLink] = useState('');
  /**
   * Size for the link about to be added. Deliberately unset: adding a link
   * dispatches the run in the same request, and the row's own toggle is disabled
   * while a job is active — which it then is. A default here would not be a
   * starting point the operator could correct, it would be the decision, and the
   * only way back is a full re-index. That is how every new folder ended up on
   * full-size originals at ~25 photos a round.
   */
  const [newSize, setNewSize] = useState<'original' | 'thumb' | null>(null);

  const load = useCallback(async () => {
    try {
      const [e, r] = await Promise.all([api.admin.getEvent(id), api.admin.report(id)]);
      setEvent(e.event); setReport(r); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.admin.me().then((m) => setOwner(m.owner)).catch(() => {}); }, []);

  const showSkeleton = useDeferredLoading(!report || !event);

  const active = report?.jobs.find((j) => ['running', 'queued'].includes(j.status) && !j.stale) ?? null;

  // Poll only while something is moving, and only while the tab is visible: the
  // report is eight aggregate queries and a rate-limited album can sit here for
  // hours.
  useEffect(() => {
    clearInterval(poll.current);
    if (!active) return;
    poll.current = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 15000) as unknown as number;
    return () => clearInterval(poll.current);
  }, [active, load]);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try { await fn(); setNotice(ok); setError(null); await load(); }
    catch (e) { setNotice(null); setError((e as Error).message); }
    finally { setBusy(null); }
  }

  if (error && !report) {
    return <p className="rounded-md border border-destructive/45 px-4 py-3 text-destructive">{error}</p>;
  }
  if (!report || !event) return showSkeleton ? <AdminEventSkeleton /> : <div className="min-h-screen" />;

  const t = report.totals;
  const q = report.quality;
  const live = report.sources.filter((s) => !s.removed_at);

  return (
    <div className="pb-16">
      <BackLink to="/admin">All events</BackLink>

      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">{event.name}</h1>
        <p className="tabular mt-1 text-sm text-muted-foreground">
          /e/{event.slug} · {event.status}
        </p>
      </header>

      {notice && <p className="mb-6 rounded-md border border-primary/40 px-4 py-3 text-sm text-primary">{notice}</p>}
      {error && <p className="mb-6 rounded-md border border-destructive/45 px-4 py-3 text-sm text-destructive">{error}</p>}

      {active && (
        <div className="mb-8 rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="tabular font-[family-name:var(--font-display)] text-lg font-bold">
                {active.stop_requested
                  ? `Stopping — ${active.done.toLocaleString()} / ${active.total.toLocaleString()} done`
                  : `Indexing — ${active.done.toLocaleString()} / ${active.total.toLocaleString()}`}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {active.stop_requested
                  ? 'Ends after the batch in progress. Everything indexed stays live.'
                  : 'A big album runs in rounds and carries on by itself. You can close this page.'}
              </p>
            </div>
            <Button
              variant="outline"
              disabled={busy === 'stop' || !!active.stop_requested}
              onClick={() => run('stop', () => api.admin.stopJob(active.id),
                'Stopping — the pass ends after the batch in progress.')}
            >
              {busy === 'stop' ? <Loader2 className="animate-spin" /> : <Square />}
              {active.stop_requested ? 'Stopping' : 'Stop'}
            </Button>
          </div>
          {/* A bar, because a fraction alone does not show a stall. */}
          <div className="mt-4 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-[width] duration-700"
              style={{ width: `${Math.min(100, (active.done / Math.max(active.total, 1)) * 100)}%` }}
            />
          </div>
        </div>
      )}

      <section className="mb-8 rounded-xl border border-border p-5">
        <h2 className="mb-4 text-sm font-semibold text-muted-foreground">Coverage</h2>
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat label="Drive links" value={t.links} />
          <Stat label="Found on Drive" value={t.found} hint={t.found_known ? undefined : 'still counting'} />
          <Stat label="Indexed" value={t.indexed} />
          <Stat label="Still missing" value={t.missing} tone={t.missing > 0 ? 'warn' : 'plain'} />
        </div>
      </section>

      <section className="mb-8 rounded-xl border border-border p-5">
        <h2 className="mb-4 text-sm font-semibold text-muted-foreground">Can a runner find themselves?</h2>
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat label="Faces detected" value={q.faces} />
          <Stat label="Photos with a face" value={q.photos_with_face} />
          <Stat label="Photos with a bib" value={q.photos_with_bib}
                tone={q.photos && q.photos_with_bib / q.photos > 0.4 ? 'good' : 'plain'} />
          <Stat label="Distinct bib numbers" value={q.distinct_bibs} />
        </div>
        <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
          {plural(q.photos_without_bib, 'photo')} have no readable bib and{' '}
          {plural(q.photos_without_face, 'photo')} no detected face. Some of that is
          real — backs turned, bibs folded or hidden — so treat it as a ceiling on
          bib search, not a fault. Face search is unaffected by a missing bib.
        </p>
        <Button variant="outline" size="sm" className="mt-4" render={<Link to={`/admin/e/${id}/photos`} />}>
          Inspect photos
        </Button>
      </section>

      <BibRules
        event={event}
        indexed={t.indexed}
        busyPass={!!active}
        onChanged={async (m: string) => { setNotice(m); setError(null); await load(); }}
      />

      <section className="rounded-xl border border-border">
        <h2 className="border-b border-border px-5 py-4 text-sm font-semibold text-muted-foreground">
          Drive links ({live.length})
        </h2>
        <ul className="divide-y divide-border">
          {live.map((s) => {
            const complete = s.discovered_known && s.missing === 0;
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <a href={s.drive_url} target="_blank" rel="noreferrer"
                     className="block truncate text-sm underline-offset-4 hover:underline">
                    {s.drive_folder_id}
                  </a>
                  <p className="tabular mt-0.5 text-xs text-muted-foreground">
                    {s.indexed.toLocaleString()} / {s.discovered.toLocaleString()} indexed
                    {' · '}
                    <span className={complete ? 'text-primary' : 'text-[oklch(0.80_0.16_75)]'}>
                      {complete ? 'complete' : `${s.missing.toLocaleString()} missing`}
                    </span>
                    {' · '}{s.image_source === 'thumb' ? 'resized' : 'full originals'}
                  </p>
                </div>
                {/* Which size the NEXT round downloads. Operator only — the API
                    refuses 'original' from anyone else, so the control is hidden
                    because the choice is already made, not to keep it out of
                    reach. Disabled while a pass runs: it would change under a
                    round already in flight. */}
                {owner && (
                  <div className="inline-flex rounded-lg border border-border p-1" role="radiogroup"
                       aria-label="Image size to download">
                    {([['original', 'Original'], ['thumb', 'Resized']] as const).map(([v, label]) => (
                      <button
                        key={v} type="button" role="radio"
                        aria-checked={(s.image_source === 'thumb' ? 'thumb' : 'original') === v}
                        disabled={busy === `src-${s.id}` || !!active}
                        title={v === 'thumb'
                          ? "Drive's resized copy — same faces and bibs, about 600 photos a round"
                          : 'Full-size originals — about 25 photos a round'}
                        onClick={() => run(`src-${s.id}`, () => api.admin.setImageSource(s.id, v),
                          v === 'thumb'
                            ? 'Switched to resized copies — run the album again to carry on at the faster rate.'
                            : 'Switched to full originals — run the album again to carry on.')}
                        className={`rounded-md px-2.5 py-1 text-xs disabled:opacity-50 ${
                          (s.image_source === 'thumb' ? 'thumb' : 'original') === v
                            ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                <Button
                  variant="outline" size="sm"
                  disabled={busy === s.id || !!active}
                  onClick={() => run(s.id, () => api.admin.reindexSource(s.id),
                    complete ? 'Checking for new photos.' : 'Indexing the photos not done yet.')}
                >
                  {busy === s.id ? <Loader2 className="animate-spin" /> : null}
                  {complete ? 'Recheck' : 'Continue'}
                </Button>
              </li>
            );
          })}
        </ul>

        {/* Adding a folder to an album that already has one. Built from the same
            row as the links above it, so adding a link and re-running one read as
            the same kind of act. */}
        <div className="row-add border-t border-border px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              value={newLink}
              onChange={(e) => setNewLink(e.target.value)}
              placeholder="Add another Drive folder URL…"
              className="min-w-[16rem] flex-1"
            />
            {owner && (
              <div className="inline-flex rounded-lg border border-border p-1" role="radiogroup"
                   aria-label="Image size to download for this link">
                {([['original', 'Original'], ['thumb', 'Resized']] as const).map(([v, label]) => (
                  <button
                    key={v} type="button" role="radio" aria-checked={newSize === v}
                    disabled={busy === 'add'}
                    onClick={() => setNewSize(v)}
                    className={`rounded-md px-3 py-1.5 text-sm ${
                      newSize === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <Button
              disabled={busy === 'add' || !newLink.trim() || (owner && !newSize) || !!active}
              title={owner && !newSize ? 'Pick Original or Resized first' : undefined}
              onClick={() => run('add', async () => {
                await api.admin.ingest(id, newLink.trim(), newSize ?? undefined);
                setNewLink(''); setNewSize(null);
              }, newSize === 'thumb'
                ? 'Link added — indexing started on Drive’s resized copies.'
                : 'Link added — indexing started on full originals.')}
            >
              {busy === 'add' ? <Loader2 className="animate-spin" /> : null} Add link
            </Button>
          </div>
          {owner && newLink.trim() && !newSize && (
            <p className="mt-2 text-sm text-[oklch(0.80_0.16_75)]">
              Pick a size first — it cannot be changed once indexing starts. Resized
              moves about 600 photos a round against roughly 25 for originals, for the
              same faces and bibs.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
