/**
 * The organizer's front door.
 *
 * One job, in the order it actually happens: point at a Drive folder, say where
 * the photos belong, start indexing. Everything else on this page is the list of
 * albums already published.
 *
 * The folder check comes first and is not optional. A restricted folder is the
 * single most common failure, and finding out after an event has been created
 * leaves a draft nobody wants. Checking first means the only way to reach the
 * form is with a folder that is known to be readable.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderSearch, Loader2, Plus } from 'lucide-react';
import { api, type EventSummary } from '@/lib/api';
import { plural } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Inspected = Awaited<ReturnType<typeof api.admin.inspect>>;

export default function Admin() {
  const [owner, setOwner] = useState(false);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [url, setUrl] = useState('');
  const [checking, setChecking] = useState(false);
  const [folder, setFolder] = useState<Inspected | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Where the photos go.
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [bibsOn, setBibsOn] = useState(true);
  const [size, setSize] = useState<'original' | 'thumb' | null>(null);
  const [starting, setStarting] = useState(false);

  // Bib format, asked here because it decides what the FIRST pass reads. Getting
  // it wrong means indexing the whole album, storing the wrong numbers, and then
  // downloading every photo a second time to fix it.
  const [showFormat, setShowFormat] = useState(false);
  const [minDigits, setMinDigits] = useState(3);
  const [maxDigits, setMaxDigits] = useState(5);
  const [prefixes, setPrefixes] = useState('');

  const refresh = () => api.admin.listEvents().then((r) => setEvents(r.events)).catch(() => {});
  useEffect(() => {
    api.admin.me().then((m) => setOwner(m.owner)).catch(() => {});
    refresh();
  }, []);

  async function check() {
    setChecking(true); setError(null); setFolder(null);
    try { setFolder(await api.admin.inspect(url.trim())); }
    catch (e) { setError((e as Error).message); }
    finally { setChecking(false); }
  }

  async function start() {
    setStarting(true); setError(null);
    try {
      let eventId = target;
      if (mode === 'new') {
        const created = await api.admin.createEvent({
          name: name.trim(),
          event_date: date || undefined,
          bibs_enabled: bibsOn,
          ...(bibsOn ? {
            bib_min_digits: minDigits,
            bib_max_digits: maxDigits,
            bib_prefixes: prefixes.trim(),
          } : {}),
        });
        eventId = created.event.id;
      }
      await api.admin.ingest(eventId, url.trim(), size ?? undefined);
      setNotice('Indexing started. It runs in rounds and carries on by itself.');
      setUrl(''); setFolder(null); setName(''); setSize(null);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setStarting(false); }
  }

  const canStart = !!folder
    && (mode === 'new' ? name.trim().length > 0 : target.length > 0)
    && (!owner || size !== null);

  return (
    <div className="pb-16">
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Publish an album</h1>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
          Point at a public Google Drive folder. Every photo is indexed for face
          and bib search; the originals stay in your Drive and are never copied.
        </p>
      </header>

      {notice && <p className="mb-6 rounded-md border border-primary/40 px-4 py-3 text-sm text-primary">{notice}</p>}
      {error && <p className="mb-6 rounded-md border border-destructive/45 px-4 py-3 text-sm text-destructive">{error}</p>}

      {/* Step 1 — the folder. */}
      <section className="mb-6 rounded-xl border border-border p-5">
        <h2 className="mb-4 font-[family-name:var(--font-display)] font-bold">
          <span className="tabular mr-2 text-primary">1</span> Check the folder
        </h2>
        <div className="flex flex-wrap gap-3">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && url.trim()) check(); }}
            placeholder="https://drive.google.com/drive/folders/…"
            className="min-w-[16rem] flex-1"
          />
          <Button onClick={check} disabled={checking || !url.trim()}>
            {checking ? <Loader2 className="animate-spin" /> : <FolderSearch />} Check
          </Button>
        </div>
        {folder && (
          <p className="tabular mt-4 text-sm">
            <span className="text-primary">{plural(folder.image_count, 'photo')}</span>
            {folder.subfolder_count > 0 && <> across {plural(folder.subfolder_count, 'subfolder')}</>}
            {folder.truncated && <span className="text-muted-foreground"> · more than we counted</span>}
          </p>
        )}
      </section>

      {/* Step 2 — only once the folder is known to be readable. */}
      {folder && (
        <section className="mb-10 rounded-xl border border-border p-5">
          <h2 className="mb-4 font-[family-name:var(--font-display)] font-bold">
            <span className="tabular mr-2 text-primary">2</span> Where do these photos go?
          </h2>

          <div className="mb-5 inline-flex rounded-lg border border-border p-1">
            {(['new', 'existing'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={`rounded-md px-4 py-1.5 text-sm ${mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
              >
                {m === 'new' ? 'A new event' : 'An event I already have'}
              </button>
            ))}
          </div>

          {mode === 'new' ? (
            <div className="space-y-4">
              <div>
                <Label htmlFor="ev-name">Event name</Label>
                <Input id="ev-name" value={name} onChange={(e) => setName(e.target.value)}
                       placeholder="Phnom Penh Half Marathon 2026" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="ev-date">Date</Label>
                <Input id="ev-date" type="date" value={date} onChange={(e) => setDate(e.target.value)}
                       className="mt-1.5 max-w-[14rem]" />
              </div>

              <div>
                <Label>Bib numbers</Label>
                <div className="mt-1.5 inline-flex rounded-lg border border-border p-1">
                  {[true, false].map((on) => (
                    <button key={String(on)} onClick={() => setBibsOn(on)} aria-pressed={bibsOn === on}
                            className={`rounded-md px-4 py-1.5 text-sm ${bibsOn === on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                      {on ? 'Runners wear bibs' : 'No bibs'}
                    </button>
                  ))}
                </div>
                {bibsOn && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Bibs here are{' '}
                    <strong className="tabular text-foreground">
                      {minDigits === maxDigits ? `exactly ${minDigits} digits` : `${minDigits} to ${maxDigits} digits`}
                      {prefixes.trim() ? `, some starting with ${prefixes.trim().toUpperCase()}` : ', no letters'}
                    </strong>.{' '}
                    <button onClick={() => setShowFormat(!showFormat)} className="text-primary underline underline-offset-4">
                      {showFormat ? 'Done' : 'Change'}
                    </button>
                  </p>
                )}
                {bibsOn && showFormat && (
                  <div className="mt-3 space-y-3 rounded-lg border border-border p-4">
                    <div className="flex flex-wrap items-end gap-3">
                      <div>
                        <Label htmlFor="mn">Shortest</Label>
                        <select id="mn" value={minDigits} onChange={(e) => setMinDigits(+e.target.value)}
                                className="mt-1.5 h-9 rounded-md border border-input bg-transparent px-2 text-sm">
                          {[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} digits</option>)}
                        </select>
                      </div>
                      <div>
                        <Label htmlFor="mx">Longest</Label>
                        <select id="mx" value={maxDigits} onChange={(e) => setMaxDigits(+e.target.value)}
                                className="mt-1.5 h-9 rounded-md border border-input bg-transparent px-2 text-sm">
                          {[2, 3, 4, 5].filter((n) => n >= minDigits).map((n) => <option key={n} value={n}>{n} digits</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="pfx">Category letters</Label>
                      <Input id="pfx" value={prefixes} onChange={(e) => setPrefixes(e.target.value)}
                             placeholder="none — e.g. F, M" className="mt-1.5 max-w-[16rem]" />
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        Only if this race numbers by category — 0001 for the marathon,
                        F-0001 and M-0001 for the 10k. Without them a bib with a letter
                        is read and then thrown away.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div>
              <Label htmlFor="ev-target">Event</Label>
              <select id="ev-target" value={target} onChange={(e) => setTarget(e.target.value)}
                      className="mt-1.5 h-9 w-full max-w-md rounded-md border border-input bg-transparent px-2 text-sm">
                <option value="">Choose an event…</option>
                {events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
          )}

          {owner && (
            <div className="mt-5">
              <Label>Download for indexing</Label>
              <div className="mt-1.5 inline-flex rounded-lg border border-border p-1">
                {([['original', 'Full originals'], ['thumb', 'Resized (faster)']] as const).map(([v, label]) => (
                  <button key={v} onClick={() => setSize(v)} aria-pressed={size === v}
                          className={`rounded-md px-4 py-1.5 text-sm ${size === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-2 max-w-lg text-xs text-muted-foreground">
                Resized moves about 600 photos a round against roughly 25 for
                originals, for the same faces and bibs. Pick one — it cannot be
                changed once indexing starts.
              </p>
            </div>
          )}

          <Button size="lg" className="mt-6" disabled={!canStart || starting} onClick={start}>
            {starting ? <Loader2 className="animate-spin" /> : <Plus />} Start indexing
          </Button>
        </section>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground">Your events</h2>
          {owner && (
            <Link to="/admin/organizers" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Who can publish
            </Link>
          )}
        </div>
        {!events.length ? (
          <p className="rounded-xl border border-border p-8 text-center text-sm text-muted-foreground">
            Nothing published yet. Check a folder above to make your first album.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <Link to={`/admin/e/${e.id}`} className="font-medium underline-offset-4 hover:underline">
                    {e.name}
                  </Link>
                  <p className="tabular mt-0.5 text-xs text-muted-foreground">
                    /e/{e.slug} · {e.status} · {plural(e.photo_count, 'photo')}
                    {e.face_count ? ` · ${plural(e.face_count, 'face')}` : ''}
                  </p>
                </div>
                <Button variant="outline" size="sm" render={<Link to={`/admin/e/${e.id}`} />}>Open</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
