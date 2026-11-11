import { Injectable, signal } from '@angular/core';

export interface ActionTaken {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  actions?: ActionTaken[];
  error?: boolean;
  /** Who answered: HomeHub's own rules, or the AI model, and how long it took. */
  by?: 'rules' | 'model';
  model?: string;
  seconds?: number;
}

const KEY = 'homehub.chat';
/** Enough to scroll back through; the model is only ever sent the last 10. */
const MAX_ENTRIES = 200;

/**
 * The conversation in Chat, kept while the browser tab is open: going to
 * another page and back, or reloading, doesn't lose it. Closing the tab, or
 * signing out, does. It's stored per person, so someone signing in after
 * you on the same tab never sees yours.
 */
@Injectable({ providedIn: 'root' })
export class ChatHistory {
  private readonly _entries = signal<ChatEntry[]>([]);
  readonly entries = this._entries.asReadonly();
  private userId: number | null = null;

  /** Load this person's conversation, if this tab has one. */
  open(userId: number): void {
    if (this.userId === userId) return;
    this.userId = userId;
    let entries: ChatEntry[] = [];
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
      if (saved?.userId === userId && Array.isArray(saved.entries)) entries = saved.entries;
    } catch { /* storage blocked or unreadable: start empty */ }
    this._entries.set(entries);
  }

  add(entry: ChatEntry): void {
    this._entries.update((list) => [...list, entry].slice(-MAX_ENTRIES));
    this.save();
  }

  /** "New chat". */
  clear(): void {
    this._entries.set([]);
    try { sessionStorage.removeItem(KEY); } catch { /* nothing to remove */ }
  }

  /** Signing out: nothing of this conversation stays behind. */
  forget(): void {
    this.clear();
    this.userId = null;
  }

  private save(): void {
    if (this.userId === null) return;
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ userId: this.userId, entries: this._entries() }));
    } catch { /* full or blocked: still kept in memory */ }
  }
}
