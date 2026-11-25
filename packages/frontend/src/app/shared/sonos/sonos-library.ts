import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

/** A Sonos Favorite or Sonos playlist, to start on a speaker. */
export interface SonosChoice {
  id: string;
  title: string;
  /** What the Sonos app shows under it: the service, or an artist. */
  note: string | null;
  kind: 'favorite' | 'playlist';
  art: string | null;
}

export interface SonosLibrary {
  favorites: SonosChoice[];
  playlists: SonosChoice[];
  /** Favorites that only open a list in the Sonos app, so aren't offered. */
  shortcuts: number;
}

/** What a schedule or scene starts: a favorite or Sonos playlist, kept by id and name. */
export interface PlayChoice { id: string; title: string }

/** The household's favorites and playlists, read through one of its speakers. */
export function loadSonosLibrary(http: HttpClient, deviceId: number): Observable<SonosLibrary> {
  return http.get<SonosLibrary>(`/api/sonos/${deviceId}/library`);
}

/** Every choice, favorites first. */
export const allChoices = (lib: SonosLibrary | null): SonosChoice[] => (lib ? [...lib.favorites, ...lib.playlists] : []);
