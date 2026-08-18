/**
 * The album, grouped by the minute each photo was taken.
 *
 * Time is the only sequence this content actually has, so it is the only one used
 * structurally. `taken_at` was previously spent on a caption; here it is the
 * spine. A runner recognises their race by when it happened — the start crush,
 * the turnaround, the finish — not by a scroll position.
 *
 * Photos with no readable time fall into one trailing group rather than being
 * dropped or scattered: an unlabelled photo is still someone's photo.
 */
import { clockTime } from '@/lib/format';

/**
 * Tile shape, clamped.
 *
 * These albums mix a 3:2 DSLR landscape with 9:16 phone portraits — 3376x6000 is
 * real in this data. Honouring that ratio literally makes one tile nearly twice
 * the height of its row and the wall stops being scannable, which is the only
 * thing the wall is for. Orientation is kept, extremity is not.
 */
function tileRatio(w: number | null, h: number | null): string {
  if (!w || !h) return '3 / 2';
  return String(Math.min(Math.max(w / h, 0.72), 1.5));
}
import type { Photo } from '@/lib/api';

export type WallItem = { photo: Photo; note?: string };

function groupByMinute(items: WallItem[]) {
  const groups = new Map<string, WallItem[]>();
  for (const it of items) {
    const key = clockTime(it.photo.taken_at) || '';
    const bucket = groups.get(key);
    if (bucket) bucket.push(it); else groups.set(key, [it]);
  }
  // Timed groups in clock order, untimed last.
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
}

export function PhotoWall({ items }: { items: WallItem[] }) {
  const groups = groupByMinute(items);
  return (
    <div className="space-y-10">
      {groups.map(([time, photos]) => (
        <section key={time || 'untimed'}>
          {/* The rule runs to the edge so the time reads as a marker on a
              timeline rather than a heading over a box. */}
          <div className="sticky top-0 z-10 -mx-1 mb-3 flex items-baseline gap-3
                          bg-background/85 px-1 py-2 backdrop-blur">
            <span className="tabular font-[family-name:var(--font-display)] text-lg font-bold text-primary">
              {time || 'Time not recorded'}
            </span>
            <span className="h-px flex-1 bg-border" />
            <span className="tabular text-xs text-muted-foreground">{photos.length}</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
            {photos.map(({ photo, note }) => (
              <a
                key={photo.id}
                href={photo.original_url}
                target="_blank"
                rel="noreferrer"
                className="group relative block overflow-hidden rounded-md bg-muted
                           focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
                style={{ aspectRatio: tileRatio(photo.width, photo.height) }}
              >
                {photo.thumb_url && (
                  <img
                    src={photo.thumb_url}
                    alt=""
                    loading="lazy"
                    className="size-full object-cover transition-transform duration-500
                               group-hover:scale-[1.03]"
                  />
                )}
                {note && (
                  <span className="tabular absolute bottom-1 left-1 rounded bg-black/70 px-1.5
                                   py-0.5 text-[0.7rem] text-white">
                    {note}
                  </span>
                )}
              </a>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
