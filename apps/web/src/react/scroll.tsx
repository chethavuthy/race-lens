/**
 * Put the reader back where they were.
 *
 * Keyed by PATH, not by history entry. Two earlier attempts keyed on
 * location.key and both failed for the same reason: they made "return to the
 * list" a piece of history arithmetic, and history is not a reliable place to
 * count. Ten bib searches pushed ten entries, so a Back-shaped control stepped
 * through them one at a time — ten clicks to reach the list. Replacing the search
 * fixed the count, but the key test used to decide "is there something behind me"
 * (`key === 'default'`) is React Router v6 behaviour that v7 does not have: v7
 * assigns a real key to the first entry too, so the test silently misfired.
 *
 * By path, none of that matters. Leaving a page records where it was; arriving at
 * a page we have a record for puts the reader back there, whether they got there
 * by Back, by a link, or by the wordmark. That is also what a reader means: "take
 * me back to the list" is about the list, not about the shape of their history.
 *
 * The correction repeats, because every page here mounts empty and fills in from
 * the API — scrolling once on arrival lands in a document that is still a header
 * and a spinner, and the browser clamps the offset to the bottom of it.
 *
 * setInterval, not requestAnimationFrame: rAF does not fire in a tab that is not
 * being painted, so a rAF-driven restore never runs there.
 */
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const RESTORE_MS = 1500;
const positions = new Map<string, number>();
// Dev-only handle. Scroll restoration is invisible when it works and hard to
// reason about when it does not, so the state is reachable from the console.
if (import.meta.env.DEV) (window as any).__racelensScroll = positions;
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

  apply();
  const deadline = performance.now() + RESTORE_MS;
  restoring = window.setInterval(() => {
    apply();
    // Stops on the target OR on the page's own ceiling: a list that is shorter
    // than the offset it remembers can never reach it, and spinning for the full
    // 1.5s over that would keep fighting a reader who is already scrolling.
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    if (window.scrollY >= Math.min(top, max) - 1 || performance.now() > deadline) stop();
  }, 50);
}

/**
 * One listener, for the life of the page, installed outside React.
 *
 * It began inside an effect and never fired. The effect ran — twice, as StrictMode
 * does — and a listener attached by hand in the console fired fine, so the
 * subscription was being torn down by a lifecycle this hook does not control.
 * Recording where the reader is has nothing to do with a component's lifetime, so
 * it stops pretending it does: installed once, idempotent, and it reads the path
 * from window.location so there is no captured value to go stale.
 */
let installed = false;

function installRecorder() {
  if (installed) return;
  installed = true;
  window.addEventListener('scroll', () => {
    positions.set(window.location.pathname, window.scrollY);
  }, { passive: true });
}

export function useScrollRestoration() {
  const { pathname } = useLocation();

  useEffect(() => {
    installRecorder();
    // Ours to do, so stop the browser doing it too — otherwise both fire on a
    // reload and the page visibly jumps twice.
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  }, []);

  useEffect(() => {
    const saved = positions.get(pathname);
    if (saved) restoreScroll(saved);
    else window.scrollTo(0, 0);
    // pathname only: a bib search changes the query, not the page, and must not
    // scroll the reader anywhere.
  }, [pathname]);
}
