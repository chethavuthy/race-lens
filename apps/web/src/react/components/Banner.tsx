/**
 * An event banner, wherever one appears.
 *
 * These are POSTERS — the race name, the date, the start time, the sponsors — so
 * cropping one is the one thing we cannot do to it. The picture is contained and
 * the letterbox is filled with a blurred, overscanned copy of itself, so the gap
 * reads as an extension of the artwork rather than a hole, and the frame keeps its
 * 16:9 footprint either way.
 *
 * One component for the public list and the organizer's own list, so an operator
 * checking their upload sees exactly what a runner will see. They used to differ:
 * the admin thumbnails cropped, which is how a square 2048x2048 poster showed up
 * there as a 16:9 slice of its middle.
 */
export function Banner({ url, className = '' }: { url: string | null; className?: string }) {
  return (
    <div className={`relative block aspect-video w-full overflow-hidden bg-muted ${className}`}>
      {url && (
        <>
          <img
            src={url} alt="" aria-hidden loading="lazy"
            className="absolute inset-0 size-full scale-120 object-cover blur-2xl brightness-50 saturate-150"
          />
          <img
            src={url} alt="" loading="lazy"
            className="absolute inset-0 size-full object-contain"
          />
        </>
      )}
    </div>
  );
}
