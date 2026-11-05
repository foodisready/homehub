/**
 * Sharing snapshots through the phone's own share sheet (Messages, email,
 * Photos and so on), or saving them where it can't share.
 *
 * Browsers share files only on a secure (https) address and only straight
 * from a tap, so the pictures are loaded before the tap: when one is opened
 * or selected, not when Share is pressed.
 */

/** A phone's share sheet copes with this many pictures at once. */
export const MAX_SHARE = 20;

/** Whether this browser, at this address, can share picture files. */
export function canShareFiles(): boolean {
  try {
    if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
    return navigator.canShare({ files: [new File([new Uint8Array([0xff, 0xd8])], 'test.jpg', { type: 'image/jpeg' })] });
  } catch {
    return false;
  }
}

/** "Kitchen-Island-2026-11-05-0831.jpg": the camera and when, in the home's time. */
export function snapshotFileName(cameraName: string, takenAt: string): string {
  const d = new Date(takenAt);
  const two = (n: number) => String(n).padStart(2, '0');
  const when = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  const name = cameraName.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'Snapshot';
  return `${name}-${when}.jpg`;
}

export type ShareResult = 'shared' | 'cancelled' | 'saved';

/** Shares the files, or saves them when this browser can't share. Call it straight from a tap. */
export async function shareOrSave(files: File[], title: string): Promise<ShareResult> {
  if (canShareFiles() && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, title });
      return 'shared';
    } catch (err) {
      // Closing the share sheet isn't a failure.
      if ((err as DOMException)?.name === 'AbortError') return 'cancelled';
      throw err;
    }
  }
  await saveFiles(files);
  return 'saved';
}

/** Downloads each file. Browsers may ask once before saving several. */
export async function saveFiles(files: File[]): Promise<void> {
  for (const [i, file] of files.entries()) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    // Browsers drop downloads started all at once.
    if (i < files.length - 1) await new Promise((r) => setTimeout(r, 250));
  }
}
