/**
 * One album.
 *
 * The runner has one job here and about ten seconds of patience, so the page
 * opens on the thing that does the job: a bib, at the size they wore it. Face
 * search is the second route, offered plainly for the case the bib cannot answer
 * — folded, covered, turned away — which is roughly 4 photos in 10.
 *
 * The URL carries the search, so a result is bookmarkable and shareable, and Back
 * steps out of a search rather than off the page.
 */
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ScanFace } from 'lucide-react';
import { api, type EventSummary, type FaceMatch, type Photo } from '@/lib/api';
import { plural } from '@/lib/format';
import { Bib } from '../components/Bib';
import { BibInput } from '../components/BibInput';
import { PhotoWall, type WallItem } from '../components/PhotoWall';
import { FaceSearch } from '../components/FaceSearch';
import { BackLink } from '../components/BackLink';
import { Button } from '@/components/ui/button';
import { AlbumSkeleton } from '../components/AlbumSkeleton';
import { useDeferredLoading } from '../useDeferredLoading';

export default function EventDetail() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const searched = params.get('bib') ?? '';

  const [event, setEvent] = useState<EventSummary | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  // Cursor pagination for the browse feed. The album is 1,070 photos at SheRuns
  // and 32,796 at Angkor, so it arrives a page at a time.
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState(searched);
  const [results, setResults] = useState<WallItem[] | null>(null);
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);

  // Face results live outside the URL, unlike a bib search: the query is a
  // selfie, so there is nothing shareable to put in a link and a reload could
  // not reproduce it. Clearing them is what returning to the album means.
  const [faceOpen, setFaceOpen] = useState(false);
  const [faceResults, setFaceResults] = useState<WallItem[] | null>(null);
  const [faceNote, setFaceNote] = useState<string | null>(null);

  const showSkeleton = useDeferredLoading(loading);

  useEffect(() => {
    let live = true;
    // Reset on a slug change. React Router keeps this component mounted when only
    // the parameter changes, so without this the previous album's photos stay on
    // screen under the new album's title until the request lands — which is worse
    // than a placeholder, because it looks like real content for the wrong race.
    setLoading(true);
    setPhotos([]);
    setCursor(null);
    setEvent(null);
    api.getEvent(slug)
      .then((r) => { if (!live) return; setEvent(r.event); setPhotos(r.photos); setCursor(r.cursor); })
      .catch((e: Error) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [slug]);

  // The URL is the source of truth: this runs for a typed search, for Back and
  // Forward, and for someone opening a shared link.
  useEffect(() => {
    // Clearing the search clears the bib with it. Handled here rather than in the
    // button, so Back out of a search and a shared link with no bib both leave an
    // empty bib too — a number still sitting in it after "Show the whole album"
    // reads as a filter that is still on.
    if (!searched) { setResults(null); setAlternatives([]); setDraft(''); return; }
    let live = true;
    setSearching(true);
    setDraft(searched);
    api.searchBib(slug, searched)
      .then((r) => {
        if (!live) return;
        setResults(r.photos.map((photo) => ({ photo })));
        setAlternatives(r.alternatives ?? []);
      })
      .catch((e: Error) => { if (live) setError(e.message); })
      .finally(() => { if (live) setSearching(false); });
    return () => { live = false; };
  }, [slug, searched]);

  // Guarded by the cursor itself rather than a ref: onLoadMore fires from an
  // observer that can trigger twice before state settles, and appending the same
  // page twice would duplicate keys.
  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.getPhotos(slug, cursor);
      setPhotos((prev) => [...prev, ...r.photos]);
      setCursor(r.cursor);
    } catch (e) { setError((e as Error).message); }
    finally { setLoadingMore(false); }
  };

  const search = (v: string) => {
    const value = v.trim();
    setFaceResults(null);
    setFaceNote(null);
    // REPLACE, not push. A search refines the view you are already on; it is not
    // a new page. Pushing meant ten searches left ten history entries, so "All
    // events" — which goes back — stepped through all of them one at a time
    // instead of returning to the list. Replacing keeps the album as a single
    // entry, so one step back is the list, with its scroll position intact.
    // "Show the whole album" is how you undo a search.
    setParams(value ? { bib: value } : {}, { replace: true });
  };

  const onFaceResults = (matches: FaceMatch[], faceCount: number) => {
    setParams({}, { replace: true });
    // The score decides the ORDER and the cut-off, and that is where it belongs.
    // Printed on every tile it asked the runner to audit the matcher — a number
    // they cannot act on, over a photo they can see for themselves.
    setFaceResults(matches.map((m) => ({ photo: m.photo })));
    setFaceNote(faceCount > 1
      ? `Matched the largest of ${faceCount} faces in your photo.`
      : null);
  };

  // Nothing at all for a fast load — see useDeferredLoading. The album answers in
  // ~120ms on a warm connection, and a placeholder drawn for that long is a blink.
  if (showSkeleton) return <AlbumSkeleton />;
  if (loading) return <div className="min-h-screen" />;
  if (error) {
    return <p className="rounded-md border border-destructive/45 px-4 py-3 text-destructive">{error}</p>;
  }

  const bibsOn = event?.bibs_enabled !== false;

  return (
    <div className="pb-16">
      <BackLink to="/">All events</BackLink>

      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{event?.name}</h1>
        <p className="tabular mt-1 text-sm text-muted-foreground">
          {plural(event?.photo_count ?? 0, 'photo')}
          {event?.face_count ? ` · ${plural(event.face_count, 'face')} found` : ''}
        </p>
      </header>

      {/* Face search is ALWAYS offered. Only the bib is conditional — and an event
          with no bibs is precisely the one where a face is the only way in, so
          hiding both together (as this did) removed the search from the albums
          that depend on it most. */}
      {/* One reserved height for both variants. Whether this race used bibs is
          not known until the event loads, so a panel that sizes to its contents
          moves the whole wall down the page the moment the answer arrives. */}
      <div className="mb-10 flex min-h-[22.5rem] flex-col items-center justify-center gap-6
                      rounded-xl border border-border bg-card/40 px-4 py-10">
        {bibsOn && (
          <>
            <BibInput value={draft} onChange={setDraft} onSubmit={() => search(draft)} band={event?.name} />
            <div className="flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">or</span>
              <Button variant="outline" size="lg" onClick={() => setFaceOpen(true)}>
                <ScanFace /> Find me by face
              </Button>
            </div>
          </>
        )}
        {!bibsOn && (
          <>
            <p className="max-w-sm text-center text-muted-foreground">
              This race had no bib numbers, so your face is the way in.
            </p>
            <Button size="lg" onClick={() => setFaceOpen(true)}>
              <ScanFace /> Find me by face
            </Button>
          </>
        )}
        <p className="max-w-sm text-center text-xs text-muted-foreground">
          Face matching runs on your phone. Your selfie is never uploaded.
        </p>
      </div>

      {faceResults ? (
        <section>
          <div className="mb-6">
            <p className="tabular font-[family-name:var(--font-display)] text-xl font-bold">
              {plural(faceResults.length, 'photo')} of you
            </p>
            {faceNote && <p className="text-sm text-muted-foreground">{faceNote}</p>}
            <button
              onClick={() => { setFaceResults(null); setFaceNote(null); }}
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              Show the whole album
            </button>
          </div>
          {faceResults.length === 0 ? (
            <div className="rounded-xl border border-border p-8 text-center">
              <p className="mb-1 font-[family-name:var(--font-display)] text-lg font-bold">
                Nobody matching that face
              </p>
              <p className="mx-auto max-w-md text-sm text-muted-foreground">
                Race photos are often taken side-on. Try a second picture, or search
                by your number.
              </p>
            </div>
          ) : (
            <PhotoWall items={faceResults} />
          )}
        </section>
      ) : searched ? (
        <section>
          <div className="mb-6 flex flex-wrap items-center gap-4">
            <Bib value={searched} size="sm" band={event?.name} />
            <div>
              <p className="tabular font-[family-name:var(--font-display)] text-xl font-bold">
                {searching ? 'Looking…' : plural(results?.length ?? 0, 'photo')}
              </p>
              <button onClick={() => search('')} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
                Show the whole album
              </button>
            </div>
          </div>

          {alternatives.length > 0 && (
            <p className="mb-6 text-sm text-muted-foreground">
              This race numbers by category. The same number also exists as{' '}
              {alternatives.map((alt, i) => (
                <span key={alt}>
                  <button onClick={() => search(alt)} className="text-primary underline underline-offset-4">{alt}</button>
                  {i < alternatives.length - 1 ? ', ' : ''}
                </span>
              ))}.
            </p>
          )}

          {!searching && results?.length === 0 ? (
            <div className="rounded-xl border border-border p-8 text-center">
              <p className="mb-1 font-[family-name:var(--font-display)] text-lg font-bold">
                No photo of that number yet
              </p>
              <p className="mx-auto mb-5 max-w-md text-sm text-muted-foreground">
                Numbers get folded, covered by a hand, or turned away from the camera.
                Your face does not.
              </p>
              <Button size="lg" onClick={() => setFaceOpen(true)}><ScanFace /> Find me by face</Button>
            </div>
          ) : (
            <PhotoWall items={results ?? []} />
          )}
        </section>
      ) : (
        <PhotoWall
          items={photos.map((photo) => ({ photo }))}
          onLoadMore={loadMore}
          hasMore={!!cursor}
          loadingMore={loadingMore}
        />
      )}

      <FaceSearch
        slug={slug}
        open={faceOpen}
        onClose={() => setFaceOpen(false)}
        onResults={onFaceResults}
      />
    </div>
  );
}
