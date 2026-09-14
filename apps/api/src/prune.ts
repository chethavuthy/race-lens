/**
 * May a pass delete `wanted` of this link's `held` photos for having left the
 * Drive folder? Returns the refusal reason, or null to allow it.
 *
 * Pulled out of the route because it is the entire safety of pruning, and the
 * route itself is not reachable from a test.
 *
 * Drive answers a listing of a folder that has been deleted or unshared with
 * HTTP 200 and an empty `files` array, so "the photographer removed every photo"
 * and "we can no longer see the folder" arrive identically. KAIIA RUPP's second
 * link is in the second state today — 510 live photos behind a folder id that
 * files.get answers 404 for.
 *
 * The two mistakes do not cost the same. Refusing leaves stale photos up until a
 * person looks; pruning wrongly deletes a published album and its face index
 * with nothing to restore from. So a prune has to stay a minority of the link,
 * and an empty link cannot be pruned at all.
 */
export const PRUNE_MAX_SHARE = 0.5;

export function pruneRefusal(wanted: number, held: number): string | null {
  if (held <= 0) return 'this link has no photos to prune';
  if (wanted > held * PRUNE_MAX_SHARE) {
    return `would remove ${wanted} of ${held} photos in this link`;
  }
  return null;
}
