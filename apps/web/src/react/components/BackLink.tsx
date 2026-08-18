/**
 * Back to somewhere named.
 *
 * A plain link, deliberately. It used to call history.back(), which is only
 * "back to the list" when the list happens to be exactly one entry behind — and
 * it often is not. Going to the path directly always arrives, in one click, and
 * the reader's place is restored by path (see ../scroll).
 */
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export function BackLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" /> {children}
    </Link>
  );
}
