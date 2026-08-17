/**
 * CANONICAL BIB FORM — mirrored in indexer/bibs.py (normalize_bib, PREFIX_SEP).
 * Changing one requires changing the other, like the vector contract in search.ts.
 *
 *   printed        stored (bibs.bib)   what a runner may type
 *   "0056"         "56"                0056, 56, #56
 *   "F-0001"       "F-1"               F-0001, f0001, F 1, f-1
 *
 * Leading zeros come off the digits, as they always have, so "0056" and "56"
 * resolve to one row.
 *
 * THE PREFIX DOES NOT COME OFF. At a race that numbers by category — 0001 is a
 * marathon runner, F-0001 a 10k woman, M-0001 a 10k man — three different people
 * share those digits. Dropping the letter files their photos under one number,
 * which is the failure the old digits-only rule avoided by refusing such bibs
 * outright. This is also why the search below matches exactly and merely OFFERS
 * the other categories rather than folding them in.
 */
export const PREFIX_SEP = '-';

const BIB_TOKEN = /^([A-Z]{1,2})?([0-9]{1,5})$/;

/**
 * Anything a person or an OCR pass might produce -> the stored form. '' when it
 * is not a bib at all.
 *
 * Permissive about input (case, separators, padding, a leading '#') and exact
 * about output, because it is called on runner typing, operator typing and OCR
 * text. [0-9] rather than \d throughout: Python's \d also matches Unicode
 * decimal digits, and the two sides must agree on what a digit is.
 */
export function normalizeBib(printed: string): string {
  const token = String(printed ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s#]/g, '')
    .split(PREFIX_SEP)
    .join('');
  const m = BIB_TOKEN.exec(token);
  if (!m) return '';
  const digits = (m[2].replace(/^0+(?=[0-9])/, '') || '0');
  return m[1] ? `${m[1]}${PREFIX_SEP}${digits}` : digits;
}

/** The digits half of a stored bib: 'F-1' -> '1', '56' -> '56'. */
export function bibDigits(stored: string): string {
  const i = stored.indexOf(PREFIX_SEP);
  return i === -1 ? stored : stored.slice(i + 1);
}

/** The prefix half, or '' for a bare number. */
export function bibPrefix(stored: string): string {
  const i = stored.indexOf(PREFIX_SEP);
  return i === -1 ? '' : stored.slice(0, i);
}

/** 'F, m ,42' -> ['F','M']. Mirrors parse_prefixes in indexer/bibs.py. */
export function parsePrefixes(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of String(raw ?? '').replace(/;/g, ',').split(',')) {
    const p = part.trim().toUpperCase();
    if (/^[A-Z]{1,2}$/.test(p) && !out.includes(p)) out.push(p);
  }
  return out;
}
