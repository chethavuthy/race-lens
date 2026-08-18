/**
 * What someone sees when they are not through the door.
 *
 * /admin is public on purpose, so a photographer who has never heard of this can
 * read what it does and ask to be let in. The gated states are told apart because
 * the way out differs for each — three different people read this box:
 *
 *   anonymous — never signed in. Needs the door.
 *   unlisted  — signed in as an account this service does not know, usually a
 *               second Google account the browser picked. From the outside that
 *               looks like a flat refusal rather than a wrong key, so it says so.
 *   removed   — access was withdrawn. Not offered a sign-out that would change
 *               nothing.
 */
import { Button } from '@/components/ui/button';

export type Gate = 'anonymous' | 'unlisted' | 'removed';

const TELEGRAM = 'https://t.me/chethavuthy';

export function Invitation({ gate }: { gate: Gate }) {
  const logout = `/cdn-cgi/access/logout?returnTo=${encodeURIComponent(`${location.origin}/admin`)}`;
  return (
    <div className="max-w-2xl pb-16">
      <h1 className="text-2xl font-bold tracking-tight">Put your race album on Race Lens</h1>
      <p className="mt-2 text-muted-foreground">
        Runners find themselves by their bib number or by their own face, in about
        ten seconds. It is free, and there is nothing for them to sign up for.
      </p>

      <div className="mt-6 space-y-3 rounded-xl border border-border p-5">
        <p className="text-sm">Send me a message with:</p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>A <strong className="text-foreground">public Drive link</strong> to the album.</li>
          <li>The <strong className="text-foreground">race name and date</strong>.</li>
          <li>Whether runners wore <strong className="text-foreground">bib numbers</strong>.</li>
          <li>The <strong className="text-foreground">name to credit</strong> — yours, your studio's, or the club's.</li>
        </ul>
        <p className="text-sm text-muted-foreground">
          I'll index the album and send you the link once it's live.
        </p>
        {/* The address asked for is the one they will SIGN IN with, which is not
            necessarily the account that owns the Drive folder: the folder is read
            through a public link and an API key, so Race Lens never touches their
            Drive account at all. */}
        <p className="text-sm text-muted-foreground">
          <strong className="text-foreground">Would rather do it yourself?</strong> Organizers
          and photographers can have their own sign-in and publish albums without me.
          Tell me the email address you want to sign in with and I'll set it up. Also free.
        </p>
      </div>

      <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
        <li><strong className="text-foreground">Your photos stay yours.</strong> Race Lens shows a small preview and links to your album — every full-size photo still opens from your Drive.</li>
        <li><strong className="text-foreground">Your name is on it.</strong> Every page that shows your work credits you, with a link to your album.</li>
        <li><strong className="text-foreground">Leave any time.</strong> One message and the album comes off the site, along with everything indexed from it.</li>
      </ul>

      <div className="mt-6">
        <Button size="lg" render={<a href={TELEGRAM} target="_blank" rel="noopener" />}>
          Message @chethavuthy
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">
          Opens Telegram. Message me from your own account so I know it's you.
        </p>
      </div>

      <p className="mt-8 border-t border-border pt-5 text-sm text-muted-foreground">
        {gate === 'unlisted' ? (
          <>You're signed in as an account that hasn't been added yet.{' '}
            <a href={logout} className="text-primary underline underline-offset-4">Sign out</a>{' '}
            to try a different one.</>
        ) : gate === 'removed' ? (
          <>This account's access was removed. Message me above if that's a mistake.</>
        ) : (
          <>Already added?{' '}
            <a href="/admin/signin" className="text-primary underline underline-offset-4">Sign in</a>.</>
        )}
      </p>
    </div>
  );
}
