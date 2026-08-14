import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './styles.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./pages/EventList.vue') },
    { path: '/e/:slug', component: () => import('./pages/EventDetail.vue'), props: true },
    { path: '/admin', component: () => import('./pages/Admin.vue') },
    // Gated by Cloudflare Access, unlike /admin itself — reaching it is the
    // sign-in. It redirects to /admin once the cookie is set.
    { path: '/admin/signin', component: () => import('./pages/AdminSignin.vue') },
    { path: '/admin/e/:id', component: () => import('./pages/AdminEvent.vue'), props: true },
    { path: '/admin/e/:id/photos', component: () => import('./pages/AdminPhotos.vue'), props: true },
    // Phase 5 acceptance gate. Dev builds only — never shipped to production.
    ...(import.meta.env.DEV
      ? [{ path: '/golden', component: () => import('./pages/Golden.vue') }]
      : []),
    { path: '/:pathMatch(.*)*', component: () => import('./pages/NotFound.vue') },
  ],
  /**
   * Back goes back to where you were. Everything else opens at the top.
   *
   * Nothing restored scroll before: this returned {top: 0} unconditionally and
   * threw `savedPosition` away, so leaving an event 2,000px down and pressing
   * Back reopened it at the top with the reader's place gone. The browser does
   * this natively on a full page load, but a router that supplies a
   * scrollBehavior takes ownership of it (vue-router sets
   * history.scrollRestoration = 'manual'), so what it does not do, nobody does.
   *
   * savedPosition is set ONLY on a popstate — Back and Forward. A fresh push
   * still opens at the top, which is what a clicked link should do.
   *
   * The wait is the part that matters. Every page here mounts empty and fills in
   * from the API, so at the moment this runs the document is a header and a
   * spinner: scrolling to 2,000px lands at the bottom of a 600px page and the
   * position is silently lost. Tiles are sized by CSS aspect-ratio rather than by
   * decoded images, so the page reaches its full height as soon as the rows
   * exist — one frame after the data arrives, long before any photo has loaded.
   */
  scrollBehavior(_to, _from, savedPosition) {
    if (!savedPosition) return { top: 0 };
    restoreScroll(savedPosition.top);
    // `false` means "leave the scroll alone" — restoreScroll owns it from here.
    return false;
  },
});

/**
 * Put the reader back where they were, and keep putting them there while the
 * page grows under them.
 *
 * Correcting repeatedly rather than waiting for the right moment and scrolling
 * once. Two earlier attempts failed on exactly that question:
 *
 *   - Scroll immediately, and the page is still a header and a spinner. The
 *     browser clamps 300px to the bottom of a 200px document and the position
 *     is gone before the data arrives.
 *   - Wait for the document to be tall enough, then scroll. But at the moment
 *     scrollBehavior runs, the OUTGOING page can still be mounted — coming back
 *     to /admin measured the event page's 2,095px, called it tall enough, and
 *     scrolled into a document that was about to be replaced by a short one.
 *
 * There is no single instant that is right for every page, so this stops
 * looking for one. It re-applies the target every 50ms until the scroll sticks
 * or the window closes, which converges no matter when the content lands or
 * which page was measured.
 *
 * setInterval, not requestAnimationFrame. rAF does not fire at all in a tab
 * that is not being painted, so an rAF-gated promise never settles there — and
 * vue-router awaits what scrollBehavior returns, which left the router hanging
 * mid-navigation in exactly that case.
 *
 * 1.5s, and landing short is a fine outcome — though it should now be rare.
 * Pages restore their own contents from lib/cache.ts before the first paint,
 * grid included, so a reader who was 8,000px into an 8,523-photo album comes
 * back to a document that is already that tall. Only a cold arrival — a reload,
 * or an entry gone past its TTL — has to grow into the offset.
 */
const RESTORE_MS = 1500;
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
  // forgetting it — so the first real input ends the correction.
  for (const e of ['wheel', 'touchstart', 'keydown'] as const) {
    window.addEventListener(e, stop, { passive: true });
  }

  const apply = () => {
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo(0, Math.min(top, max));
  };

  // Once before the first tick. A restored page is already its full height here,
  // so this is usually the only application that happens — waiting 50ms for the
  // interval showed the top of the album for a frame first. It cannot end the
  // correction early, though: a short or outgoing document lands clamped, and
  // only the loop below can tell the difference.
  apply();

  const deadline = performance.now() + RESTORE_MS;
  restoring = window.setInterval(() => {
    apply();
    if (window.scrollY >= top - 1 || performance.now() > deadline) stop();
  }, 50);
}

/**
 * Recover from a chunk that vanished mid-deploy.
 *
 * Every route here is a dynamic import. Deploy a new build while someone is
 * holding the previous index.html and their next navigation asks for a hash
 * that no longer exists — the import rejects and the view simply never
 * renders, leaving the header sitting above an empty page.
 *
 * Reload once to pick up the current index.html. The flag makes it once and
 * not a loop: if the fresh HTML still cannot load its chunk the problem is not
 * a stale build, and a reload cycle would be worse than a blank page.
 */
const RELOAD_FLAG = 'race-lens:chunk-reload';

router.onError((err) => {
  const message = String((err as Error)?.message ?? err);
  const isStaleChunk =
    /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(message);
  if (!isStaleChunk) return;
  if (sessionStorage.getItem(RELOAD_FLAG)) return;
  sessionStorage.setItem(RELOAD_FLAG, '1');

  // Reloading alone is not enough when the chunk is POISONED rather than gone.
  //
  // A deploy can answer an asset request with index.html (the SPA rule, 200) in
  // the window before the edge has the file, and /assets/* is served
  // `immutable` for a year — so a browser that stored that HTML under a .js URL
  // will keep handing it back, reload after reload, without ever asking the
  // network again. That is what took /admin down on 2026-08-12 and what left
  // browsers broken after the edge had recovered.
  //
  // The chunk's URL is in the error message, so re-fetch exactly that with
  // `cache: 'reload'`, which forces the network and replaces the stored entry.
  // Everything is best-effort: an unparseable message or a failed fetch still
  // reloads, because a stale build is the other, more common cause.
  const url = message.match(/https?:\/\/[^\s'")]+/)?.[0];
  const purge = url && url.includes('/assets/')
    ? fetch(url, { cache: 'reload' }).catch(() => {})
    : Promise.resolve();
  purge.then(() => location.reload());
});

// A completed navigation means the chunks resolved, so the next stale-chunk
// error is a fresh problem and deserves its own reload.
router.afterEach(() => sessionStorage.removeItem(RELOAD_FLAG));

createApp(App).use(router).mount('#app');

// The entry loaded and the app is up, so the one-shot boot recovery in
// index.html has done its job. Clearing it here — rather than never — means a
// deploy tomorrow gets its own single retry instead of finding the flag already
// set and leaving the visitor on a blank page.
//
// Keep this string identical to the one in index.html; it is written there and
// cleared here precisely because nothing else runs when the entry fails.
const BOOT_FLAG = 'race-lens:boot-reload';
sessionStorage.removeItem(BOOT_FLAG);
