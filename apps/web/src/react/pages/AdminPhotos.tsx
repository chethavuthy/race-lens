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
import { Link, useParams, useSearchParams } from 'react-router-dom';
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
type Source = Awaited<ReturnType<typeof api.admin.coverage>>['sources'][number];

const FILTERS: [Filter, string][] = [['all', 'All'], ['no_face', 'No face'], ['no_bib', 'No bib']];

/** Which count belongs beside a folder, for the filter in force. */
const countFor = (s: Source, filter: Filter) =>
  filter === 'no_face' ? s.no_face : filter === 'no_bib' ? s.no_bib : s.photos;

export default function AdminPhotos() {
  const { id = '' } = useParams();
  /**
   * The filter and the folder live in the URL.
   *
   * So that "1,412 no bib" on a Drive link can be a link — landing here already
   * narrowed to that folder and that failure, which is the whole point of counting
   * per folder. It also makes the view shareable and survives a reload, and Back
   * out of a narrowed view returns to the wider one.
   */
  const [params, setParams] = useSearchParams();
  const filter = (FILTERS.some(([f]) => f === params.get('filter'))
    ? params.get('filter') : 'all') as Filter;
  const source = params.get('source') ?? '';

  const setFilter = (f: Filter) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (f === 'all') next.delete('filter'); else next.set('filter', f);
    return next;
  }, { replace: true });

  const setSource = (sourceId: string) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (!sourceId) next.delete('source'); else next.set('source', sourceId);
    return next;
  }, { replace: true });

  /**
   * The folders themselves, for the row of buttons. One Drive link at a time is
   * what makes hand-correction finite: an album is five folders by five
   * photographers and the unread bibs are not spread evenly — one backlit stretch
   * of the course holds most of them.
   */
  const [sources, setSources] = useState<Source[] | null>(null);
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
   * The photo open for correction, held as the ROW plus the index it was opened
   * at — not as an index into the list, and not as an id looked up in the list.
   *
   * Both of those tie the dialog's life to a query it should outlive. Correcting a
   * bib under "No bib" removes that photo from the list, so an index silently
   * pointed at a different photo and an id lookup closed the dialog outright —
   * which is what happened after typing ONE number into a group shot with five
   * unread ones. Holding the row means the dialog stays on the photo; the editor
   * re-reads it from the API by id, so nothing it shows depends on the list.
   */
  const [viewing, setViewing] = useState<{ row: Row; index: number } | null>(null);
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
      const r = await api.admin.photos(id, null, filter, source);
      setRows(r.photos);
      setCursor(r.cursor);
      setError(null);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [id, filter, source]);

  useEffect(() => { load(); }, [load]);

  // Once, on its own request. Coverage reads ~916,000 rows on a 32k album, so it
  // is not something to refetch on every filter change — and the counts it carries
  // (how many photos per folder have no face, no bib) do not move unless a pass or
  // a correction runs. A failure here costs the selector, not the page.
  useEffect(() => {
    let live = true;
    api.admin.coverage(id)
      .then((r) => { if (live) setSources(r.sources.filter((s) => !s.removed_at)); })
      .catch(() => { if (live) setSources([]); });
    return () => { live = false; };
  }, [id]);

  /**
   * The next page. Guarded by the cursor itself rather than a ref, because the
   * observer below can fire twice before state settles and appending the same
   * page would duplicate keys.
   */
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.admin.photos(id, cursor, filter, source);
      setRows((prev) => [...prev, ...r.photos]);
      setCursor(r.cursor);
    } catch (e) { setError((e as Error).message); }
    finally { setLoadingMore(false); }
  }, [id, cursor, filter, source, loadingMore]);

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
      const r = await api.admin.photos(id, next, filter, source);
      fresh.push(...r.photos);
      next = r.cursor;
    } while (next && fresh.length < want);
    setRows(fresh);
    setCursor(next);
  }, [id, filter, source, rows.length]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try { await fn(); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  // A filter or folder change reshuffles the set, so anything open belongs to the
  // old one.
  useEffect(() => { setViewing(null); }, [filter, source]);

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

      <div className="mb-4 inline-flex rounded-lg border border-border p-1">
        {FILTERS.map(([f, label]) => (
          <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
                  className={`rounded-md px-4 py-1.5 text-sm ${filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* One row per Drive link, carrying the count that matters under the filter
          in force — so "No bib · 1,412" on one folder and "No bib · 8" on another
          says where the work is before a single photo is opened. Only drawn when
          there is more than one folder: a single-folder album has nothing to
          choose between. */}
      {sources && sources.length > 1 && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setSource('')}
            aria-pressed={source === ''}
            className={`tabular rounded-lg border px-3 py-1.5 text-xs ${
              source === '' ? 'border-primary text-foreground' : 'border-border text-muted-foreground'}`}
          >
            All folders
          </button>
          {sources.map((s, i) => (
            <button
              key={s.source_id}
              onClick={() => setSource(s.source_id)}
              aria-pressed={source === s.source_id}
              title={s.drive_folder_id}
              className={`tabular rounded-lg border px-3 py-1.5 text-xs ${
                source === s.source_id ? 'border-primary text-foreground' : 'border-border text-muted-foreground'}`}
            >
              {/* The credit if the photographer set one, otherwise a position —
                  a Drive folder id is 33 characters of nothing to a reader. */}
              {s.credit_name || `Folder ${i + 1}`}
              <span className="ml-1.5 opacity-60">{countFor(s, filter).toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}

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
                      onClick={() => setViewing({ row: p, index: rows.indexOf(p) })}
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
                        <button onClick={() => setViewing({ row: p, index: rows.indexOf(p) })}
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

      {viewing && (
        <PhotoEditor
          seed={viewing.row}
          position={{ index: viewing.index, total: rows.length, hasMore: !!cursor }}
          inList={rows.some((r) => r.id === viewing.row.id)}
          onClose={() => setViewing(null)}
          onChanged={refresh}
          onStep={(d) => {
            // Where the open photo sits NOW. If it has left the list — corrected
            // under a filter that was selecting for exactly that — everything
            // after it shifted up one, so the slot it used to occupy already holds
            // the next photo. Stepping from the stale index would skip one.
            const at = rows.findIndex((r) => r.id === viewing.row.id);
            const next = at >= 0 ? at + d : viewing.index + (d > 0 ? 0 : -1);
            if (next >= 0 && next < rows.length) setViewing({ row: rows[next], index: next });
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
