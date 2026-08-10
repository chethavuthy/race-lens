import type { Photo } from './api';

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
  /** [x, y, w, h] of the matched face, in SOURCE PIXELS, as the API returns it. */
  bbox?: [number, number, number, number];
}
