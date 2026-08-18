/**
 * The door, for people who already have a key.
 *
 * The sign-in mechanism IS Cloudflare Access. /admin is public so a photographer
 * can read the invitation, which means opening it does not trigger a login — but
 * this path is covered by the Access application, so a real page load to it forces
 * one. By the time this renders, the cookie should be set.
 *
 * "Should", so it is checked rather than assumed. Bouncing straight back to /admin
 * meant that when the login had NOT taken, the reader was returned to the same
 * invitation with no explanation, having clicked Sign in and watched nothing
 * happen. A turnstile that silently returns you to where you started is
 * indistinguishable from a broken link.
 *
 * replace, not push: leaving this in the history would send Back through it again.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useDeferredLoading } from '../useDeferredLoading';
import { Button } from '@/components/ui/button';

export default function AdminSignin() {
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(true);
  // A turnstile deliberately keeps a spinner rather than a content skeleton: this
  // is an action in progress, not a page filling in, and a grey rectangle standing
  // in for "signing you in" would be describing content that never arrives — the
  // page either redirects or explains itself. What it does share with the rest of
  // the app is the rule from the trace: nothing at all for a fast check, so the
  // usual instant redirect flashes no message on its way through.
  const showWaiting = useDeferredLoading(checking);

  useEffect(() => {
    let live = true;
    api.admin.me()
      .then(() => { if (live) navigate('/admin', { replace: true }); })
      .catch(() => { if (live) setFailed(true); })
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [navigate]);

  if (!failed) {
    if (!showWaiting) return <div className="min-h-screen" />;
    return (
      <p className="mt-7 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Signing you in…
      </p>
    );
  }

  return (
    <div className="max-w-lg py-10">
      <h1 className="text-2xl font-bold tracking-tight">That did not sign you in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The login did not leave a session this site can use. Two things cause it:
      </p>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
        <li>
          You are on a hostname the sign-in does not cover. It works on{' '}
          <strong className="text-foreground">race-lens.runlytics.fit</strong> and{' '}
          <strong className="text-foreground">racelens.runlytics.fit</strong> — not on a
          preview domain, and not on a local dev server, which has no sign-in in front
          of it at all.
        </li>
        <li>
          Your browser signed you in as a different Google account than the one that
          was added.
        </li>
      </ul>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button render={<a href="/admin/signin" />}>Try again</Button>
        <Button variant="outline" render={<Link to="/admin" />}>Back to the invitation</Button>
      </div>
    </div>
  );
}
