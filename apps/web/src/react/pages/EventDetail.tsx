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
import { ArrowLeft, ScanFace } from 'lucide-react';
import { api, type EventSummary, type FaceMatch, type Photo } from '@/lib/api';
import { plural } from '@/lib/format';
import { Bib } from '../components/Bib';
import { BibInput } from '../components/BibInput';
import { PhotoWall, type WallItem } from '../components/PhotoWall';
import { FaceSearch } from '../components/FaceSearch';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

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

  useEffect(() => {
    let live = true;
    api.getEvent(slug)
      .then((r) => { if (!live) return; setEvent(r.event); setPhotos(r.photos); setCursor(r.cursor); })
      .catch((e: Error) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [slug]);

  // The URL is the source of truth: this runs for a typed search, for Back and
  // Forward, and for someone opening a shared link.
  useEffect(() => {
    if (!searched) { setResults(null); setAlternatives([]); return; }
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
    if (value) setParams({ bib: value }); else setParams({});
  };

  const onFaceResults = (matches: FaceMatch[], faceCount: number) => {
    setParams({});
    setFaceResults(matches.map((m) => ({
      photo: m.photo,
      // The score is the reason this photo is here. Showing it lets a runner
      // judge a weak match instead of trusting the ranking blindly.
      note: `${Math.round(m.score * 100)}%`,
    })));
    setFaceNote(faceCount > 1
      ? `Matched the largest of ${faceCount} faces in your photo.`
      : null);
  };

  if (loading) {
    return (
      <div className="space-y-6 py-10">
        <Skeleton className="mx-auto h-40 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
    );
  }
  if (error) {
    return <p className="rounded-md border border-destructive/45 px-4 py-3 text-destructive">{error}</p>;
  }

  const bibsOn = event?.bibs_enabled !== false;

  return (
    <div className="pb-16">
      <Link to="/" className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> All events
      </Link>

      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{event?.name}</h1>
        <p className="tabular mt-1 text-sm text-muted-foreground">
          {plural(event?.photo_count ?? 0, 'photo')}
          {event?.face_count ? ` · ${plural(event.face_count, 'face')} found` : ''}
        </p>
      </header>

      {bibsOn && (
        <div className="mb-10 flex flex-col items-center gap-6 rounded-xl border border-border
                        bg-card/40 px-4 py-10">
          <BibInput value={draft} onChange={setDraft} onSubmit={() => search(draft)} band={event?.name} />
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">or</span>
            <Button variant="outline" size="lg" onClick={() => setFaceOpen(true)}>
              <ScanFace /> Find me by face
            </Button>
          </div>
          <p className="max-w-sm text-center text-xs text-muted-foreground">
            Face matching runs on your phone. Your selfie is never uploaded.
          </p>
        </div>
      )}

      {faceResults ? (
        <section>
          <div className="mb-6">
            <p className="tabular font-[family-name:var(--font-display)] text-xl font-bold">
              {plural(faceResults.length, 'photo')} of you
            </p>
            <p className="text-sm text-muted-foreground">
              {faceNote ? `${faceNote} ` : ''}Percentages are how sure the match is.
            </p>
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
