/**
 * One number and what it means.
 *
 * The operator's page answers two questions — did every photo get in, and can a
 * runner actually find themselves — so numbers are the content, not decoration.
 * They are set in the display face at tabular width, with the label beneath in
 * the quiet voice: a figure that changes width while a pass runs is a figure you
 * stop trusting, and these poll every 15 seconds.
 *
 * `tone` is used sparingly. Colour here means "this needs you", so a healthy
 * album is entirely uncoloured.
 */
import { cn } from '@/lib/utils';

export function Stat({
  label, value, hint, tone = 'plain',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'plain' | 'good' | 'warn';
}) {
  return (
    <div>
      <div
        className={cn(
          'tabular font-[family-name:var(--font-display)] text-2xl font-bold leading-none',
          tone === 'good' && 'text-primary',
          tone === 'warn' && 'text-[oklch(0.80_0.16_75)]',
        )}
      >
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="mt-1.5 text-xs text-muted-foreground">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground/70">{hint}</div>}
    </div>
  );
}
