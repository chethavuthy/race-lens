/**
 * The one back control. Renders as a link so it can be opened in a new tab and
 * shows a real href in the status bar, but a plain click goes BACK — see useBack.
 */
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useBack } from '../scroll';

export function BackLink({ to, children }: { to: string; children: React.ReactNode }) {
  const back = useBack(to);
  return (
    <Link
      to={to}
      onClick={(e) => {
        // Let the browser handle the ways a reader asks for a new tab or window.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        back();
      }}
      className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" /> {children}
    </Link>
  );
}
