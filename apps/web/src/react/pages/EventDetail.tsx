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
import { api, type EventSummary, type Photo } from '@/lib/api';
import { plural } from '@/lib/format';
import { Bib } from '../components/Bib';
import { BibInput } from '../components/BibInput';
import { PhotoWall, type WallItem } from '../components/PhotoWall';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export default function EventDetail() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const searched = params.get('bib') ?? '';

  const [event, setEvent] = useState<EventSummary | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState(searched);
  const [results, setResults] = useState<WallItem[] | null>(null);
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let live = true;
    api.getEvent(slug)
      .then((r) => { if (!live) return; setEvent(r.event); setPhotos(r.photos); })
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

  const search = (v: string) => {
    const value = v.trim();
    if (value) setParams({ bib: value }); else setParams({});
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
            <Button variant="outline" size="lg">
              <ScanFace /> Find me by face
            </Button>
          </div>
          <p className="max-w-sm text-center text-xs text-muted-foreground">
            Face matching runs on your phone. Your selfie is never uploaded.
          </p>
        </div>
      )}

      {searched ? (
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
              <Button size="lg"><ScanFace /> Find me by face</Button>
            </div>
          ) : (
            <PhotoWall items={results ?? []} />
          )}
        </section>
      ) : (
        <PhotoWall items={photos.map((photo) => ({ photo }))} />
      )}
    </div>
  );
}
