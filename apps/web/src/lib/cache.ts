/**
 * What a page has already loaded, kept for the length of the visit.
 *
 * Every page here mounts empty and fetches, which is right the first time and
 * wrong on the way back. Pressing Back re-mounted the event page, re-requested
 * the first 60 photos, and painted a skeleton over content the browser had had
 * a moment earlier — so returning to an album flashed grey, then rebuilt a grid
 * one page tall, then tried to restore a scroll position that no longer existed
 * in a document that short.
 *
 * A page reads its cache DURING setup, not after an await, because that is the
 * whole point: the first paint has to be the finished page. Anything that
 * resolves a promise first — an API-layer cache, a fetch that happens to hit —
 * still renders one frame of skeleton and still hands the scroll restorer a
 * document too short to hold the offset it is aiming for.
 *
 * The stores live HERE rather than in the components that use them. A
 * `<script setup>` block is a setup() body, so a cache created inside one is
 * created again on every mount — which is exactly the thing being cached
 * against. Module scope is what makes it outlive the component.
 *
 * In memory only, and deliberately. This is for the back button within one
 * visit, not a persistence layer: a reload should fetch, because that is what a
 * reader does when they think something is stale.
 */

import type { EventSummary, Credit, Photo } from './api';
import type { GridItem } from './grid';

interface Entry<T> {
  value: T;
  at: number;
}

interface Cache<T> {
  read(key: string): T | null;
  write(key: string, value: T): void;
}

/**
 * Five minutes.
 *
 * Albums are near-immutable — an event that is still indexing grows, everything
 * else is fixed — so this is not really about the photo list going out of date.
 * It is a bound on how long a reader can wander off and come back to something
 * we never re-checked.
 */
const TTL_MS = 5 * 60_000;

/**
 * @param limit  How many keys to keep. Sized per cache rather than globally
 *   because the entries are not comparable: one album's browse state can hold
 *   8,523 photo records, while a bib search holds a handful, and a shared budget
 *   would let one album evict every search that came before it.
 */
function createCache<T>(limit: number): Cache<T> {
  const store = new Map<string, Entry<T>>();

  return {
    read(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (performance.now() - hit.at > TTL_MS) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },

    write(key, value) {
      // Delete first so a rewrite moves the key to the end: Map iterates in
      // insertion order, which makes the first key the oldest and eviction a
      // one-liner.
      store.delete(key);
      store.set(key, { value, at: performance.now() });
      while (store.size > limit) store.delete(store.keys().next().value as string);
    },
  };
}

export type Tab = 'bib' | 'selfie' | 'upload';

/** Everything an event page has on screen, restored under key = event slug. */
export interface EventPageState {
  event: EventSummary;
  credits: Credit[];
  /** Every page of the browse grid the reader scrolled through, not just the first. */
  photos: Photo[];
  cursor: string | null;
  tab: Tab;
  results: GridItem[] | null;
  searchedBy: Tab | null;
  searchNote: string | null;
  cropToFace: boolean;
}

export interface BibSearchState {
  results: GridItem[];
  note: string | null;
  fuzzyOffered: boolean;
  /**
   * Same digits, different category ('F-1', 'M-1'). Cached with the results
   * because a reader coming back via Back must see the same offer they left —
   * otherwise the way out of an empty search silently disappears.
   */
  alternatives: string[];
}

/** One album's browse state is large and readers rarely alternate between three. */
export const eventPageCache = createCache<EventPageState>(2);

/** Bib results are small, and a runner does flick between several numbers. */
export const bibSearchCache = createCache<BibSearchState>(12);

/** A single list under a single key. */
export const eventListCache = createCache<EventSummary[]>(1);

/**
 * Photo ids whose thumbnail has decoded at least once this visit.
 *
 * Lives here rather than in PhotoGrid for the same reason the caches do: the
 * component is rebuilt on every visit and the browser's image cache is not, so
 * a per-instance set made a returning reader watch 60 cached thumbnails fade in
 * again from grey.
 *
 * No TTL and no eviction. It holds ids, not photos — walking the whole 32,796
 * of the largest album costs a couple of megabytes of strings, against photo
 * records that are already far larger — and an id that decoded stays decoded.
 */
export const decodedThumbs = new Set<string>();
