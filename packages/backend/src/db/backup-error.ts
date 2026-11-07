/** A backup problem to show the user. `code` lets the page react, for example by asking for a passphrase. */
export class BackupError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'BACKUP_ERROR',
    /** More for the page, such as the passphrase hint when one is asked for. */
    readonly extra: Record<string, unknown> = {},
  ) { super(message); }
}
