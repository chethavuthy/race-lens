/**
 * The event console, before its report arrives.
 *
 * Same wrappers, same grids, same row heights as the loaded page — and shown only
 * when the wait is real, per useDeferredLoading. The report is eight aggregate
 * queries, so this one does get seen.
 */
import { Skeleton } from '@/components/ui/skeleton';

function StatRow({ n = 4 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
      {Array.from({ length: n }, (_, i) => (
        <div key={i}>
          <Skeleton className="h-7 w-16" />
          <Skeleton className="mt-2 h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

export function AdminEventSkeleton() {
  return (
    <div className="pb-16" aria-hidden>
      <Skeleton className="mb-6 h-5 w-24" />
      <header className="mb-8">
        <Skeleton className="h-8 w-[min(24rem,75%)]" />
        <Skeleton className="mt-2 h-4 w-52" />
      </header>

      <section className="mb-8 rounded-xl border border-border p-5">
        <Skeleton className="mb-4 h-4 w-20" />
        <StatRow />
      </section>

      <section className="mb-8 rounded-xl border border-border p-5">
        <Skeleton className="mb-4 h-4 w-52" />
        <StatRow />
        <Skeleton className="mt-4 h-4 w-full max-w-2xl" />
        <Skeleton className="mt-1.5 h-4 w-3/4 max-w-xl" />
        <Skeleton className="mt-4 h-7 w-32" />
      </section>

      <section className="mb-8 rounded-xl border border-border p-5">
        <Skeleton className="mb-4 h-4 w-24" />
        <div className="space-y-5">
          <Skeleton className="h-9 w-64" />
          <div className="flex gap-6"><Skeleton className="h-9 w-48" /><Skeleton className="h-9 w-48" /></div>
          <Skeleton className="h-4 w-full max-w-2xl" />
        </div>
      </section>

      <section className="rounded-xl border border-border">
        <Skeleton className="m-5 h-4 w-28" />
        <ul className="divide-y divide-border border-t border-border">
          {[0, 1].map((i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4">
              <div className="min-w-0 flex-1">
                <Skeleton className="h-4 w-[min(22rem,60%)]" />
                <Skeleton className="mt-1.5 h-3 w-64" />
              </div>
              <Skeleton className="h-7 w-20" />
            </li>
          ))}
        </ul>
        <div className="border-t border-border px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-9 min-w-[16rem] flex-1" />
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-9 w-24" />
          </div>
        </div>
      </section>
    </div>
  );
}
