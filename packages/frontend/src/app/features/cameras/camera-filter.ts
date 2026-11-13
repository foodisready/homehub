/** The kinds of camera HomeHub has, as the Cameras page filters them. */
export type CameraBrand = 'wyze' | 'ring' | 'ip';
export type BrandChoice = CameraBrand | 'all';

export interface CameraFilter { search: string; brand: BrandChoice }

export const NO_FILTER: CameraFilter = { search: '', brand: 'all' };

export const BRANDS: CameraBrand[] = ['wyze', 'ring', 'ip'];
export const BRAND_LABEL: Record<CameraBrand, string> = { wyze: 'Wyze', ring: 'Ring', ip: 'IP cameras' };

/** Whether a brand's cameras, and its notes, show under the filter. */
export function brandShown(filter: CameraFilter, brand: CameraBrand): boolean {
  return filter.brand === 'all' || filter.brand === brand;
}

/**
 * Whether a camera shows: its brand is chosen, and every word typed is in its
 * name, room, model or brand ("front ring" finds the Ring front doorbell).
 */
export function cameraMatches(filter: CameraFilter, brand: CameraBrand, words: (string | null | undefined)[]): boolean {
  if (!brandShown(filter, brand)) return false;
  const wanted = filter.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!wanted.length) return true;
  const text = [...words, BRAND_LABEL[brand], brand].filter(Boolean).join(' ').toLowerCase();
  return wanted.every((w) => text.includes(w));
}
