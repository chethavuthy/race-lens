/**
 * One photo, full size, without leaving the page.
 *
 * Tapping a tile used to open the original in a new tab. On a phone that means
 * leaving the album, losing the reader's place in a 1,070-photo wall, and landing
 * on a raw Drive URL — for the action a runner performs most once they have found
 * themselves. The original is still one tap away from here.
 *
 * MOTION, deliberately sparse:
 *   Opening is occasional, so it animates — 200ms, ease-out with a real curve,
 *   scaling from 0.96 rather than 0. Nothing in the world appears from nothing.
 *   Closing is faster than opening: the reader has already decided.
 *   STEPPING DOES NOT ANIMATE. Arrow keys are pressed repeatedly, and animation on
 *   a repeated action makes an interface feel slow and disconnected from the hand.
 *   Reduced motion keeps the fade and drops the movement.
 *
 * Only transform and opacity are animated, so none of it touches layout or paint.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import { clockTime } from '@/lib/format';
import type { Photo } from '@/lib/api';

export function Lightbox({
  photos, index, onClose, onIndex,
}: {
  photos: Photo[];
  index: number | null;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  const open = index !== null;
  const [shown, setShown] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const step = useCallback((by: number) => {
    if (index === null) return;
    const next = index + by;
    if (next >= 0 && next < photos.length) onIndex(next);
  }, [index, photos.length, onIndex]);

  // Mounted-then-shown, so the browser has a frame to paint the closed state
  // before the transition to open begins.
  useEffect(() => {
    if (!open) { setShown(false); return; }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Focus moves into the dialog so Escape and the arrows reach it, and so a
    // keyboard reader is not left behind on the wall.
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, step]);

  // Lock both, because which one scrolls depends on the page's height rules.
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const prev = { h: html.style.overflow, b: document.body.style.overflow, p: document.body.style.paddingRight };
    const gap = window.innerWidth - html.clientWidth;
    html.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
    return () => {
      html.style.overflow = prev.h;
      document.body.style.overflow = prev.b;
      document.body.style.paddingRight = prev.p;
    };
  }, [open]);

  if (index === null) return null;
  const photo = photos[index];
  if (!photo) return null;
  const time = clockTime(photo.taken_at);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Photo ${index + 1} of ${photos.length}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        transition: `opacity ${shown ? 'var(--dur-enter)' : 'var(--dur-exit)'} var(--ease-out-strong)`,
        opacity: shown ? 1 : 0,
      }}
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
    >
      {/* Close left, counter centred, original right — the arrangement a photo
          viewer has had since Lightroom, so nobody has to learn it. */}
      <div className="flex items-center justify-between gap-4 px-3 py-3 sm:px-5">
        <button
          ref={closeRef}
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-white/80
                     hover:text-white focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
        >
          <X className="size-4" /> Close
        </button>
        <span className="tabular text-sm text-white/60">
          {index + 1} / {photos.length}
        </span>
        <a
          href={photo.original_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-white/80
                     hover:text-white focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="hidden sm:inline">Full size</span> <ExternalLink className="size-4" />
        </a>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-2">
        {/* No transition on the frame itself: stepping is a repeated action and
            animating it would put a delay between the key and the picture. */}
        <img
          key={photo.id}
          src={photo.thumb_url ?? photo.original_url}
          alt=""
          style={{
            transform: shown ? 'scale(1)' : 'scale(0.96)',
            transition: `transform var(--dur-enter) var(--ease-out-strong)`,
          }}
          className="max-h-full max-w-full rounded-md object-contain"
        />

        {index > 0 && (
          <button
            onClick={() => step(-1)}
            aria-label="Previous photo"
            className="absolute left-1 grid size-11 place-items-center rounded-full bg-black/50
                       text-white/80 backdrop-blur hover:text-white focus-visible:ring-3
                       focus-visible:ring-ring focus-visible:outline-none sm:left-4"
          >
            <ChevronLeft className="size-5" />
          </button>
        )}
        {index < photos.length - 1 && (
          <button
            onClick={() => step(1)}
            aria-label="Next photo"
            className="absolute right-1 grid size-11 place-items-center rounded-full bg-black/50
                       text-white/80 backdrop-blur hover:text-white focus-visible:ring-3
                       focus-visible:ring-ring focus-visible:outline-none sm:right-4"
          >
            <ChevronRight className="size-5" />
          </button>
        )}
      </div>

      {time && (
        <p className="tabular pb-4 text-center text-xs text-white/50">Shot at {time}</p>
      )}
    </div>
  );
}
