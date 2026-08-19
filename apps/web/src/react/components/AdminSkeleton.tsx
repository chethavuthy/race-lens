/**
 * /admin, before the answer arrives.
 *
 * This page resolves to one of two entirely different layouts — the publish tool
 * or the invitation — and which one is not known until the API answers, because
 * only the API knows whether this person is through the door. No placeholder can
 * be right for both, so this one stands in for the publish tool: the operator and
 * every added photographer see that, and a stranger sees the invitation once.
 *
 * It is only ever shown when the check is genuinely slow — see useDeferredLoading,
 * and the trace that produced it. Same wrappers and same spacing as the real page,
 * so what does appear does not move when it is replaced.
 */
import { Skeleton } from '@/components/ui/skeleton';

export function AdminSkeleton() {
  return (
    <div className="pb-16" aria-hidden>
      <header className="mb-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-2 h-4 w-full max-w-xl" />
        <Skeleton className="mt-1.5 h-4 w-3/4 max-w-md" />
      </header>

      {/* Step 1, class for class with the real card. */}
      <section className="mb-6 rounded-xl border border-border p-5">
        <Skeleton className="mb-4 h-6 w-44" />
        <div className="flex flex-wrap gap-3">
          <Skeleton className="h-9 min-w-[16rem] flex-1" />
          <Skeleton className="h-9 w-24" />
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-32" />
        </div>
        <EventRowsSkeleton />
      </section>
    </div>
  );
}

/**
 * The rows on their own, so the loaded page can use them while the list is still
 * arriving — without that, an empty list renders "Nothing published yet", which is
 * a claim rather than a wait.
 */
export function EventRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex flex-wrap items-center gap-4 px-5 py-4">
          <Skeleton className="aspect-video w-28 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1">
            {/* font-medium line, then the text-xs line beneath it. */}
            <Skeleton className="h-5 w-[min(18rem,70%)]" />
            <Skeleton className="mt-1.5 h-3.5 w-52" />
            <Skeleton className="mt-1.5 h-3 w-40" />
          </div>
          <Skeleton className="h-7 w-16" />
        </li>
      ))}
    </ul>
  );
}

/**
 * The inspect grid, before the photos arrive.
 *
 * Same masonry as the loaded screen — three columns at lg, two at sm, one below,
 * the same 1rem gaps, and a card built from the same parts: a frame, then a
 * caption line under it. The ratios are the mix these albums actually hold, with
 * roughly two frames in five portrait, so the placeholder settles to about the
 * height of the thing it stands in for.
 *
 * Columns beyond the first are hidden at the widths where the real grid has no
 * column to show, rather than squeezing three into a phone.
 */
const INSPECT_RATIOS = [
  ['3 / 2', '2 / 3', '3 / 2'],
  ['2 / 3', '3 / 2', '3 / 4'],
  ['3 / 2', '3 / 4', '3 / 2'],
];

export function InspectSkeleton() {
  return (
    <div aria-hidden>
      {/* The count line the real screen prints above the grid. */}
      <Skeleton className="mb-4 h-5 w-24" />
      <div className="flex gap-4">
        {INSPECT_RATIOS.map((column, i) => (
          <div key={i} className={`flex min-w-0 flex-1 flex-col gap-4 ${
            i > 0 ? 'hidden sm:flex' : ''} ${i > 1 ? 'sm:hidden lg:flex' : ''}`}>
            {column.map((ratio, j) => <InspectCardSkeleton key={j} ratio={ratio} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One card: figure border, frame, then the caption row. */
export function InspectCardSkeleton({ ratio = '3 / 2' }: { ratio?: string }) {
  return (
    <figure className="h-fit overflow-hidden rounded-lg border border-border" aria-hidden>
      <Skeleton className="w-full rounded-none" style={{ aspectRatio: ratio }} />
      <figcaption className="flex items-center justify-between gap-2 px-3 py-2">
        <Skeleton className="h-3.5 w-16" />
        <Skeleton className="h-3.5 w-20" />
      </figcaption>
    </figure>
  );
}

/** The roster on "Who can publish", before it arrives. */
export function OrganizerRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex flex-wrap items-center gap-4 px-5 py-4">
          <div className="min-w-0 flex-1">
            {/* font-medium address, then the tabular counts line beneath it. */}
            <Skeleton className="h-5 w-[min(16rem,60%)]" />
            <Skeleton className="mt-1.5 h-3.5 w-64 max-w-full" />
          </div>
          <Skeleton className="h-7 w-28" />
        </li>
      ))}
    </ul>
  );
}
