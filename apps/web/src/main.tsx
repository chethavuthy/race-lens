/**
 * React entry. Replaces main.ts (Vue) — see the migration note in App.tsx.
 *
 * Routes are the same paths the Vue router served, so every existing link,
 * bookmark and the Pages Function in functions/e/[slug].ts keep working.
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
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </App>
    </BrowserRouter>
  </StrictMode>,
);
