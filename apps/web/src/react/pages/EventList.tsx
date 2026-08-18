/**
 * The front door.
 *
 * This page gets more traffic than any other and used to do the least work: a
 * list of cards and one sentence. The three assurances below are the ones that
 * decide whether a stranger will try the search at all — that it is free, that
 * their face never leaves their phone, and that it still works when their bib
 * doesn't.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type EventSummary } from '@/lib/api';
import { eventListCache } from '@/lib/cache';
import { formatDate, plural } from '@/lib/format';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const ASSURANCES = [
  ['Free, and no account',
   "Every photo opens full-size from the photographer's own album. There is nothing to sign up for."],
  ['Your face stays on your phone',
   'The matching runs in your browser. Your selfie is never uploaded and never stored.'],
  ["Works when your bib doesn't",
   "Numbers get folded, covered, or turned away from the camera. Face search doesn't mind."],
] as const;

/**
 * Banners are POSTERS — dates, times, sponsors — so cropping them is the one
 * thing we cannot do. The real image is contained and the letterbox is filled
 * with a blurred, overscanned copy of itself, so the gap reads as an extension
 * of the artwork rather than a hole.
 */
function Banner({ url }: { url: string | null }) {
  return (
    <div className="relative block aspect-video w-full overflow-hidden bg-muted">
      {url && (
        <>
          <img src={url} alt="" aria-hidden className="absolute inset-0 size-full scale-120 object-cover blur-2xl brightness-50 saturate-150" />
          <img src={url} alt="" loading="lazy" className="absolute inset-0 size-full object-contain" />
        </>
      )}
    </div>
  );
}

export default function EventList() {
  // Read during the first render, so coming back from an album re-renders the
  // same list instead of replacing it with skeleton cards for a second.
  const restored = eventListCache.read('events');
  const [events, setEvents] = useState<EventSummary[]>(restored ?? []);
  const [loading, setLoading] = useState(!restored);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (restored) return;
    let live = true;
    api.listEvents()
      .then((r) => { if (!live) return; setEvents(r.events); eventListCache.write('events', r.events); })
      .catch((e: Error) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <header className="mb-7">
        <h1 className="mb-1 text-3xl font-bold tracking-tight text-balance">
          Find yourself in the race photos.
        </h1>
        <p className="max-w-[60ch] text-muted-foreground">
          Pick your event, then search by the number you wore or by your own face.
          It takes about ten seconds.
        </p>
      </header>

      <div className="mb-7 grid gap-4 sm:grid-cols-3">
        {ASSURANCES.map(([title, body]) => (
          <div key={title}>
            <h3 className="mb-1 font-semibold">{title}</h3>
            <p className="text-sm text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Events</h2>
        {!loading && events.length > 0 && (
          <span className="text-sm text-muted-foreground">
            {plural(events.length, 'album')} published
          </span>
        )}
      </div>

      {/* Skeletons hold the grid's real shape so nothing reflows on arrival. */}
      {loading ? (
        <>
          <div aria-hidden className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="overflow-hidden p-0">
                <Skeleton className="aspect-video w-full rounded-none" />
                <div className="space-y-2 p-4">
                  <Skeleton className="h-4 w-[70%]" />
                  <Skeleton className="h-3 w-[40%]" />
                </div>
              </Card>
            ))}
          </div>
          <p role="status" className="sr-only">Loading events</p>
        </>
      ) : error ? (
        <p className="rounded-md border border-destructive/45 bg-card px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : !events.length ? (
        <Card className="p-5">
          <h2 className="font-semibold">No events published yet</h2>
          <p className="text-muted-foreground">
            Photos appear here once an organizer has uploaded and indexed an album —
            usually a few days after race day.
          </p>
          <p className="text-sm text-muted-foreground">
            Organizing a race? <Link to="/admin" className="underline">Publish your album</Link>.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((e) => (
            <Link key={e.id} to={`/e/${e.slug}`}>
              <Card className="overflow-hidden p-0 transition-colors hover:border-ring">
                <Banner url={e.banner_url} />
                <div className="p-4">
                  <div className="mb-0.5 font-semibold">{e.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {e.event_date && <>{formatDate(e.event_date)} · </>}
                    {plural(e.photo_count, 'photo')}
                    {' · '}{e.bibs_enabled ? 'Bib or face' : 'Face search'}
                    {e.status === 'partial' && <> · still growing</>}
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
