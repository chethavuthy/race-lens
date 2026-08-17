/**
 * The canonical bib form, from the Worker's side.
 *
 * This is a two-runtime contract: indexer/bibs.py writes bibs.bib and this module
 * resolves what a runner types to the same string. If they disagree, nothing
 * throws — the search just returns nothing, for an album whose bibs are sitting
 * right there in the table. Same failure shape as the coordinate-space bug in
 * bbox.test.ts: every part individually valid, the composition silently wrong.
 *
 * The cases below are duplicated in indexer/tests/test_bib_pattern.py against
 * normalize_bib, deliberately: that is what makes them a contract rather than two
 * independent opinions.
 */
import { normalizeBib, bibDigits, bibPrefix, parsePrefixes, PREFIX_SEP } from '../src/bib.ts';

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) console.log(`         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
};

console.log('normalizeBib — digits keep working exactly as before');
check('plain', normalizeBib('56'), '56');
check('zero padded', normalizeBib('0056'), '56');
check('all zeros collapses to one', normalizeBib('0000'), '0');
check('hash stripped', normalizeBib('#56'), '56');
check('spaces stripped', normalizeBib(' 56 '), '56');
check('five digits', normalizeBib('12345'), '12345');
check('six digits is not a bib', normalizeBib('123456'), '');
check('empty', normalizeBib(''), '');
check('letters only', normalizeBib('PAC'), '');
// The prefix is IDENTITY. If this ever returns '1', a 10k woman's photos are
// filed under the marathon runner who owns bib 0001.
console.log('normalizeBib — the prefix survives, in every form a person types it');
check('hyphen', normalizeBib('F-0001'), `F${PREFIX_SEP}1`);
check('lowercase', normalizeBib('f-0001'), `F${PREFIX_SEP}1`);
check('space', normalizeBib('F 0001'), `F${PREFIX_SEP}1`);
check('joined', normalizeBib('F0001'), `F${PREFIX_SEP}1`);
check('already normal', normalizeBib('F-1'), `F${PREFIX_SEP}1`);
check('two letters', normalizeBib('MW-0001'), `MW${PREFIX_SEP}1`);
check('different category is a different bib', normalizeBib('M-0001'), `M${PREFIX_SEP}1`);
check('bare is not the prefixed one', normalizeBib('0001') !== normalizeBib('F-0001'), true);
console.log('normalizeBib — what must NOT become a bib');
check('trailing letter (kit text, units)', normalizeBib('0092F'), '');
check('42Km', normalizeBib('42Km'), '');
check('three letters', normalizeBib('XLL-500'), '');
check('letters both ends', normalizeBib('F92F'), '');

console.log('halves');
check('digits of prefixed', bibDigits('F-1'), '1');
check('digits of bare', bibDigits('56'), '56');
check('prefix of prefixed', bibPrefix('F-1'), 'F');
check('prefix of bare', bibPrefix('56'), '');

console.log('parsePrefixes');
check('trims, uppercases, dedupes', parsePrefixes('F, m , f'), ['F', 'M']);
check('drops non-letters', parsePrefixes('F,42,M,'), ['F', 'M']);
check('drops too long', parsePrefixes('F,XLL'), ['F']);
check('semicolons too', parsePrefixes('F;M'), ['F', 'M']);
check('empty', parsePrefixes(''), []);
check('null', parsePrefixes(null), []);

console.log(fail === 0 ? '\nall ok' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
