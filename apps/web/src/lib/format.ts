/** "1 photo", "2 photos", "1,284 photos" — count formatting used across pages. */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : pluralForm}`;
}

/**
 * The wall-clock time a photo was taken — "07:42".
 *
 * taken_at arrives in EXIF's own format, `YYYY:MM:DD HH:MM:SS`, which is not
 * ISO and which `new Date()` rejects outright in Safari. It is also a LOCAL
 * time with no zone attached: the camera recorded 07:42 at the finish line, so
 * 07:42 is what a runner should read back. Parsing it into a Date and
 * formatting it would silently shift that by the reader's own offset, so the
 * digits are taken as written.
 *
 * Returns '' for anything unrecognised — a missing time renders no caption
 * rather than a wrong one.
 */
export function clockTime(takenAt: string | null): string {
  if (!takenAt) return '';
  // The separator before the clock is required. Without it, a value carrying
  // only a date — "2026:08:02" — matches its own month and day and renders
  // them as "08:02", a plausible-looking time that is entirely fictional.
  const m = /(?:^|[\sT])(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(takenAt.trim());
  if (!m) return '';
  const h = Number(m[1]);
  if (!Number.isFinite(h) || h > 23) return '';
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
