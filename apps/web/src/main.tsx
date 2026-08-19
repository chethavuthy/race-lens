/**
 * Entry point.
 *
 * The paths are unchanged from the app this replaced, so every existing link, every
 * bookmark a runner saved, and the Pages Function in functions/e/[slug].ts that
 * serves OG tags for a shared album all keep working.
 */
import { Component, StrictMode, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import App from './react/App';
import './index.css';

/**
 * A page chunk, with the one recovery a hashed-asset deploy needs.
 *
 * _redirects has claimed this guard existed since it was written. It did not, and
 * the failure it describes is real and reachable: during a deploy there is a
 * window where index.html names a chunk the edge has not caught up with, that
 * request falls through the SPA rewrite to index.html, and the browser is handed
 * an HTML document under a .js URL. What the operator saw was
 *
 *   Failed to load module script: Expected a JavaScript-or-Wasm module script but
 *   the server responded with a MIME type of "text/html"
 *   Uncaught TypeError: Failed to fetch dynamically imported module: …
 *
 * and then nothing — a blank frame, because Suspense has no error path and the
 * rejection had nowhere to go. The same shape happens to anyone holding an old
 * index.html when a deploy lands: their chunk names no longer exist.
 *
 * So a failed page import reloads the document ONCE, which fetches a fresh
 * index.html (HTML is not cached immutable — only /assets/* is) and with it the
 * chunk names that actually exist now. A reload also revalidates subresources,
 * which is what evicts an HTML document a browser cached under a .js URL for a
 * year.
 *
 * At most one reload per ten minutes per tab, recorded as a TIMESTAMP rather than
 * a boolean, and never cleared by a success. That distinction is the difference
 * between a guard and a reload loop: with a boolean cleared on the first
 * successful chunk, a page whose chunk is genuinely gone reloads, the entry chunk
 * loads fine and clears the flag, the broken page is reached again, and it reloads
 * again — forever. A time window cannot do that, and it still re-arms in time for
 * the next deploy.
 */
const RELOAD_KEY = 'race-lens:chunk-reload';
const RETRY_WINDOW_MS = 10 * 60 * 1000;

// Private-mode Safari throws on sessionStorage. A guard that takes the page down
// while trying to save it is not a guard — with no store, no reload is attempted
// and the boundary below says what happened instead.
const retry = {
  allowed: () => {
    try {
      const at = Number(sessionStorage.getItem(RELOAD_KEY));
      return !at || Date.now() - at > RETRY_WINDOW_MS;
    } catch { return false; }
  },
  record: () => { try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* no store */ } },
  forget: () => { try { sessionStorage.removeItem(RELOAD_KEY); } catch { /* no store */ } },
};

type PageModule = { default: ComponentType<Record<string, never>> };

function lazyPage(load: () => Promise<PageModule>) {
  return lazy<ComponentType<Record<string, never>>>(() => load().catch(
    (err: unknown): Promise<PageModule> => {
      if (!retry.allowed()) throw err;   // already tried; let the boundary say so
      retry.record();
      window.location.reload();
      // Never settles, deliberately. The document is being replaced, and
      // rejecting here would flash the error state on the way out.
      return new Promise<PageModule>(() => {});
    },
  ));
}

const EventList = lazyPage(() => import('./react/pages/EventList'));
const NotFound = lazyPage(() => import('./react/pages/NotFound'));
const AdminSignin = lazyPage(() => import('./react/pages/AdminSignin'));
const EventDetail = lazyPage(() => import('./react/pages/EventDetail'));
const AdminEvent = lazyPage(() => import('./react/pages/AdminEvent'));
const Admin = lazyPage(() => import('./react/pages/Admin'));
const AdminPhotos = lazyPage(() => import('./react/pages/AdminPhotos'));
const Organizers = lazyPage(() => import('./react/pages/Organizers'));
// Dev only. The parity gate has no business on a production origin, and the
// vite config strips its fixtures from dist.
const Golden = lazyPage(() => import('./react/pages/Golden'));

/**
 * The last resort, for when the reload above did not fix it.
 *
 * Suspense has no error path, so a page chunk that cannot load renders an empty
 * document and a console message nobody outside DevTools will ever see. A runner
 * who opened a shared album link deserves a sentence and a button instead.
 */
class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="py-16 text-center">
        <p className="text-lg font-bold tracking-tight">This page did not load</p>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          Usually a version of the site that has just been replaced. Reloading
          fixes it.
        </p>
        <button
          onClick={() => { retry.forget(); window.location.reload(); }}
          className="mt-6 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Reload
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <BrowserRouter>
      <App>
        <PageBoundary>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<EventList />} />
            <Route path="/e/:slug" element={<EventDetail />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/admin/signin" element={<AdminSignin />} />
            <Route path="/admin/organizers" element={<Organizers />} />
            <Route path="/admin/e/:id" element={<AdminEvent />} />
            <Route path="/admin/e/:id/photos" element={<AdminPhotos />} />
            {import.meta.env.DEV && <Route path="/golden" element={<Golden />} />}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
        </PageBoundary>
      </App>
    </BrowserRouter>
  </StrictMode>,
);
