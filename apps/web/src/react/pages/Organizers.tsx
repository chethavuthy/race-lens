/**
 * The guest list. Operator only.
 *
 * Who may publish an album, and what each of them has published. The two ways a
 * person leaves are deliberately different acts, and the screen keeps them apart:
 *
 *   Remove  — a row typed in error. Refused once they own events, because the
 *             row is the only record that those albums have an owner.
 *   Ban     — withdraw access from someone who has published. Their events can
 *             come down with them, or stay up; that is a separate decision and
 *             so it is a separate checkbox rather than an assumption.
 *
 * A ban is reversible and says so. Nothing here deletes a photo.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, UserPlus } from 'lucide-react';
import { api, type Organizer } from '@/lib/api';
import { plural } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function Organizers() {
  const [rows, setRows] = useState<Organizer[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmBan, setConfirmBan] = useState<string | null>(null);
  const [unpublish, setUnpublish] = useState(false);

  const load = () => api.admin.organizers()
    .then((r) => { setRows(r.organizers); setError(null); })
    .catch((e: Error) => setError(e.message))
    .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key); setError(null);
    try { await fn(); setNotice(ok); await load(); }
    catch (e) { setNotice(null); setError((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <div className="pb-16">
      <Link to="/admin" className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Back to albums
      </Link>

      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Who can publish</h1>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
          Anyone on this list can sign in and publish an album. Everyone else is
          turned away at the door.
        </p>
      </header>

      {notice && <p className="mb-6 rounded-md border border-primary/40 px-4 py-3 text-sm text-primary">{notice}</p>}
      {error && <p className="mb-6 rounded-md border border-destructive/45 px-4 py-3 text-sm text-destructive">{error}</p>}

      <div className="mb-8 flex flex-wrap gap-3">
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && email.trim()) run('add', () => api.admin.addOrganizer(email.trim()), `${email.trim()} can publish now.`).then(() => setEmail('')); }}
          placeholder="photographer@example.com"
          type="email"
          className="min-w-[16rem] flex-1"
        />
        <Button
          disabled={busy === 'add' || !email.trim()}
          onClick={() => run('add', () => api.admin.addOrganizer(email.trim()), `${email.trim()} can publish now.`).then(() => setEmail(''))}
        >
          {busy === 'add' ? <Loader2 className="animate-spin" /> : <UserPlus />} Add
        </Button>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 py-10 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading</p>
      ) : !rows.length ? (
        <p className="rounded-xl border border-border p-8 text-center text-sm text-muted-foreground">
          Nobody yet. Add a photographer's email above and they can sign in.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {rows.map((o) => (
            <li key={o.email} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {o.email}
                    {o.banned_at && <span className="ml-2 text-sm text-destructive">no longer has access</span>}
                  </p>
                  <p className="tabular mt-0.5 text-xs text-muted-foreground">
                    {plural(o.events, 'event')} · {plural(o.published, 'published')} · {plural(o.photos, 'photo')}
                    {o.last_event && ` · last ${o.last_event}`}
                  </p>
                </div>

                {o.banned_at ? (
                  <Button variant="outline" size="sm" disabled={busy === o.email}
                          onClick={() => run(o.email, () => api.admin.unban(o.email), `${o.email} can publish again.`)}>
                    Restore access
                  </Button>
                ) : o.events === 0 ? (
                  // Nothing published, so the row is all there is to remove.
                  <Button variant="ghost" size="sm" disabled={busy === o.email}
                          onClick={() => run(o.email, () => api.admin.removeOrganizer(o.email), `${o.email} removed.`)}>
                    Remove
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" disabled={busy === o.email}
                          onClick={() => { setConfirmBan(o.email); setUnpublish(false); }}>
                    Withdraw access
                  </Button>
                )}
              </div>

              {confirmBan === o.email && (
                <div className="mt-4 rounded-lg border border-border p-4">
                  <p className="text-sm">
                    {o.email} keeps their {plural(o.events, 'album')} online unless you say
                    otherwise. Access can be restored at any time; nothing is deleted.
                  </p>
                  <label className="mt-3 flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={unpublish} onChange={(e) => setUnpublish(e.target.checked)} />
                    Also take their albums off the site
                  </label>
                  <div className="mt-4 flex gap-3">
                    <Button
                      variant="destructive" size="sm" disabled={busy === o.email}
                      onClick={() => { setConfirmBan(null);
                        run(o.email, () => api.admin.ban(o.email, { unpublish }),
                          `${o.email} can no longer publish.`); }}
                    >
                      {busy === o.email ? <Loader2 className="animate-spin" /> : null} Withdraw access
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmBan(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
