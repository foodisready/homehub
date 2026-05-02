import { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { requireAdmin } from '../middleware/auth';
import { getDb } from '../db';
import { logger } from '../logger';

/**
 * Firmware release storage + serving.
 *
 * Two routers exported:
 *   - firmwareApiRouter   admin uploads / list / delete (mounted under /api/firmware)
 *   - firmwarePublicRouter device-facing fetch          (mounted under /firmware)
 *
 * The public router is intentionally unauthenticated — devices on the
 * trusted LAN pull the .bin via the URL HomeHub posted to their /ota
 * endpoint. Filenames are predictable (auraflow-<version>.bin), so this
 * is "secret URL" trust, not real auth. Same model as ingestion uses
 * INTERNAL_API_KEY for the inbound side; the outbound firmware fetch
 * matches what the existing internal trust posture allows.
 */

const FIRMWARE_DIR = path.join(process.cwd(), 'data', 'firmware');
const MAX_BIN_BYTES = 8 * 1024 * 1024;   // 8 MB — well above the ~1 MB current bin
const FILENAME_RE  = /^[a-zA-Z0-9_.-]+\.bin$/;
const VERSION_RE   = /^[a-zA-Z0-9._-]+$/;
const TARGET_RE    = /^[a-zA-Z0-9-]+$/;

interface FirmwareReleaseRow {
  id:          number;
  target:      string;
  version:     string;
  filename:    string;
  sha256:      string;
  size_bytes:  number;
  notes:       string | null;
  uploaded_by: number | null;
  uploaded_at: string;
}

function toPublic(row: FirmwareReleaseRow) {
  return {
    id:         row.id,
    target:     row.target,
    version:    row.version,
    filename:   row.filename,
    sha256:     row.sha256,
    sizeBytes:  row.size_bytes,
    notes:      row.notes,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
  };
}

function ensureFirmwareDir(): void {
  if (!fs.existsSync(FIRMWARE_DIR)) {
    fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
  }
}

const upload = multer({
  storage: multer.memoryStorage(),       // small files; sha256 + dedupe before disk write
  limits:  { fileSize: MAX_BIN_BYTES },
});

// ── Admin API ────────────────────────────────────────────────────

export const firmwareApiRouter = Router();

// authenticate middleware is applied globally to /api in index.ts

// GET /api/firmware?target=auraflow-mainline
firmwareApiRouter.get('/', (req: Request, res: Response) => {
  const target = strQuery(req.query.target);
  if (target !== undefined && !TARGET_RE.test(target)) {
    return res.status(400).json({ error: 'invalid target', code: 'VALIDATION_ERROR' });
  }
  const rows = (target
    ? getDb().prepare('SELECT * FROM firmware_releases WHERE target = ? ORDER BY uploaded_at DESC').all(target)
    : getDb().prepare('SELECT * FROM firmware_releases ORDER BY uploaded_at DESC').all()
  ) as FirmwareReleaseRow[];
  res.json(rows.map(toPublic));
});

// POST /api/firmware  multipart: file=<bin>, version=<str>, target=<str>, notes=<str?>
firmwareApiRouter.post('/', requireAdmin, upload.single('file'), (req: Request, res: Response) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'file is required (multipart field "file")', code: 'VALIDATION_ERROR' });

  const version = (req.body.version ?? '').toString().trim();
  const target  = (req.body.target  ?? 'auraflow-mainline').toString().trim();
  const notes   = req.body.notes ? String(req.body.notes).trim() : null;

  if (!VERSION_RE.test(version)) return res.status(400).json({ error: 'version: alphanumeric + . _ - only', code: 'VALIDATION_ERROR' });
  if (!TARGET_RE.test(target))   return res.status(400).json({ error: 'target: alphanumeric + - only',     code: 'VALIDATION_ERROR' });

  // ESP32 image magic byte is 0xE9 — cheap sanity check that catches
  // most "uploaded the wrong file" mistakes before they get written.
  if (file.buffer[0] !== 0xe9) {
    return res.status(400).json({ error: 'file does not look like an ESP32 image (magic 0xE9 missing)', code: 'NOT_ESP32_IMAGE' });
  }

  // Pre-check for the (target, version) conflict before touching disk —
  // otherwise a duplicate upload would overwrite the existing file before
  // the unique-constraint catch path even runs.
  const existing = getDb().prepare('SELECT id FROM firmware_releases WHERE target = ? AND version = ?')
    .get(target, version) as { id: number } | undefined;
  if (existing) {
    return res.status(409).json({ error: `${target} v${version} already exists`, code: 'CONFLICT' });
  }

  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const filename = `${target}-${version}.bin`;

  ensureFirmwareDir();
  const filepath = path.join(FIRMWARE_DIR, filename);
  fs.writeFileSync(filepath, file.buffer);

  try {
    const result = getDb().prepare(`
      INSERT INTO firmware_releases (target, version, filename, sha256, size_bytes, notes, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(target, version, filename, sha256, file.size, notes, req.user?.sub ?? null);
    const row = getDb().prepare('SELECT * FROM firmware_releases WHERE id = ?').get(result.lastInsertRowid) as FirmwareReleaseRow;
    logger.info({ id: row.id, target, version, sizeBytes: file.size }, 'Firmware release uploaded');
    return res.status(201).json(toPublic(row));
  } catch (err) {
    // Defensive: roll back the disk write if the insert still fails for
    // some other reason (concurrent insert, FK violation, etc.).
    fs.rmSync(filepath, { force: true });
    throw err;
  }
});

// DELETE /api/firmware/:id
firmwareApiRouter.delete('/:id', requireAdmin, (req: Request, res: Response) => {
  const row = getDb().prepare('SELECT * FROM firmware_releases WHERE id = ?').get(req.params.id) as FirmwareReleaseRow | undefined;
  if (!row) return res.status(404).json({ error: 'Release not found', code: 'NOT_FOUND' });

  getDb().prepare('DELETE FROM firmware_releases WHERE id = ?').run(req.params.id);
  fs.rmSync(path.join(FIRMWARE_DIR, row.filename), { force: true });
  logger.info({ id: row.id, filename: row.filename }, 'Firmware release deleted');
  res.status(204).end();
});

// ── Public device-facing fetch ───────────────────────────────────

export const firmwarePublicRouter = Router();

// GET /firmware/:filename — unauthenticated; LAN trust model.
firmwarePublicRouter.get('/:filename', (req: Request, res: Response) => {
  const filename = String(req.params.filename ?? '');
  if (!FILENAME_RE.test(filename)) {
    return res.status(400).json({ error: 'invalid filename', code: 'VALIDATION_ERROR' });
  }
  // Cross-check against the DB so we never serve a file that isn't a
  // tracked release (defense in depth against path-traversal-like attacks
  // even though FILENAME_RE already excludes / and ..).
  const row = getDb().prepare('SELECT * FROM firmware_releases WHERE filename = ?').get(filename) as FirmwareReleaseRow | undefined;
  if (!row) return res.status(404).json({ error: 'Release not found', code: 'NOT_FOUND' });

  const filepath = path.join(FIRMWARE_DIR, row.filename);
  if (!fs.existsSync(filepath)) {
    logger.error({ filename }, 'Release row exists but file is missing on disk');
    return res.status(500).json({ error: 'release file missing on disk', code: 'FILE_MISSING' });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(row.size_bytes));
  res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
  fs.createReadStream(filepath).pipe(res);
});

function strQuery(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}
