/**
 * Inspect photos — what the detector and the OCR actually saw.
 *
 * The only screen that shows the pipeline's own view: a box per face, labelled
 * with the bib read from that runner's torso. It exists to answer one question
 * an aggregate never can — "why is this photo missing from her results?" — and
 * to let an operator fix it by hand.
 *
 * The filters are the three states worth acting on, not a taxonomy. "No bib" is
 * where corrections happen; "no face" is usually the photographer's framing, not
 * a fault.
 *
 * The grid is a survey; corrections happen in PhotoEditor, which any photo opens.
 * Editing in the tiles themselves did not work: the labels are a few pixels wide
 * at thumbnail size, they pile on top of each other in a pack, and a photo with
 * no detected face had no control at all — so the album with the worst OCR was
 * the one with the fewest places to fix it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Loader2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { plural } from '@/lib/format';
import { INSPECT_COLUMNS, dealIntoColumns, useColumnCount } from '@/lib/grid';
import { BackLink } from '../components/BackLink';
import { InspectCardSkeleton, InspectSkeleton } from '../components/AdminSkeleton';
import { PhotoEditor } from '../components/PhotoEditor';
import { Button } from '@/components/ui/button';
import { useDeferredLoading } from '../useDeferredLoading';

// The API's own vocabulary — all | no_face | no_bib | has_bib. Hyphens were
// silently unrecognised there, so the filter fell through to "everything" and
// "No face" listed 24 photos that all had faces.
type Filter = 'all' | 'no_face' | 'no_bib';
type Row = Awaited<ReturnType<typeof api.admin.photos>>['photos'][number];

const FILTERS: [Filter, string][] = [['all', 'All'], ['no_face', 'No face'], ['no_bib', 'No bib']];

export default function AdminPhotos() {
  const { id = '' } = useParams();
  const [filter, setFilter] = useState<Filter>('all');
  const [rows, setRows] = useState<Row[]>([]);
  // The API answers 24 at a time and hands back a cursor. Ignoring it is why this
  // screen showed 24 photos of an album with 32,796 and gave no hint there were
  // more — an operator looking for the unread bibs was looking at 0.07% of them.
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Which photo is open for correction, by ID rather than by index.
   *
   * An index is not stable across a reload: correcting a bib under the "No bib"
   * filter removes that photo from the set, and every photo after it shifts up
   * one — so an index would quietly point at a DIFFERENT photo than the one just
   * being edited. Keyed by id, the dialog closes when its photo leaves the set,
   * which is the truth.
   */
  const [viewingId, setViewingId] = useState<string | null>(null);
  const columnCount = useColumnCount(INSPECT_COLUMNS);
  const sentinel = useRef<HTMLDivElement>(null);
  // Nothing at all for a fast load, then the placeholder if it is genuinely slow —
  // see useDeferredLoading. A spinner is what was here, and it says only "wait";
  // a skeleton says what is coming, which on a filter change is the difference
  // between the page thinking and the page looking broken.
  const showSkeleton = useDeferredLoading(loading);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.admin.photos(id, null, filter);
      setRows(r.photos);
      setCursor(r.cursor);
      setError(null);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [id, filter]);

  useEffect(() => { load(); }, [load]);

  /**
   * The next page. Guarded by the cursor itself rather than a ref, because the
   * observer below can fire twice before state settles and appending the same
   * page would duplicate keys.
   */
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.admin.photos(id, cursor, filter);
      setRows((prev) => [...prev, ...r.photos]);
      setCursor(r.cursor);
    } catch (e) { setError((e as Error).message); }
    finally { setLoadingMore(false); }
  }, [id, cursor, filter, loadingMore]);

  // Load the next page as the end comes into view. The button below it is not
  // decoration: it is what keeps this reachable by keyboard, and what works where
  // IntersectionObserver does not exist.
  useEffect(() => {
    if (!cursor || typeof IntersectionObserver === 'undefined') return;
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: '800px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  /**
   * Re-read everything already on screen, keeping the pages that were loaded.
   *
   * A plain load() after a correction would throw away pages 2..n and drop the
   * operator back to the first 24 — mid-edit, on photo 300. So the same span is
   * fetched again, page by page. Not patched in place: an earlier version
   * refetched page 1 with filter 'all' and grepped it, so a correction past the
   * first page never appeared and the failure was swallowed.
   */
  const refresh = useCallback(async () => {
    const want = rows.length;
    const fresh: Row[] = [];
    let next: string | null = null;
    do {
      const r = await api.admin.photos(id, next, filter);
      fresh.push(...r.photos);
      next = r.cursor;
    } while (next && fresh.length < want);
    setRows(fresh);
    setCursor(next);
  }, [id, filter, rows.length]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try { await fn(); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  // A filter change reshuffles the set, so anything open belongs to the old one.
  useEffect(() => { setViewingId(null); }, [filter]);

  const viewingIndex = viewingId === null ? -1 : rows.findIndex((r) => r.id === viewingId);
  // Its photo left the set — corrected under a filter that was selecting for the
  // very thing just fixed. Closing beats showing whichever photo took its place.
  useEffect(() => {
    if (viewingId !== null && !loading && viewingIndex === -1) setViewingId(null);
  }, [viewingId, viewingIndex, loading]);

  const columns = useMemo(
    () => dealIntoColumns(
      rows,
      columnCount,
      // Image ratio plus a constant for the caption, so a column of portrait
      // frames is not judged shorter than it renders.
      (row) => (row.width && row.height ? row.height / row.width : 2 / 3) + 0.18,
    ),
    [rows, columnCount],
  );

  return (
    <div className="pb-16">
      <BackLink to={`/admin/e/${id}`}>Back to the album</BackLink>

      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Inspect photos</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Each box is a detected face, labelled with the bib read from that
          runner's torso. <span className="tabular text-foreground">?</span> means a
          face was found but no number could be read. Open any photo to type numbers
          in — per runner, or for the whole photo when no face was found.
        </p>
      </header>

      <div className="mb-6 inline-flex rounded-lg border border-border p-1">
        {FILTERS.map(([f, label]) => (
          <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
                  className={`rounded-md px-4 py-1.5 text-sm ${filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
            {label}
          </button>
        ))}
      </div>

      {error && <p className="mb-6 rounded-md border border-destructive/45 px-4 py-3 text-sm text-destructive">{error}</p>}

      {loading ? (
        showSkeleton ? <InspectSkeleton /> : <div className="min-h-screen" />
      ) : !rows.length ? (
        <p className="rounded-xl border border-border p-8 text-center text-sm text-muted-foreground">
          Nothing here — which for this filter is good news.
        </p>
      ) : (
        <>
          {/* "24 photos" read as the size of the album. It is the size of what has
              been fetched, and on a 32,796-photo album those are very different
              claims. */}
          <p className="tabular mb-4 text-sm text-muted-foreground">
            {plural(rows.length, 'photo')}{cursor ? ' so far' : ''}
          </p>

          {/* Masonry, dealt column by column — the same layout and the same helper
              as the runner's wall. The CSS grid this replaces stretched every card
              in a row to the tallest one, so a 3:4 portrait frame (two in five of
              these photos) put a slab of empty background under its landscape
              neighbours. */}
          <div className="flex gap-4">
            {columns.map((col, i) => (
              <div key={i} className="flex min-w-0 flex-1 flex-col gap-4">
                {col.map((p) => (
                  <figure key={p.id} className="h-fit overflow-hidden rounded-lg border border-border">
                    {/* The whole frame opens the editor. The boxes are drawn here
                        for the survey — where the faces are, which have numbers —
                        and are deliberately NOT interactive at this size. */}
                    <button
                      type="button"
                      onClick={() => setViewingId(p.id)}
                      title="Open to correct the bibs"
                      className="relative block w-full cursor-zoom-in bg-muted
                                 focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {p.thumb_url && <img src={p.thumb_url} alt="" loading="lazy" decoding="async" className="block w-full" />}
                      {p.faces.map((f) => (
                        <span
                          key={f.id}
                          className="pointer-events-none absolute border-2 border-primary"
                          style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}
                        >
                          <span className="tabular absolute -bottom-5 left-0 rounded bg-primary px-1 text-[0.65rem] font-bold text-primary-foreground">
                            {f.bib ?? '?'}
                          </span>
                        </span>
                      ))}
                    </button>
                    <figcaption className="space-y-2 px-3 py-2 text-xs text-muted-foreground">
                      <div className="flex items-center justify-between gap-2">
                        <span>{p.faces.length ? plural(p.faces.length, 'face') : 'no face found'}</span>
                        <button onClick={() => setViewingId(p.id)}
                                className="underline-offset-4 hover:underline">
                          correct bibs
                        </button>
                      </div>

                      {/* Every bib on this photo, each removable from here too —
                          spotting a wrong number is what this survey is for, and
                          opening a dialog to delete one you can already see would
                          be a step for nothing. */}
                      {p.bibs.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {p.bibs.map((b) => (
                            <span key={b.bib_key}
                                  className="tabular inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
                              {b.bib}
                              {b.source === 'manual' && <span className="text-primary" title="typed by hand">·</span>}
                              <button
                                aria-label={`Remove bib ${b.bib}`}
                                title="Wrong number — remove it and stop it coming back"
                                disabled={busy === `bib-${p.id}-${b.bib_key}`}
                                onClick={() => act(`bib-${p.id}-${b.bib_key}`,
                                  () => api.admin.deletePhotoBib(p.id, b.bib))}
                                className="text-muted-foreground hover:text-destructive"
                              >
                                {busy === `bib-${p.id}-${b.bib_key}`
                                  ? <Loader2 className="size-3 animate-spin" />
                                  : <X className="size-3" />}
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </figcaption>
                  </figure>
                ))}
              </div>
            ))}
          </div>

          {/* The next page arriving, in the shape it will arrive in. One card per
              column so the grid extends rather than jumping. */}
          {loadingMore && (
            <div className="mt-4 flex gap-4">
              {Array.from({ length: columnCount }, (_, i) => (
                <div key={i} className="flex min-w-0 flex-1 flex-col gap-4">
                  <InspectCardSkeleton ratio={i % 2 ? '2 / 3' : '3 / 2'} />
                </div>
              ))}
            </div>
          )}

          {cursor && (
            <div ref={sentinel} className="flex justify-center py-8">
              <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? <Loader2 className="animate-spin" /> : null}
                {loadingMore ? 'Loading…' : 'Load more photos'}
              </Button>
            </div>
          )}
        </>
      )}

      {viewingIndex >= 0 && (
        <PhotoEditor
          row={rows[viewingIndex]}
          position={{ index: viewingIndex, total: rows.length, hasMore: !!cursor }}
          onClose={() => setViewingId(null)}
          onChanged={refresh}
          onStep={(d) => {
            const next = viewingIndex + d;
            if (next >= 0 && next < rows.length) setViewingId(rows[next].id);
            // Stepping off the end of what is loaded fetches the next page rather
            // than stopping dead: correcting bibs is a walk through the album, and
            // the page boundary is not something the operator should have to know
            // about. The arrow lands on the new photo once it arrives.
            else if (d > 0 && cursor) loadMore();
          }}
        />
      )}

      <Button variant="outline" className="mt-8" render={<Link to={`/admin/e/${id}`} />}>
        Back to the album
      </Button>
    </div>
  );
}
