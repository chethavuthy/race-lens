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
  scrollBehavior: () => ({ top: 0 }),
});

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
