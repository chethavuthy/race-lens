import { useEffect, useState } from 'react';
import type { FaceBox, Photo } from './api';

/**
 * One tile in a photo grid.
 *
 * Browse passes a bare photo. A bib search adds nothing else. A face search
 * also carries the box of the face that actually matched, which is what lets
 * the tile crop to that runner rather than showing the whole pack.
 */
export interface GridItem {
  photo: Photo;
  score?: number;
  /**
   * The matched face as FRACTIONS of the frame, exactly as the API returns it.
   *
   * Fractions rather than pixels so that nothing here has to know — or agree
   * about — the pixel space the indexer measured in. That agreement is what
   * broke once, invisibly.
   */
  box?: FaceBox | null;
}

/* ------------------------------------------------------------------ masonry --
   Shared by the runner's photo wall and the operator's inspect screen. It lived
   inside PhotoWall until the admin grid needed the same behaviour; two copies of
   a layout that has to agree is how they stop agreeing. */

/** Column counts by viewport width, widest first. */
export const WALL_COLUMNS = [
  { min: 1101, columns: 4 },
  { min: 561, columns: 3 },
  { min: 0, columns: 2 },
];

/** Fewer, wider columns: each card carries a caption, bib chips and controls. */
export const INSPECT_COLUMNS = [
  { min: 1101, columns: 3 },
  { min: 561, columns: 2 },
  { min: 0, columns: 1 },
];

type Breakpoints = { min: number; columns: number }[];

function columnsFor(bp: Breakpoints, width: number): number {
  return (bp.find((b) => width >= b.min) ?? bp[bp.length - 1]).columns;
}

export function useColumnCount(bp: Breakpoints = WALL_COLUMNS): number {
  const [n, setN] = useState(() =>
    typeof window === 'undefined' ? bp[0].columns : columnsFor(bp, window.innerWidth));
  useEffect(() => {
    const onResize = () => setN(columnsFor(bp, window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [bp]);
  return n;
}

/**
 * Deal items into columns, each going to whichever column is currently shortest.
 *
 * NOT CSS multi-column: `columns: 4` balances its content, so appending a page
 * reflows every item and photos already on screen jump between columns. Dealing
 * one at a time means the placement of the first N items never changes when page
 * N+1 arrives.
 *
 * `weight` returns each item's height relative to the column width — unit-free,
 * so nothing has to be measured and nothing reflows as images decode.
 */
export function dealIntoColumns<T>(
  items: T[],
  columnCount: number,
  weight: (item: T) => number,
): T[][] {
  const cols: T[][] = Array.from({ length: columnCount }, () => []);
  const heights = new Array(columnCount).fill(0);
  for (const item of items) {
    let shortest = 0;
    for (let i = 1; i < columnCount; i++) if (heights[i] < heights[shortest]) shortest = i;
    cols[shortest].push(item);
    heights[shortest] += weight(item);
  }
  return cols;
}
