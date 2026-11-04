import { MemoryStorageDriver, toJson, fromJson, type SupportedStorageTypes } from '@matter/main';
import { getDb } from '../db';

/**
 * Where matter.js keeps HomeHub's Matter identity (its certificates and keys)
 * and what it knows about each paired device: the matter_storage table, so a
 * backup carries it and a restore brings every pairing back.
 *
 * matter.js works from memory; each change is written through to SQLite, and
 * the table is read back in when storage opens.
 */
export class SqliteStorageDriver extends MemoryStorageDriver {
  static override readonly id = 'homehub-sqlite';

  constructor(private readonly namespace: string) {
    super();
  }

  override initialize(): void {
    super.initialize();
    const rows = getDb().prepare('SELECT context, key, value FROM matter_storage WHERE namespace = ?')
      .all(this.namespace) as { context: string; key: string; value: string }[];
    for (const r of rows) {
      super.set(r.context ? r.context.split('.') : [], r.key, fromJson(r.value));
    }
  }

  override set(contexts: string[], keyOrValues: string | Record<string, SupportedStorageTypes>, value?: SupportedStorageTypes): void {
    super.set(contexts, keyOrValues, value);
    const db = getDb();
    const context = contexts.join('.');
    const put = db.prepare(`
      INSERT INTO matter_storage (namespace, context, key, value) VALUES (?, ?, ?, ?)
      ON CONFLICT (namespace, context, key) DO UPDATE SET value = excluded.value
    `);
    const entries = typeof keyOrValues === 'string' ? [[keyOrValues, value] as const] : Object.entries(keyOrValues);
    db.transaction(() => {
      for (const [k, v] of entries) put.run(this.namespace, context, k, toJson(v as SupportedStorageTypes));
    })();
  }

  override delete(contexts: string[], key: string): void {
    super.delete(contexts, key);
    getDb().prepare('DELETE FROM matter_storage WHERE namespace = ? AND context = ? AND key = ?')
      .run(this.namespace, contexts.join('.'), key);
  }

  override clearAll(contexts: string[]): void {
    super.clearAll(contexts);
    const context = contexts.join('.');
    if (!context) {
      getDb().prepare('DELETE FROM matter_storage WHERE namespace = ?').run(this.namespace);
      return;
    }
    getDb().prepare('DELETE FROM matter_storage WHERE namespace = ? AND (context = ? OR context LIKE ?)')
      .run(this.namespace, context, `${context}.%`);
  }
}
