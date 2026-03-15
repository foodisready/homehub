import { Injectable, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap, map } from 'rxjs';
import { type AuthUser } from '../../shared/models/user.model';

const API = '/api';

interface LoginResponse {
  accessToken: string;
  user: AuthUser;
}

interface RefreshResponse {
  accessToken: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly _token = signal<string | null>(null);
  private readonly _user  = signal<AuthUser | null>(null);

  readonly accessToken = this._token.asReadonly();
  readonly user        = this._user.asReadonly();
  readonly isLoggedIn  = computed(() => this._user() !== null);

  constructor(private http: HttpClient) {}

  login(username: string, password: string): Observable<AuthUser> {
    return this.http.post<LoginResponse>(`${API}/auth/login`, { username, password }).pipe(
      tap((res) => {
        this._token.set(res.accessToken);
        this._user.set(res.user);
      }),
      map((res) => res.user),
    );
  }

  logout(): void {
    this.http.post(`${API}/auth/logout`, {}).subscribe();
    this._token.set(null);
    this._user.set(null);
  }

  refresh(): Observable<string> {
    return this.http.post<RefreshResponse>(`${API}/auth/refresh`, {}, { withCredentials: true }).pipe(
      tap((res) => this._token.set(res.accessToken)),
      map((res) => res.accessToken),
    );
  }

  /** Clear local state without calling the server (used on unrecoverable 401). */
  clear(): void {
    this._token.set(null);
    this._user.set(null);
  }
}
