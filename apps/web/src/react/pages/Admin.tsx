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
import { CalendarIcon, FolderSearch, Loader2, Plus } from 'lucide-react';
import { ApiError, api, type EventSummary } from '@/lib/api';
import { formatDate, plural } from '@/lib/format';
import { Invitation, type Gate } from '../components/Invitation';
import { AdminSkeleton, EventRowsSkeleton } from '../components/AdminSkeleton';
import { Banner } from '../components/Banner';
import { useDeferredLoading } from '../useDeferredLoading';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';

type Inspected = Awaited<ReturnType<typeof api.admin.inspect>>;

/**
 * A Date to the ISO day the API stores, in LOCAL terms.
 *
 * toISOString() would convert to UTC first, so a date picked in Phnom Penh
 * (UTC+7) becomes the previous day for any race before 07:00 — which is most of
 * them.
 */
function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function Admin() {
  const [owner, setOwner] = useState(false);
  /**
   * Nothing renders until we know whether this person is through the door.
   *
   * `gate` cannot be read from the URL — only the API knows — so assuming either
   * answer while asking shows the wrong one first. Assuming "not gated" put the
   * indexing tool in front of every stranger for a round trip; assuming the
   * opposite flashes the invitation at the operator. One honest line beats both.
   */
  const [checking, setChecking] = useState(true);
  const [gate, setGate] = useState<Gate | null>(null);
  // The events list settles after the access check, so it waits separately —
  // otherwise an empty list renders "Nothing published yet", which is a claim.
  const [eventsLoading, setEventsLoading] = useState(true);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [url, setUrl] = useState('');
  const [inspecting, setInspecting] = useState(false);
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

  const refresh = () => api.admin.listEvents()
    .then((r) => setEvents(r.events))
    .catch(() => {})
    .finally(() => setEventsLoading(false));

  /**
   * Several different failures all mean "not through the door", and none of them
   * deserves a red banner — but they are told apart, because the way out differs.
   *
   * The Worker's `code` decides it, NOT the 403 alone. It answers 403 for four
   * distinct reasons, and reading only the status once told the operator "this
   * account isn't on the list" while they were on the workers.dev origin, where
   * admin is refused by hostname and no list was ever consulted. A wrong
   * diagnosis sends someone hunting for the wrong fix.
   *
   * Someone with no Access cookie at all never reaches the Worker: Access 302s
   * the request to a cross-origin login page and fetch() reports only "Failed to
   * fetch", with no status to read. The public API separates that from a dead
   * connection — same origin, no gate, so if it answers, the gate was the problem.
   */
  async function accessDenial(e: unknown): Promise<Gate | null> {
    if (e instanceof ApiError) {
      if (e.status !== 403) return null;
      if (e.code === 'not_invited') return 'unlisted';
      if (e.code === 'banned') return 'removed';
      return 'anonymous';
    }
    try { await api.listEvents(); return 'anonymous'; } catch { return null; }
  }

  useEffect(() => {
    (async () => {
      try {
        const me = await api.admin.me();
        setOwner(me.owner);
        setGate(null);
        await refresh();
      } catch (e) {
        const denial = await accessDenial(e);
        if (denial) setGate(denial);
        else setError((e as Error).message);
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  const showSkeleton = useDeferredLoading(checking);

  async function check() {
    setInspecting(true); setError(null); setFolder(null);
    try { setFolder(await api.admin.inspect(url.trim())); }
    catch (e) { setError((e as Error).message); }
    finally { setInspecting(false); }
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

  // Nothing at all for a fast check, a placeholder only when it is genuinely
  // slow — the same rule the album follows, for the same measured reason.
  if (checking) return showSkeleton ? <AdminSkeleton /> : <div className="min-h-screen" />;
  if (gate) return <Invitation gate={gate} />;

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
          <Button onClick={check} disabled={inspecting || !url.trim()}>
            {inspecting ? <Loader2 className="animate-spin" /> : <FolderSearch />} Check
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
                {/* A picker rather than <input type="date">, whose rendering and
                    field order are the browser's and the OS locale's — dd/mm/yyyy
                    for some readers, mm/dd/yyyy for others, with no way to tell
                    which you are looking at. The value still travels as ISO. */}
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button id="ev-date" variant="outline"
                              className="mt-1.5 w-[14rem] justify-start font-normal">
                        <CalendarIcon />
                        {date ? formatDate(date) : <span className="text-muted-foreground">Pick the race day</span>}
                      </Button>
                    }
                  />
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      captionLayout="dropdown"
                      selected={date ? new Date(`${date}T00:00:00`) : undefined}
                      onSelect={(d) => setDate(d ? toISODate(d) : '')}
                      autoFocus
                    />
                  </PopoverContent>
                </Popover>
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
                        <Select value={String(minDigits)}
                                onValueChange={(v) => { const n = Number(v); setMinDigits(n); if (maxDigits < n) setMaxDigits(n); }}>
                          <SelectTrigger id="mn" className="mt-1.5 w-[9rem]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {[2, 3, 4, 5].map((n) => (
                              <SelectItem key={n} value={String(n)}>{n} digits</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label htmlFor="mx">Longest</Label>
                        <Select value={String(maxDigits)} onValueChange={(v) => setMaxDigits(Number(v))}>
                          <SelectTrigger id="mx" className="mt-1.5 w-[9rem]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {/* Only lengths at or above the floor: an inverted pair
                                matches no bib at all, and the API refuses it. */}
                            {[2, 3, 4, 5].filter((n) => n >= minDigits).map((n) => (
                              <SelectItem key={n} value={String(n)}>{n} digits</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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
              <Select value={target} onValueChange={(v) => setTarget(v ?? '')}>
                <SelectTrigger id="ev-target" className="mt-1.5 w-full max-w-md">
                  <SelectValue placeholder="Choose an event…" />
                </SelectTrigger>
                <SelectContent>
                  {events.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
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
        {eventsLoading ? (
          <EventRowsSkeleton />
        ) : !events.length ? (
          <p className="rounded-xl border border-border p-8 text-center text-sm text-muted-foreground">
            Nothing published yet. Check a folder above to make your first album.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                {/* Same treatment as the public list — an operator checking a
                    banner should see what a runner sees, not a cropped variant. */}
                <Link to={`/admin/e/${e.id}`} className="w-28 shrink-0">
                  <Banner url={e.banner_url} className="rounded-md" />
                </Link>
                <div className="min-w-0 flex-1">
                  <Link to={`/admin/e/${e.id}`} className="font-medium underline-offset-4 hover:underline">
                    {e.name}
                  </Link>
                  <p className="tabular mt-0.5 text-xs text-muted-foreground">
                    /e/{e.slug} · {e.status} · {plural(e.photo_count, 'photo')}
                    {e.face_count ? ` · ${plural(e.face_count, 'face')}` : ''}
                  </p>
                  {/* Who published it. Only the operator is sent owner_email at
                      all, and it is null on every event that predates ownership —
                      which are the operator's own, so those read as "you" rather
                      than as a blank the reader has to interpret. */}
                  {owner && (
                    <p className="mt-0.5 text-xs text-muted-foreground/70">
                      published by {e.owner_email ?? 'you'}
                    </p>
                  )}
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
