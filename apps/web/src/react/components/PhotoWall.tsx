/**
 * The photo wall: masonry, with the next page loaded as you reach it.
 *
 * COLUMNS, NOT CSS MULTI-COLUMN. `columns: 4` balances its content, so appending
 * a page reflows every item and photos already on screen jump into different
 * columns. That is the one thing an infinite feed must never do. Each column is
 * its own element and items are dealt into whichever is currently shortest, so
 * the placement of the first N items never changes when page N+1 arrives.
 *
 * NO CROPPING. Drive hands us whatever the photographer shot — the Angkor
 * marathon is 3:2 landscape off a DSLR, the Night Runners album is 3:4 portrait
 * off phones, and roughly two in five frames across these events are portrait.
 * Forcing one box crops a runner's head or feet off, which this product cannot
 * do. Every tile keeps its own shape.
 *
 * The heights are known before a single image decodes: width and height come off
 * Drive's metadata at index time and ride along on every Photo, so the deal is
 * computed from ratios and nothing reflows as pictures arrive.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { clockTime } from '@/lib/format';
import type { Photo } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Lightbox } from './Lightbox';

export type WallItem = { photo: Photo };

const BREAKPOINTS = [
  { min: 1101, columns: 4 },
  { min: 561, columns: 3 },
  { min: 0, columns: 2 },
];

function useColumnCount() {
  const [n, setN] = useState(() =>
    typeof window === 'undefined' ? 4
      : (BREAKPOINTS.find((b) => window.innerWidth >= b.min) ?? BREAKPOINTS[2]).columns);
  useEffect(() => {
    const onResize = () => {
      setN((BREAKPOINTS.find((b) => window.innerWidth >= b.min) ?? BREAKPOINTS[2]).columns);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return n;
}

export function PhotoWall({
  items, onLoadMore, hasMore, loadingMore,
}: {
  items: WallItem[];
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
}) {
  const columnCount = useColumnCount();
  const sentinel = useRef<HTMLDivElement>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  const columns = useMemo(() => {
    const cols: WallItem[][] = Array.from({ length: columnCount }, () => []);
    const heights = new Array(columnCount).fill(0);
    for (const item of items) {
      const { width, height } = item.photo;
      // Height relative to column width, so it is unit-free and needs no measuring.
      const ratio = width && height ? height / width : 2 / 3;
      let shortest = 0;
      for (let i = 1; i < columnCount; i++) if (heights[i] < heights[shortest]) shortest = i;
      cols[shortest].push(item);
      heights[shortest] += ratio;
    }
    return cols;
  }, [items, columnCount]);

  // Load the next page as the end comes into view. The button below is not a
  // fallback for looks: it is what keeps this reachable by keyboard, and what
  // works in environments without IntersectionObserver.
  useEffect(() => {
    if (!onLoadMore || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) onLoadMore(); },
      { rootMargin: '800px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onLoadMore, hasMore, items.length]);

  return (
    <div>
      <div className="flex gap-1.5 sm:gap-2">
        {columns.map((col, i) => (
          <div key={i} className="flex min-w-0 flex-1 flex-col gap-1.5 sm:gap-2">
            {col.map(({ photo }) => (
              <a
                key={photo.id}
                href={photo.original_url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  // Let the browser keep the ways a reader asks for a new tab.
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  setViewing(items.findIndex((it) => it.photo.id === photo.id));
                }}
                className="group relative block overflow-hidden rounded-md bg-muted
                           focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
                style={{
                  aspectRatio: photo.width && photo.height
                    ? `${photo.width} / ${photo.height}`
                    : '3 / 2',
                }}
              >
                {photo.thumb_url && (
                  <img
                    src={photo.thumb_url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    /* Plain group-hover: Tailwind v4 already compiles hover: behind
                       @media (hover: hover), so a touch device never applies it and a
                       tap cannot leave a tile stuck enlarged. Writing the media query
                       by hand as an arbitrary variant silently lost the
                       `and (pointer: fine)` half in the build. */
                    className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
                  />
                )}
                {/* The minute the shutter fired. The album is a morning, and this
                    is the only structure the photographs actually carry. */}
                {clockTime(photo.taken_at) && (
                  <span className="tabular pointer-events-none absolute bottom-1 left-1 rounded
                                   bg-black/55 px-1.5 py-0.5 text-[0.7rem] text-white/90
                                   opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
                    {clockTime(photo.taken_at)}
                  </span>
                )}
              </a>
            ))}
          </div>
        ))}
      </div>

      <Lightbox
        photos={items.map((it) => it.photo)}
        index={viewing}
        onClose={() => setViewing(null)}
        onIndex={setViewing}
      />

      {hasMore && (
        <div ref={sentinel} className="flex justify-center py-8">
          <Button variant="outline" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more photos'}
          </Button>
        </div>
      )}
    </div>
  );
}
