/**
 * Correct one photo, at a size you can actually hit.
 *
 * The inspect grid could only ever be a survey: a thumbnail 300px wide with nine
 * overlapping face labels on it is not something a person can click accurately,
 * and a photo where the detector found NO face had no label at all — so the album
 * with the worst OCR was the one with the fewest places to fix it. Both of the
 * API's entry points have existed the whole time (`faces/:id/bib` per runner,
 * `photos/:id/bibs` per photo); this is the screen that reaches them.
 *
 * Two levels of entry, because they mean different things:
 *   per FACE  — says which runner wears the number, which is most of the
 *               information in a group shot, and is what lets a face search
 *               report a bib.
 *   per PHOTO — says the number appears here at all. The only option when the
 *               detector found nobody, and the reason this dialog opens on a
 *               no-face photo instead of refusing to.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Plus, RefreshCw, X } from 'lucide-react';
import { api } from '@/lib/api';
import { plural } from '@/lib/format';
import { Button } from '@/components/ui/button';

type Row = Awaited<ReturnType<typeof api.admin.photos>>['photos'][number];

export function PhotoEditor({
  row, onClose, onChanged, onStep, position,
}: {
  row: Row;
  onClose: () => void;
  /** Reload the list after a write, so the grid and this dialog cannot disagree. */
  onChanged: () => Promise<void> | void;
  onStep: (delta: number) => void;
  position: { index: number; total: number; hasMore?: boolean };
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [newBib, setNewBib] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const addRef = useRef<HTMLInputElement>(null);

  // Keys, because this is a data-entry screen and the operator has a keyboard on
  // it. Arrows step through the album; Escape leaves. Suppressed while a bib is
  // half-typed — an arrow key inside a text field means "move the caret".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = editing !== null || adding;
      if (e.key === 'Escape') { if (typing) { setEditing(null); setAdding(false); } else onClose(); return; }
      if (typing) return;
      if (e.key === 'ArrowLeft') onStep(-1);
      if (e.key === 'ArrowRight') onStep(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onStep, editing, adding]);

  // A dialog over a page that still scrolls reads as a glitch, and the grid
  // behind this one is long.
  useEffect(() => {
    const html = document.documentElement;
    const prev = { h: html.style.overflow, b: document.body.style.overflow };
    html.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => { html.style.overflow = prev.h; document.body.style.overflow = prev.b; };
  }, []);

  /** Every write goes through here: one busy key, one error line, one reload. */
  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try { await fn(); await onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  const saveFace = (faceId: string) => {
    const value = draft.trim();
    setEditing(null);
    // An empty value is a real instruction — it clears the face's bib — so it is
    // sent rather than treated as a cancel. Escape is the cancel.
    return run(`face-${faceId}`, () => api.admin.setFaceBib(faceId, value));
  };

  const addPhotoBib = async () => {
    const value = newBib.trim();
    if (!value) { setAdding(false); return; }
    await run(`add-${row.id}`, () => api.admin.addBib(row.id, value));
    setNewBib('');
    // Left open: a photo needing one number typed in usually needs several.
    addRef.current?.focus();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Correct this photo"
      className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <header className="flex shrink-0 items-center gap-3 px-4 py-3 text-sm text-white/70">
        <span className="tabular">
          {position.index + 1} / {position.total}{position.hasMore ? '+' : ''}
        </span>
        <span className="hidden sm:inline">
          {row.faces.length ? plural(row.faces.length, 'face') : 'no face found'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Previous photo"
                  onClick={() => onStep(-1)} disabled={position.index === 0}>
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next photo"
                  onClick={() => onStep(1)}
                  disabled={position.index >= position.total - 1 && !position.hasMore}>
            <ChevronRight />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
      </header>

      {/* The frame keeps its own aspect ratio, uncropped: the boxes are fractions
          OF THIS FRAME, so any crop would slide every one of them off the face it
          belongs to — which is the thing this screen exists to show. */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        <div className="relative max-h-full">
          {row.thumb_url && (
            <img
              src={row.thumb_url}
              alt=""
              className="max-h-[62vh] w-auto max-w-full rounded-lg object-contain"
            />
          )}
          {row.faces.map((f) => (
            <div
              key={f.id}
              className="absolute border-2 border-primary"
              style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}
            >
              {editing === f.id ? (
                <input
                  autoFocus
                  value={draft}
                  inputMode="numeric"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveFace(f.id);
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  className="tabular absolute -bottom-9 left-1/2 w-24 -translate-x-1/2 rounded
                             bg-background px-2 py-1 text-sm text-foreground outline-none
                             ring-2 ring-primary"
                />
              ) : (
                /* A real target, not a 16px chip. min-w/py give it a thumb-sized
                   hit area even where nine boxes overlap in a pack. */
                <button
                  onClick={() => { setEditing(f.id); setDraft(f.bib ?? ''); }}
                  title="Type this runner's bib"
                  className="tabular absolute -bottom-8 left-1/2 min-w-11 -translate-x-1/2 rounded
                             bg-primary px-2 py-1 text-sm font-bold text-primary-foreground
                             shadow-lg hover:bg-primary/80"
                >
                  {busy === `face-${f.id}` ? <Loader2 className="mx-auto size-4 animate-spin" /> : (f.bib ?? '?')}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <footer className="shrink-0 space-y-3 px-4 py-4" onClick={(e) => e.stopPropagation()}>
        {error && (
          <p className="mx-auto max-w-2xl rounded-md border border-destructive/45 bg-background/90 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="mx-auto flex max-w-2xl flex-wrap items-center gap-2">
          {row.bibs.map((b) => (
            <span key={b.bib_key}
                  className="tabular inline-flex items-center gap-1.5 rounded bg-white/10 px-2 py-1 text-sm text-white">
              {b.bib}
              {b.source === 'manual' && <span className="text-primary" title="typed by hand">·</span>}
              <button
                aria-label={`Remove bib ${b.bib}`}
                title="Wrong number — remove it and stop it coming back"
                disabled={busy === `del-${b.bib_key}`}
                onClick={() => run(`del-${b.bib_key}`, () => api.admin.deletePhotoBib(row.id, b.bib))}
                className="text-white/50 hover:text-destructive"
              >
                {busy === `del-${b.bib_key}` ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
              </button>
            </span>
          ))}

          {adding ? (
            <span className="inline-flex items-center gap-2">
              <input
                ref={addRef}
                autoFocus
                value={newBib}
                inputMode="numeric"
                placeholder="0056"
                onChange={(e) => setNewBib(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addPhotoBib();
                  if (e.key === 'Escape') { setNewBib(''); setAdding(false); }
                }}
                className="tabular w-28 rounded bg-background px-2 py-1 text-sm text-foreground
                           outline-none ring-2 ring-primary"
              />
              <Button size="sm" disabled={busy === `add-${row.id}` || !newBib.trim()} onClick={addPhotoBib}>
                {busy === `add-${row.id}` ? <Loader2 className="animate-spin" /> : null} Add
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setNewBib(''); setAdding(false); }}>
                Done
              </Button>
            </span>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus /> Add a bib to this photo
            </Button>
          )}

          <span className="ml-auto flex items-center gap-3 text-sm">
            <button
              disabled={busy === `re-${row.id}`}
              onClick={() => run(`re-${row.id}`, () => api.admin.reindexPhoto(row.id))}
              className="inline-flex items-center gap-1 text-white/70 underline-offset-4 hover:text-white hover:underline disabled:opacity-50"
              title="Read this one photo again — seconds, rather than the whole folder"
            >
              {busy === `re-${row.id}`
                ? <Loader2 className="size-3.5 animate-spin" />
                : <RefreshCw className="size-3.5" />}
              re-read
            </button>
            <a href={row.original_url} target="_blank" rel="noreferrer"
               className="text-white/70 underline-offset-4 hover:text-white hover:underline">
              original
            </a>
          </span>
        </div>

        <p className="mx-auto max-w-2xl text-xs text-white/45">
          Click a box to say which runner wears a number. Use “Add a bib to this
          photo” when the number is readable but no face was found. Hand-typed
          entries survive every future re-read.
        </p>
      </footer>
    </div>
  );
}
