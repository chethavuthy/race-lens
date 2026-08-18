/**
 * App shell.
 *
 * MIGRATION IN PROGRESS — the Vue app under src/pages is being replaced page by
 * page. Only ported routes are wired in main.tsx; the rest still live as .vue
 * files and are not reachable until they are ported. main branch remains the
 * deployable Vue app.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export default function App({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1120px] px-5 pb-14">
      <header className="flex items-center justify-between py-5 pb-7">
        <Link to="/" className="text-xl font-bold tracking-tight">
          Race<span className="text-primary">Lens</span>
        </Link>
        <Link to="/admin" className="text-sm text-muted-foreground">
          Organizer
        </Link>
      </header>
      {children}
    </div>
  );
}
