import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';

/** Where a room is on a floor's picture: x and y as a share (0–1) of its width and height. */
export interface FloorPin { room: string; x: number; y: number }
export interface Floor { id: number; name: string; updatedAt: string; pins: FloorPin[] }

/** The longest side a picture is shrunk to before it's sent: sharp on a tablet, a few hundred KB. */
const MAX_SIDE = 2000;

/**
 * The dashboard's floor map: a picture of each floor and where each room is on it.
 * See docs/FLOOR_MAP.md.
 */
@Injectable({ providedIn: 'root' })
export class FloorsService {
  private readonly http = inject(HttpClient);

  readonly floors = signal<Floor[]>([]);
  readonly loaded = signal(false);

  load(): void {
    this.http.get<Floor[]>('/api/floors').subscribe({
      next: (f) => { this.floors.set(f); this.loaded.set(true); },
      error: () => this.loaded.set(true),
    });
  }

  imageUrl(f: Floor): string { return `/api/floors/${f.id}/image?v=${encodeURIComponent(f.updatedAt)}`; }

  add(name: string, image: Blob): Observable<Floor> {
    const body = new FormData();
    body.append('name', name);
    body.append('image', image, 'floor.jpg');
    return this.http.post<Floor>('/api/floors', body).pipe(tap((f) => this.floors.update((all) => [...all, f])));
  }

  rename(id: number, name: string): Observable<Floor> {
    return this.http.put<Floor>(`/api/floors/${id}`, { name }).pipe(tap((f) => this.replace(f)));
  }

  replaceImage(id: number, image: Blob): Observable<Floor> {
    const body = new FormData();
    body.append('image', image, 'floor.jpg');
    return this.http.put<Floor>(`/api/floors/${id}/image`, body).pipe(tap((f) => this.replace(f)));
  }

  savePins(id: number, pins: FloorPin[]): Observable<Floor> {
    return this.http.put<Floor>(`/api/floors/${id}/pins`, { pins }).pipe(tap((f) => this.replace(f)));
  }

  remove(id: number): Observable<void> {
    return this.http.delete<void>(`/api/floors/${id}`).pipe(tap(() => this.floors.update((all) => all.filter((f) => f.id !== id))));
  }

  private replace(f: Floor): void {
    this.floors.update((all) => all.map((x) => (x.id === f.id ? f : x)));
  }
}

/**
 * A photo, screenshot or photographed sketch, made small enough to send: the longest side at most
 * 2,000 px, as a JPEG. The browser turns it the right way up and reads an iPhone's HEIC photo.
 */
export async function shrinkPicture(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot prepare the picture.');
  // A transparent screenshot or sketch gets a white page, not black, as a JPEG has no transparency.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be prepared.'))), 'image/jpeg', 0.85));
}
