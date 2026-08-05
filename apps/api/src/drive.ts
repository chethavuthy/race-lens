import { HttpError } from './lib';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  imageMediaMetadata?: { time?: string; width?: number; height?: number };
  shortcutDetails?: { targetId: string; targetMimeType: string };
}

/**
 * Pull a folder id out of whatever the organizer pasted.
 * Rejects Google Photos explicitly — it is a different product, the Drive API
 * key cannot read it, and organizers paste those links constantly.
 */
export function parseFolderId(url: string): string {
  const u = url.trim();
  if (/photos\.google\.com|photos\.app\.goo\.gl/i.test(u)) {
    throw new HttpError(
      400,
      'That is a Google Photos link. Google Photos albums cannot be read by this tool — please re-share the photos from Google Drive instead.',
      'google_photos',
    );
  }
  const byPath = u.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (byPath) return byPath[1];
  const byQuery = u.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (byQuery) return byQuery[1];
  // A bare id pasted on its own.
  if (/^[a-zA-Z0-9_-]{20,}$/.test(u)) return u;
  throw new HttpError(
    400,
    'Could not find a Drive folder id in that link. Paste the folder URL, which looks like https://drive.google.com/drive/folders/…',
    'bad_url',
  );
}

export const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);

async function listPage(
  apiKey: string,
  folderId: string,
  pageToken?: string,
): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed=false`,
    fields:
      'nextPageToken,files(id,name,mimeType,size,imageMediaMetadata/time,imageMediaMetadata/width,imageMediaMetadata/height,shortcutDetails)',
    pageSize: '1000',
    // Without BOTH of these a Shared Drive returns an empty list, which is
    // indistinguishable from an empty folder. This is the #1 support issue.
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    key: apiKey,
  });
  if (pageToken) params.set('pageToken', pageToken);

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
  if (res.status === 404) {
    throw new HttpError(404, 'That folder is not shared publicly. Ask the photographer to set it to "Anyone with the link — Viewer".', 'not_shared');
  }
  if (res.status === 403) {
    const body = await res.text();
    if (/downloadQuotaExceeded/.test(body)) {
      throw new HttpError(429, 'Google is rate-limiting this folder right now. Try again in a few minutes.', 'quota');
    }
    throw new HttpError(403, 'Drive denied access to that folder. It is likely restricted rather than link-shared.', 'forbidden');
  }
  if (!res.ok) {
    throw new HttpError(502, `Drive API error ${res.status}`, 'drive_error');
  }
  return res.json();
}

export interface WalkResult {
  images: DriveFile[];
  subfolders: string[];
  truncated: boolean;
}

/**
 * Recursive listing. Race albums are almost always split by photographer or
 * time block, so a non-recursive count is wrong more often than it is right.
 */
export async function walkFolder(
  apiKey: string,
  folderId: string,
  opts: { maxImages?: number; maxFolders?: number } = {},
): Promise<WalkResult> {
  const maxImages = opts.maxImages ?? 50_000;
  const maxFolders = opts.maxFolders ?? 500;

  const images: DriveFile[] = [];
  const subfolders: string[] = [];
  const seen = new Set<string>([folderId]);
  const queue: string[] = [folderId];
  let truncated = false;

  while (queue.length) {
    if (seen.size > maxFolders || images.length >= maxImages) {
      truncated = true;
      break;
    }
    const current = queue.shift()!;
    let pageToken: string | undefined;
    do {
      const page = await listPage(apiKey, current, pageToken);
      for (const f of page.files ?? []) {
        let file = f;
        // Resolve shortcuts to their target before classifying.
        if (file.mimeType === SHORTCUT_MIME && file.shortcutDetails) {
          file = {
            ...file,
            id: file.shortcutDetails.targetId,
            mimeType: file.shortcutDetails.targetMimeType,
          };
        }
        if (file.mimeType === FOLDER_MIME) {
          if (!seen.has(file.id)) {
            seen.add(file.id);
            subfolders.push(file.name);
            queue.push(file.id);
          }
        } else if (IMAGE_MIMES.has(file.mimeType)) {
          images.push(file);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken && images.length < maxImages);
  }

  return { images, subfolders, truncated };
}

/**
 * Sample thumbnail for the admin preview. Deliberately NOT the API-key media
 * endpoint — that URL would ship our Drive key to the browser. This host serves
 * link-shared files without any key.
 */
export function sampleThumbUrl(fileId: string, size = 400): string {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${size}`;
}
