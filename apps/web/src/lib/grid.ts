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
