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
import { ArrowLeft, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { plural } from '@/lib/format';
import { Button } from '@/components/ui/button';

type Filter = 'all' | 'no-face' | 'no-bib';
type Row = Awaited<ReturnType<typeof api.admin.photos>>['photos'][number];

const FILTERS: [Filter, string][] = [['all', 'All'], ['no-face', 'No face'], ['no-bib', 'No bib']];

export default function AdminPhotos() {
  const { id = '' } = useParams();
  const [filter, setFilter] = useState<Filter>('all');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
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

  async function saveBib(faceId: string) {
    const value = draft.trim();
    setEditing(null);
    try { await api.admin.setFaceBib(faceId, value); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="pb-16">
      <Link to={`/admin/e/${id}`} className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Back to the album
      </Link>

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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((p) => (
              <figure key={p.id} className="overflow-hidden rounded-lg border border-border">
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
                <figcaption className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
                  <span>{p.faces.length ? plural(p.faces.length, 'face') : 'no face found'}</span>
                  <a href={p.original_url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                    original
                  </a>
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
