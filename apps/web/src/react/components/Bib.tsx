/**
 * The signature element: a race bib.
 *
 * A bib is a physical object — a printed header band, tabular numerals, pinned
 * at the top corners. So the search control is not a text field with a magnifying
 * glass; it is the number you wore, at the size you wore it. The same component
 * renders the result header, so the thing you typed becomes the thing you are
 * looking at.
 *
 * `band` is the race's own wording, which is what is actually printed above the
 * number on these bibs ("PHNOM PENH ATHLETICS CLUB").
 */
import { cn } from '@/lib/utils';

export function Bib({
  value, band = 'Race Lens', size = 'lg', className,
}: {
  value: string;
  band?: string;
  size?: 'lg' | 'sm';
  className?: string;
}) {
  return (
    <div
      data-band={band}
      className={cn(
        'bib inline-block select-none text-center',
        // A FIXED width, not shrink-to-fit. A bib is a printed rectangle: it does
        // not get wider as the number gets longer, and one that resized while you
        // typed would be the opposite of the object it is standing in for. It also
        // means the placeholder reserves exactly the loaded size.
        size === 'lg' ? 'w-[20rem] max-w-full px-6 pt-7 pb-4' : 'w-[11rem] px-3 pt-5 pb-2',
        className,
      )}
    >
      <span
        className={cn(
          'block font-bold leading-none tracking-tight',
          size === 'lg' ? 'text-6xl sm:text-7xl' : 'text-2xl',
        )}
      >
        {/* A non-breaking space, not a dash: when the bib is empty the input's
            own placeholder shows through, and a dash under it reads as a second
            value. */}
        {value || '\u00A0'}
      </span>
    </div>
  );
}
