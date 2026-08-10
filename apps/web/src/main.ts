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
  location.reload();
});

// A completed navigation means the chunks resolved, so the next stale-chunk
// error is a fresh problem and deserves its own reload.
router.afterEach(() => sessionStorage.removeItem(RELOAD_FLAG));

createApp(App).use(router).mount('#app');
