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
