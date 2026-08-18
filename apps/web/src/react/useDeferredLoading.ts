import { useEffect, useRef, useState } from 'react';

/**
 * Should a placeholder be shown at all?
 *
 * Measured, not guessed: a Chrome trace of this album shows the event request
 * finishing in 117–274ms. A skeleton drawn for 120ms and then replaced is a
 * flash, and a flash reads as a fault — which is why matching its geometry to the
 * pixel did not stop it looking broken. That trace contained no LayoutShift
 * records at all: the movement was never the problem, the blinking was.
 *
 * Two thresholds, doing opposite jobs:
 *
 *   DELAY — wait before showing anything. A response inside this window renders
 *           content directly, so the common case has nothing to flicker.
 *   FLOOR — once shown, keep it. Without this, a response landing just past DELAY
 *           produces exactly the flash we are removing, only later.
 */
// 300, not 220. The trace puts this API at 117–274ms, and a threshold inside that
// range means the placeholder appears on some loads and not others — an
// inconsistency that reads as a glitch of its own. Sitting just past the measured
// spread makes "no placeholder" the reliable outcome on a warm connection.
const DELAY_MS = 300;
const FLOOR_MS = 400;

export function useDeferredLoading(loading: boolean): boolean {
  const [show, setShow] = useState(false);
  const shownAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    clearTimeout(timer.current);

    if (loading) {
      if (show) return;                       // already visible, leave it alone
      timer.current = window.setTimeout(() => {
        shownAt.current = performance.now();
        setShow(true);
      }, DELAY_MS);
      return;
    }

    // Done loading. If it never appeared, there is nothing to take away.
    if (!show) { shownAt.current = 0; return; }
    const left = FLOOR_MS - (performance.now() - shownAt.current);
    if (left <= 0) { shownAt.current = 0; setShow(false); return; }
    timer.current = window.setTimeout(() => { shownAt.current = 0; setShow(false); }, left);
  }, [loading, show]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return show;
}
