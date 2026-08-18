/**
 * The door, for people who already have a key.
 *
 * /admin is public so photographers can read the invitation, which means opening
 * it no longer triggers a Cloudflare Access login — and a signed-out organizer
 * would otherwise land on the invitation with no way past it. This path IS
 * covered by the Access application, so simply arriving here forces the login; by
 * the time this renders, the cookie is set and /admin can load its own data.
 *
 * replace, not a push: this page is a turnstile, and leaving it in the history
 * would send Back straight through it again.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

export default function AdminSignin() {
  const navigate = useNavigate();
  useEffect(() => { navigate('/admin', { replace: true }); }, [navigate]);
  return (
    <p className="mt-7 flex items-center gap-2 text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Signing you in…
    </p>
  );
}
