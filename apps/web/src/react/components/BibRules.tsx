/**
 * What counts as a bib at this race — and the pass that applies it.
 *
 * These settings decide what the OCR keeps, and getting them wrong is silent in
 * both directions. Too high a floor and every bib is discarded: SheRuns read zero
 * bibs across 199 faces because its numbers are two digits and the floor was
 * three. Too low, or no ceiling, and years off banners become bibs — that same
 * album stored 2025, 2024 and 100 off a distance marker.
 *
 * The re-read lives here rather than with the Drive links, because "make the
 * album match what I just changed" is the question these controls raise. Recheck
 * cannot do it: it skips photos that are already indexed, which on a finished
 * album is all of them.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, type EventSummary } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const REREAD_NOTE = 'Photos already indexed keep the numbers they have — press '
  + 'Re-read bib numbers to apply this to the whole album.';

function Segmented<T extends string | number | boolean>({
  options, value, onChange, disabled,
}: {
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border p-1">
      {options.map(([v, label]) => (
        <button
          key={String(v)}
          type="button"
          aria-pressed={value === v}
          disabled={disabled}
          onClick={() => onChange(v)}
          className={`rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${
            value === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function BibRules({
  event, indexed, busyExternally, onDone,
}: {
  event: EventSummary;
  indexed: number;
  busyExternally: boolean;
  onDone: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefixDraft, setPrefixDraft] = useState<string | null>(null);
  const [confirmReread, setConfirmReread] = useState(false);

  const on = event.bibs_enabled !== false;
  const min = event.bib_min_digits ?? 3;
  const max = event.bib_max_digits ?? 5;
  const prefixes = event.bib_prefixes ?? '';
  const required = event.bib_prefix_required === true;
  const locked = busyExternally;

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key); setError(null);
    try { await fn(); onDone(ok); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  const setRules = (patch: Parameters<typeof api.admin.setBibRules>[1], ok: string) =>
    run('rules', () => api.admin.setBibRules(event.id, patch), ok);

  return (
    <section className="mb-8 rounded-xl border border-border p-5">
      <h2 className="mb-4 text-sm font-semibold text-muted-foreground">Bib numbers</h2>

      {error && (
        <p className="mb-4 rounded-md border border-destructive/45 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      <Segmented
        options={[[true, 'Runners wear bibs'], [false, 'No bibs']] as const}
        value={on}
        disabled={busy === 'bibs' || locked}
        onChange={(v) => run('bibs', () => api.admin.setBibsEnabled(event.id, v),
          v ? 'Bib numbers on. Later rounds will read them.'
            : 'Bib numbers off. Bib search is hidden and existing bibs are kept.')}
      />

      {on && (
        <div className="mt-6 space-y-6">
          <div>
            <Label className="mb-2">Digits printed on a bib</Label>
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                options={[2, 3, 4, 5].map((n) => [n, String(n)] as const)}
                value={min}
                disabled={busy === 'rules' || locked}
                onChange={(n) => setRules({ bib_min_digits: n }, `Shortest bib is now ${n} digits. ${REREAD_NOTE}`)}
              />
              <span className="text-sm text-muted-foreground">to</span>
              <Segmented
                options={[2, 3, 4, 5].filter((n) => n >= min).map((n) => [n, String(n)] as const)}
                value={max}
                disabled={busy === 'rules' || locked}
                onChange={(n) => setRules({ bib_max_digits: n }, `Longest bib is now ${n} digits. ${REREAD_NOTE}`)}
              />
            </div>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              {min === max
                ? `Bibs here are exactly ${min} digits. Every other number in the photo — a year on a banner, a distance marker — is ignored.`
                : 'Numbers outside this range are ignored, which is what keeps years off banners out of bib search.'}
            </p>
          </div>

          <div>
            <Label htmlFor="pfx" className="mb-2">Category letters on bibs</Label>
            <div className="flex flex-wrap gap-3">
              <Input
                id="pfx"
                value={prefixDraft ?? prefixes}
                onChange={(e) => setPrefixDraft(e.target.value)}
                placeholder="none — e.g. F, M"
                disabled={busy === 'rules' || locked}
                className="max-w-[16rem]"
              />
              <Button
                variant="outline"
                disabled={busy === 'rules' || locked}
                onClick={() => {
                  const v = (prefixDraft ?? prefixes).trim();
                  setRules({ bib_prefixes: v }, v
                    ? `Bibs may start with ${v.toUpperCase()}. ${REREAD_NOTE}`
                    : `Bibs are digits only now. ${REREAD_NOTE}`)
                    .then(() => setPrefixDraft(null));
                }}
              >
                Save
              </Button>
            </div>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              {prefixes
                ? <>Bibs may be plain numbers or start with <strong className="text-foreground">{prefixes.split(',').join(' / ')}</strong>. <code>{prefixes.split(',')[0]}-0001</code> and <code>0001</code> are different runners and stay separate in search.</>
                : <>Only if this race numbers by category — <code>0001</code> for the marathon, <code>F-0001</code> and <code>M-0001</code> for the 10k. Without them a bib with a letter is read and then thrown away.</>}
            </p>
          </div>

          {prefixes && (
            <div>
              <Label className="mb-2">Do any bibs have no letter?</Label>
              <Segmented
                options={[[false, 'Mixed — some plain'], [true, 'Every bib has a letter']] as const}
                value={required}
                disabled={busy === 'rules' || locked}
                onChange={(v) => setRules({ bib_prefix_required: v }, v
                  ? `Every bib must start with a letter — a number read without one is ignored. ${REREAD_NOTE}`
                  : `Plain numbers count as bibs again. ${REREAD_NOTE}`)}
              />
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                {required
                  ? 'A number read without a letter is ignored rather than stored. That loses the occasional photo where the letter was folded out of frame — but it cannot file a runner under someone else’s number.'
                  : 'If a pass reads the digits but misses the letter, that photo lands on the plain number. Pick the other option if this race has no plain bibs at all.'}
              </p>
            </div>
          )}

          <div className="border-t border-border pt-5">
            <Label className="mb-2">Apply these rules to photos already indexed</Label>
            <div className="flex flex-wrap gap-3">
              <Button
                variant={confirmReread ? 'destructive' : 'outline'}
                disabled={busy === 'reread' || locked || !indexed}
                onClick={() => {
                  if (!confirmReread) { setConfirmReread(true); return; }
                  setConfirmReread(false);
                  run('reread', () => api.admin.rereadBibs(event.id),
                    'Re-reading bib numbers. Every photo is downloaded again; faces and thumbnails are untouched.');
                }}
              >
                {busy === 'reread' ? <Loader2 className="animate-spin" /> : null}
                {confirmReread ? 'Yes — start the re-read' : 'Re-read bib numbers'}
              </Button>
              {confirmReread && (
                <Button variant="ghost" onClick={() => setConfirmReread(false)}>Cancel</Button>
              )}
            </div>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              {!indexed
                ? 'Nothing is indexed yet, so there is nothing to re-read.'
                : confirmReread
                  ? 'Every photo is downloaded from Drive again, and rounds do not chain by themselves, so you may need to press Continue between them. Faces, thumbnails and face search are untouched, and bibs you corrected by hand are kept.'
                  : <>Changing a rule above only affects later passes. This is the pass — it re-reads all {indexed.toLocaleString()} photos. <strong className="text-foreground">Recheck will not do it</strong>, because it only looks at photos that are not indexed yet.</>}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
