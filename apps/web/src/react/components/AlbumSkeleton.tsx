/**
 * The album, before it arrives.
 *
 * Built from the SAME structure the loaded page uses — the same wrapper classes,
 * the same real <Bib> shell, the same masonry columns — rather than a parallel
 * guess at what it will look like. A skeleton assembled separately drifts from
 * the thing it stands in for the moment either changes, and every pixel it is
 * wrong by is a jump when the data lands.
 *
 * The tile ratios are the shapes these albums actually contain: roughly two in
 * five frames are portrait, so the placeholder wall has that mix and settles to
 * about the same height as the real one.
 */
import { Bib } from './Bib';
import { Skeleton } from '@/components/ui/skeleton';

const RATIOS = [
  ['3 / 2', '2 / 3', '3 / 2', '3 / 4'],
  ['2 / 3', '3 / 2', '3 / 4', '3 / 2'],
  ['3 / 2', '3 / 4', '2 / 3', '3 / 2'],
  ['3 / 4', '3 / 2', '3 / 2', '2 / 3'],
];

export function AlbumSkeleton() {
  return (
    <div className="pb-16" aria-hidden>
      {/* Back link: same height and bottom margin as BackLink. */}
      <Skeleton className="mb-6 h-5 w-24" />

      {/* Header: h1 is text-2xl/sm:text-3xl, the line beneath is text-sm. */}
      <header className="mb-8">
        <Skeleton className="h-8 w-[min(28rem,80%)] sm:h-9" />
        <Skeleton className="mt-2 h-4 w-44" />
      </header>

      {/* The search panel, class for class. The Bib is the real component with
          no value, so its width and height are exactly the loaded page's. */}
      <div className="mb-10 flex min-h-[22.5rem] flex-col items-center justify-center gap-6
                      rounded-xl border border-border bg-card/40 px-4 py-10">
        <div className="flex flex-col items-center gap-4">
          <Bib value="" band="" />
          <Skeleton className="h-5 w-56" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-4" />
          <Skeleton className="h-9 w-40" />
        </div>
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>

      {/* The wall: the same column structure and gaps as PhotoWall. */}
      <div className="flex gap-1.5 sm:gap-2">
        {RATIOS.map((column, i) => (
          <div key={i} className={`flex min-w-0 flex-1 flex-col gap-1.5 sm:gap-2 ${
            i > 1 ? 'hidden sm:flex' : ''} ${i > 2 ? 'lg:flex' : ''}`}>
            {column.map((ratio, j) => (
              <Skeleton key={j} className="w-full rounded-md" style={{ aspectRatio: ratio }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
