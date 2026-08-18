/**
 * App shell.
 *
 * Deliberately thin: a wordmark, one link out to the organizer side, and the
 * page. The product is photographs, so the frame around them stays quiet — see
 * docs/design-direction.md.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useScrollRestoration } from './scroll';

export default function App({ children }: { children: ReactNode }) {
  // Back returns the reader to where they were. A client-side router owns its own
  // navigation, so what it does not do here, nobody does.
  useScrollRestoration();

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
