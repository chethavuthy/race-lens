/**
 * Put the reader back where they were, and keep putting them there while the
 * page grows under them.
 *
 * The browser does this natively on a full page load, but a client-side router
 * owns its own navigation, so what it does not do, nobody does. Every page here
 * mounts empty and fills in from the API, which is what makes it hard: at the
 * moment a POP lands, the document is a header and a spinner.
 *
 * Correcting repeatedly rather than waiting for the right moment and scrolling
 * once. Two obvious approaches both fail:
 *
 *   - Scroll immediately, and the browser clamps 3,000px to the bottom of a
 *     200px document. The position is gone before the data arrives.
 *   - Wait until the document is tall enough, then scroll — but "tall enough"
 *     can be measured against the OUTGOING page, which is about to be replaced
 *     by a short one.
 *
 * There is no single instant that is right for every page, so this stops looking
 * for one and re-applies the target every 50ms until it sticks.
 *
 * setInterval, not requestAnimationFrame: rAF does not fire at all in a tab that
 * is not being painted, so a rAF-driven restore never runs there.
 */
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';

const RESTORE_MS = 1500;
const positions = new Map<string, number>();
let restoring = 0;

function restoreScroll(top: number) {
  clearInterval(restoring);

  const stop = () => {
    clearInterval(restoring);
    restoring = 0;
    for (const e of ['wheel', 'touchstart', 'keydown'] as const) {
      window.removeEventListener(e, stop);
    }
  };

  // The reader gets the last word. Once they have started moving the page
  // themselves, yanking them back to a remembered offset is worse than
  // forgetting it, so the first real input ends the correction.
  for (const e of ['wheel', 'touchstart', 'keydown'] as const) {
    window.addEventListener(e, stop, { passive: true });
  }

  const apply = () => {
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo(0, Math.min(top, max));
  };

  // Once before the first tick: a page restored from cache is already its full
  // height here, and waiting 50ms shows the top of the album for a frame first.
  apply();

  const deadline = performance.now() + RESTORE_MS;
  restoring = window.setInterval(() => {
    apply();
    if (window.scrollY >= top - 1 || performance.now() > deadline) stop();
  }, 50);
}

/**
 * Remembers where each history entry was, and restores on Back or Forward.
 *
 * Keyed by location.key, which is the browser history entry — not the path. Two
 * visits to the same album are two entries and two positions, which is what a
 * reader expects from Back.
 */
export function useScrollRestoration() {
  const location = useLocation();
  const navType = useNavigationType();
  const key = useRef(location.key);

  useEffect(() => {
    // Ours to do, so tell the browser to stop trying as well — otherwise both
    // fire on a reload and the page visibly jumps twice.
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  }, []);

  // Record continuously rather than on unmount: a navigation can unmount the
  // page before an effect cleanup reads the final position.
  useEffect(() => {
    key.current = location.key;
    const onScroll = () => positions.set(key.current, window.scrollY);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [location.key]);

  useEffect(() => {
    const saved = positions.get(location.key);
    if (navType === 'POP' && saved) restoreScroll(saved);
    else if (navType === 'PUSH') window.scrollTo(0, 0);
    // REPLACE leaves the scroll alone: it is how a search updates the URL in
    // place, and yanking the reader to the top on every keystroke would be its
    // own bug.
  }, [location.key, navType]);
}

/**
 * Back, meaning back.
 *
 * A <Link to="/"> PUSHES a new entry, so the reader arrives at a fresh copy of
 * the list at the top, with their place gone and the Back button now pointing
 * at the page they just left. When there is a previous entry in this session,
 * this goes back to it — which is a POP, so the restoration above applies and
 * the reader lands exactly where they were.
 *
 * `key === 'default'` marks the entry the app booted on: someone who opened an
 * album link directly has nothing behind them, so for them this is a normal
 * navigation to `to`.
 */
export function useBack(to: string) {
  const navigate = useNavigate();
  const { key } = useLocation();
  return () => {
    if (key !== 'default') navigate(-1);
    else navigate(to);
  };
}
