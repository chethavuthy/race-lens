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
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Loader2, RefreshCw, X } from 'lucide-react';
import { api } from '@/lib/api';
import { plural } from '@/lib/format';
import { BackLink } from '../components/BackLink';
import { Button } from '@/components/ui/button';

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
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.admin.photos(id, null, filter);
      setRows(r.photos);
      setError(null);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [id, filter]);

  useEffect(() => { load(); }, [load]);

  /**
   * One small mutation, then reload. Deliberately not patching the row in place:
   * the previous implementation refetched page 1 with filter 'all' and grepped it,
   * so a correction past the first page never appeared, and the failure was
   * swallowed.
   */
  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try { await fn(); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function saveBib(faceId: string) {
    const value = draft.trim();
    setEditing(null);
    try { await api.admin.setFaceBib(faceId, value); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="pb-16">
      <BackLink to={`/admin/e/${id}`}>Back to the album</BackLink>

      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Inspect photos</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Each box is a detected face, labelled with the bib read from that
          runner's torso. <span className="tabular text-foreground">?</span> means a
          face was found but no number could be read — click any label to type it in.
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
        <p className="flex items-center gap-2 py-10 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading</p>
      ) : !rows.length ? (
        <p className="rounded-xl border border-border p-8 text-center text-sm text-muted-foreground">
          Nothing here — which for this filter is good news.
        </p>
      ) : (
        <>
          <p className="tabular mb-4 text-sm text-muted-foreground">{plural(rows.length, 'photo')}</p>
          {/* items-start, or every card stretches to the tallest in its row and a
              landscape frame sits above a slab of empty background.

              The frame keeps its natural aspect ratio deliberately: the face boxes
              are fractions OF THAT FRAME, so cropping to a uniform tile would slide
              every box away from the face it belongs to — which is the one thing
              this screen exists to show. */}
          <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((p) => (
              <figure key={p.id} className="h-fit overflow-hidden rounded-lg border border-border">
                <div className="relative bg-muted">
                  {p.thumb_url && <img src={p.thumb_url} alt="" loading="lazy" className="block w-full" />}
                  {p.faces.map((f) => (
                    <div
                      key={f.id}
                      className="absolute border-2 border-primary"
                      style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}
                    >
                      {editing === f.id ? (
                        <input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={() => setEditing(null)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveBib(f.id);
                            if (e.key === 'Escape') setEditing(null);
                          }}
                          className="tabular absolute -bottom-7 left-0 w-20 rounded bg-background px-1 py-0.5
                                     text-xs text-foreground outline-none ring-2 ring-primary"
                        />
                      ) : (
                        <button
                          onClick={() => { setEditing(f.id); setDraft(f.bib ?? ''); }}
                          className="tabular absolute -bottom-6 left-0 rounded bg-primary px-1.5 py-0.5
                                     text-xs font-bold text-primary-foreground"
                        >
                          {f.bib ?? '?'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <figcaption className="space-y-2 px-3 py-2 text-xs text-muted-foreground">
                  <div className="flex items-center justify-between gap-2">
                    <span>{p.faces.length ? plural(p.faces.length, 'face') : 'no face found'}</span>
                    <a href={p.original_url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                      original
                    </a>
                  </div>

                  {/* Every bib on this photo, each removable. A wrong number is
                      worse than a missing one — it puts a stranger in someone's
                      results — and deleting it also tombstones it, so the next
                      pass does not read it straight back. */}
                  {p.bibs.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {p.bibs.map((b) => (
                        <span key={b.bib}
                              className="tabular inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
                          {b.bib}
                          {b.source === 'manual' && <span className="text-primary" title="typed by hand">·</span>}
                          <button
                            aria-label={`Remove bib ${b.bib}`}
                            title="Wrong number — remove it and stop it coming back"
                            disabled={busy === `bib-${p.id}-${b.bib}`}
                            onClick={() => act(`bib-${p.id}-${b.bib}`,
                              () => api.admin.deletePhotoBib(p.id, b.bib))}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <X className="size-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  <button
                    disabled={busy === `re-${p.id}`}
                    onClick={() => act(`re-${p.id}`, () => api.admin.reindexPhoto(p.id))}
                    className="inline-flex items-center gap-1 underline-offset-4 hover:underline disabled:opacity-50"
                    title="Read this one photo again — seconds, rather than the whole folder"
                  >
                    {busy === `re-${p.id}`
                      ? <Loader2 className="size-3 animate-spin" />
                      : <RefreshCw className="size-3" />}
                    re-read this photo
                  </button>
                </figcaption>
              </figure>
            ))}
          </div>
        </>
      )}

      <Button variant="outline" className="mt-8" render={<Link to={`/admin/e/${id}`} />}>
        Back to the album
      </Button>
    </div>
  );
}
