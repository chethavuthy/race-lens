/**
 * What counts as a bib at this race, and the pass that applies it.
 *
 * These settings govern what a pass READS, which is why they sit next to the
 * control that re-reads. Getting them wrong is silent in both directions: too
 * high a floor and every bib is discarded — SheRuns read 0 bibs across 199 faces
 * under a floor of 3, because its bibs are two digits — too low and a partial
 * read of a longer number enters the index looking exactly like a real short one.
 */
import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { api, type EventSummary } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const DIGITS = [2, 3, 4, 5];

function Choice<T extends string | number>({
  options, value, onPick, disabled,
}: {
  options: [T, string][]; value: T; onPick: (v: T) => void; disabled?: boolean;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border p-1" role="radiogroup">
      {options.map(([v, label]) => (
        <button
          key={String(v)}
          role="radio"
          aria-checked={value === v}
          disabled={disabled}
          onClick={() => onPick(v)}
          className={`tabular rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${
            value === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function BibRules({
  event, indexed, busyPass, onChanged,
}: {
  event: EventSummary;
  indexed: number;
  /** A pass is already running, so nothing here may start another. */
  busyPass: boolean;
  onChanged: (notice: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [prefixDraft, setPrefixDraft] = useState<string | null>(null);

  const min = event.bib_min_digits ?? 3;
  const max = event.bib_max_digits ?? 5;
  const prefixes = event.bib_prefixes ?? '';
  const required = event.bib_prefix_required === true;
  const on = event.bibs_enabled !== false;

  // Every message ends the same way, and that half is the important one: a changed
  // rule applies only to what LATER passes read. Recheck cannot apply it — it
  // skips photos that are already indexed, which on a finished album is all of
  // them, so it reports the album complete and reads nothing.
  const REREAD = ' Photos already indexed keep the numbers they have — press '
    + '"Re-read bib numbers" to apply this to the whole album.';

  async function save(fn: () => Promise<unknown>, notice: string) {
    setBusy(notice); setError(null);
    try { await fn(); onChanged(notice); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function reread() {
    if (!confirm) { setConfirm(true); return; }
    setConfirm(false);
    setBusy('reread'); setError(null);
    try {
      const r = await api.admin.rereadBibs(event.id);
      const rounds = r.started.reduce((n, s) => n + s.rounds, 0);
      onChanged(
        `Re-reading bib numbers on ${r.started.length} `
        + `${r.started.length === 1 ? 'Drive link' : 'Drive links'}. Every photo is `
        + `downloaded again, so expect about ${rounds} ${rounds === 1 ? 'round' : 'rounds'}. `
        + 'Faces and thumbnails are untouched.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  // mb-8 matches every other section on the page that hosts this. Without it the
  // card sat flush against "Drive links" — the one seam on that page with no gap,
  // which read as the two cards being a single block. The spacing lives here
  // rather than on a wrapper at the usage site, so the card cannot be placed
  // somewhere else and lose it.
  return (
    <section className="mb-8 rounded-xl border border-border p-5">
      <h2 className="mb-4 text-sm font-semibold text-muted-foreground">Bib numbers</h2>
      {error && (
        <p className="mb-4 rounded-md border border-destructive/45 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      <div className="space-y-5">
        <div>
          <Label>Did runners wear bibs?</Label>
          <div className="mt-1.5">
            <Choice
              options={[[1, 'Runners wear bibs'], [0, 'No bibs']]}
              value={on ? 1 : 0}
              disabled={!!busy}
              onPick={(v) => save(
                () => api.admin.setBibsEnabled(event.id, v === 1),
                v === 1
                  ? 'Bib numbers on.' + REREAD
                  : 'Bib numbers off — bib search is hidden and later passes skip reading them. Bibs already read are kept.')}
            />
          </div>
        </div>

        {on && (
          <>
            <div className="flex flex-wrap gap-6">
              <div>
                <Label htmlFor="bib-min">Shortest bib</Label>
                <Select
                  value={String(min)} disabled={!!busy || busyPass}
                  onValueChange={(v) => v && save(
                    () => api.admin.setBibRules(event.id, { bib_min_digits: Number(v) }),
                    `Shortest bib is now ${v} digits.` + REREAD)}
                >
                  <SelectTrigger id="bib-min" className="mt-1.5 w-[9rem]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DIGITS.map((n) => <SelectItem key={n} value={String(n)}>{n} digits</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="bib-max">Longest bib</Label>
                <Select
                  value={String(max)} disabled={!!busy || busyPass}
                  onValueChange={(v) => v && save(
                    () => api.admin.setBibRules(event.id, { bib_max_digits: Number(v) }),
                    `Longest bib is now ${v} digits.` + REREAD)}
                >
                  <SelectTrigger id="bib-max" className="mt-1.5 w-[9rem]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {/* At or above the floor only: an inverted pair matches no bib
                        at all, and the API refuses it. */}
                    {DIGITS.filter((n) => n >= min).map((n) => (
                      <SelectItem key={n} value={String(n)}>{n} digits</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {min === max
                ? `Bibs here are exactly ${min} digits. Every other number in the photo — a year on a banner, a distance marker — is ignored.`
                : 'Numbers outside this range are ignored, which is what keeps years off signage and distance markers out of bib search.'}
            </p>

            <div>
              <Label htmlFor="pfx">Category letters on bibs</Label>
              <div className="mt-1.5 flex flex-wrap gap-3">
                <Input
                  id="pfx"
                  value={prefixDraft ?? prefixes}
                  placeholder="none — e.g. F, M"
                  disabled={!!busy || busyPass}
                  onChange={(e) => setPrefixDraft(e.target.value)}
                  className="max-w-[16rem]"
                />
                <Button
                  variant="outline"
                  disabled={!!busy || busyPass || prefixDraft === null}
                  onClick={() => save(async () => {
                    const value = (prefixDraft ?? '').trim();
                    await api.admin.setBibRules(event.id, { bib_prefixes: value });
                    setPrefixDraft(null);
                  }, (prefixDraft ?? '').trim()
                    ? `Bibs may start with ${(prefixDraft ?? '').trim().toUpperCase()}.` + REREAD
                    : 'Bibs are digits only now.' + REREAD)}
                >
                  Save
                </Button>
              </div>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                {prefixes
                  ? <>Bibs may be plain numbers or start with <strong className="text-foreground">{prefixes.split(',').join(' / ')}</strong> — <code>{prefixes.split(',')[0]}-0001</code> and <code>0001</code> are different runners and stay separate in search.</>
                  : <>Leave empty for plain numbers. If this race numbers by category — <code>0001</code> for the marathon, <code>F-0001</code> and <code>M-0001</code> for the 10k — list the letters. Without them a bib with a letter is read and then discarded, and no digit setting recovers it.</>}
              </p>
            </div>

            {prefixes && (
              <div>
                <Label>Do any bibs have no letter?</Label>
                <div className="mt-1.5">
                  <Choice
                    options={[[0, 'Mixed — some plain'], [1, 'Every bib has a letter']]}
                    value={required ? 1 : 0} disabled={!!busy || busyPass}
                    onPick={(v) => save(
                      () => api.admin.setBibRules(event.id, { bib_prefix_required: v === 1 }),
                      (v === 1
                        ? 'Every bib must now start with a letter — a number read without one is ignored.'
                        : 'Plain numbers count as bibs again, alongside the lettered ones.') + REREAD)}
                  />
                </div>
                <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                  {required
                    ? 'A number read without a letter is ignored rather than stored. That loses the occasional photo where the letter was folded or out of frame — but it cannot file a runner under someone else’s number, which is what storing the bare digits would do.'
                    : 'If a pass reads the digits but misses the letter, that photo lands on the plain number. Pick the other option if this race has no plain bibs at all.'}
                </p>
              </div>
            )}

            {/* The pass that applies all of the above. Placed here, with the
                settings, because that is the question it answers — and because
                putting it among the Drive-link actions is what made Recheck look
                like the answer. */}
            <div className="border-t border-border pt-5">
              <Label>Apply these rules to photos already indexed</Label>
              <div className="mt-1.5 flex flex-wrap gap-3">
                <Button
                  variant={confirm ? 'destructive' : 'outline'}
                  disabled={busy === 'reread' || busyPass || !indexed}
                  onClick={reread}
                >
                  {busy === 'reread' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {confirm ? 'Yes — re-read every photo' : 'Re-read bib numbers'}
                </Button>
                {confirm && <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>}
              </div>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                {!indexed
                  ? 'Nothing is indexed yet, so there is nothing to re-read.'
                  : confirm
                    ? 'Every photo is downloaded from Drive again, and rounds do not chain by themselves, so you may need to press Continue between them. Faces, thumbnails and face search are untouched, and bibs you corrected by hand are kept.'
                    : <>Changing a rule above only affects later passes. This is the pass — it re-reads all {indexed.toLocaleString()} photos. <strong className="text-foreground">Recheck will not do it</strong>, because it only looks at photos that are not indexed yet.</>}
              </p>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
