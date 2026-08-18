/**
 * Type your number and it sets itself in the bib.
 *
 * One input, one control. The visible bib IS the field — the real <input> sits
 * on top of it, transparent, so the caret and the mobile numeric keypad are the
 * browser's own and nothing about focus or accessibility is reimplemented.
 *
 * inputMode="numeric" rather than type="number": a bib is a printed label, not a
 * quantity, and type=number brings spinners and lets a phone offer a decimal
 * point. Letters are allowed through because some races number by category
 * (F-0001), and the API canonicalises what it receives.
 */
import { useId } from 'react';
import { Bib } from './Bib';

export function BibInput({
  value, onChange, onSubmit, band, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  band?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      className="flex flex-col items-center gap-4"
    >
      <label htmlFor={id} className="sr-only">Your bib number</label>
      <div className="relative">
        <Bib value={value} band={band} />
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value.slice(0, 8))}
          disabled={disabled}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="0000"
          aria-describedby={`${id}-hint`}
          className="absolute inset-0 h-full w-full rounded-md bg-transparent pt-7 text-center
                     font-[family-name:var(--font-display)] text-6xl font-bold tracking-tight
                     text-transparent caret-[#0b0e12] outline-none
                     placeholder:text-black/25 focus-visible:ring-3 focus-visible:ring-ring
                     sm:text-7xl"
        />
      </div>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        Type the number you wore, then press enter.
      </p>
    </form>
  );
}
