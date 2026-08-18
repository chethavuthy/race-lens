/**
 * Entry point.
 *
 * The paths are unchanged from the app this replaced, so every existing link, every
 * bookmark a runner saved, and the Pages Function in functions/e/[slug].ts that
 * serves OG tags for a shared album all keep working.
 */
import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import App from './react/App';
import './index.css';

const EventList = lazy(() => import('./react/pages/EventList'));
const NotFound = lazy(() => import('./react/pages/NotFound'));
const AdminSignin = lazy(() => import('./react/pages/AdminSignin'));
const EventDetail = lazy(() => import('./react/pages/EventDetail'));
const AdminEvent = lazy(() => import('./react/pages/AdminEvent'));
const Admin = lazy(() => import('./react/pages/Admin'));
const AdminPhotos = lazy(() => import('./react/pages/AdminPhotos'));
// Dev only. The parity gate has no business on a production origin, and the
// vite config strips its fixtures from dist.
const Golden = lazy(() => import('./react/pages/Golden'));

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <BrowserRouter>
      <App>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<EventList />} />
            <Route path="/e/:slug" element={<EventDetail />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/admin/signin" element={<AdminSignin />} />
            <Route path="/admin/e/:id" element={<AdminEvent />} />
            <Route path="/admin/e/:id/photos" element={<AdminPhotos />} />
            {import.meta.env.DEV && <Route path="/golden" element={<Golden />} />}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </App>
    </BrowserRouter>
  </StrictMode>,
);
