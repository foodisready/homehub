import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { requireAdmin } from '../middleware/auth';
import { getDb } from '../db';

/**
 * The dashboard's map: a picture of each floor, and where each room is on it.
 * Everyone signed in can see them; admins change them. See docs/FLOOR_MAP.md.
 */

/** The phone shrinks a picture to a few hundred KB first; this leaves room for a PNG sketch. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_NAME = 40;
const MAX_PINS = 100;

interface FloorRow { id: number; name: string; position: number; mime: string; updated_at: string }
interface PinRow { floor_id: number; room: string; x: number; y: number }

/** What a picture is, from its first bytes rather than its name. */
export function imageType(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

/** The picture in field `image`, or a 400 saying what's wrong with it. */
function takeImage(req: Request, res: Response, next: NextFunction): void {
  upload.single('image')(req, res, (err: unknown) => {
    if (err) {
      const big = (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
      res.status(400).json({ error: big ? 'That picture is too large (4 MB at most).' : 'The picture could not be read.', code: 'BAD_IMAGE' });
      return;
    }
    const file = req.file;
    if (!file) { res.status(400).json({ error: 'Choose a picture.', code: 'BAD_IMAGE' }); return; }
    if (!imageType(file.buffer)) {
      res.status(400).json({ error: 'Use a JPEG, PNG or WebP picture.', code: 'BAD_IMAGE' });
      return;
    }
    next();
  });
}

function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim().replace(/\s+/g, ' ');
  return name && name.length <= MAX_NAME ? name : null;
}

function floorsWithPins() {
  const db = getDb();
  const floors = db.prepare('SELECT id, name, position, mime, updated_at FROM floor_maps ORDER BY position, id').all() as FloorRow[];
  const pins = db.prepare('SELECT floor_id, room, x, y FROM floor_pins ORDER BY room').all() as PinRow[];
  return floors.map((f) => ({
    id: f.id,
    name: f.name,
    updatedAt: f.updated_at,
    pins: pins.filter((p) => p.floor_id === f.id).map(({ room, x, y }) => ({ room, x, y })),
  }));
}

const floorId = (req: Request): number | null => {
  const id = Number(req.params['id']);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const exists = (id: number) => getDb().prepare('SELECT 1 FROM floor_maps WHERE id = ?').get(id) !== undefined;

export const floorsRouter = Router();

// GET /api/floors: the floors in order, with where each room is; pictures come separately.
floorsRouter.get('/', (_req: Request, res: Response) => {
  res.json(floorsWithPins());
});

// GET /api/floors/:id/image
floorsRouter.get('/:id/image', (req: Request, res: Response) => {
  const id = floorId(req);
  const row = id === null ? undefined : getDb().prepare('SELECT image, mime, updated_at FROM floor_maps WHERE id = ?').get(id) as
    { image: Buffer; mime: string; updated_at: string } | undefined;
  if (!row) return res.status(404).json({ error: 'No such floor', code: 'NOT_FOUND' });
  const tag = `"${row.updated_at}"`;
  res.setHeader('ETag', tag);
  res.setHeader('Cache-Control', 'private, no-cache');
  if (req.headers['if-none-match'] === tag) return res.status(304).end();
  res.setHeader('Content-Type', row.mime);
  res.send(row.image);
});

// POST /api/floors  multipart: image, name
floorsRouter.post('/', requireAdmin, takeImage, (req: Request, res: Response) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: `Give the floor a name (${MAX_NAME} characters at most).`, code: 'VALIDATION_ERROR' });
  const file = req.file!;
  const db = getDb();
  const next = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM floor_maps').get() as { p: number }).p;
  const id = Number(db.prepare('INSERT INTO floor_maps (name, position, image, mime) VALUES (?, ?, ?, ?)')
    .run(name, next, file.buffer, imageType(file.buffer)).lastInsertRowid);
  res.status(201).json(floorsWithPins().find((f) => f.id === id));
});

// PUT /api/floors/:id  { name }
floorsRouter.put('/:id', requireAdmin, (req: Request, res: Response) => {
  const id = floorId(req);
  if (id === null || !exists(id)) return res.status(404).json({ error: 'No such floor', code: 'NOT_FOUND' });
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: `Give the floor a name (${MAX_NAME} characters at most).`, code: 'VALIDATION_ERROR' });
  getDb().prepare('UPDATE floor_maps SET name = ? WHERE id = ?').run(name, id);
  res.json(floorsWithPins().find((f) => f.id === id));
});

// PUT /api/floors/:id/image  multipart: image. The rooms stay where they were placed.
floorsRouter.put('/:id/image', requireAdmin, takeImage, (req: Request, res: Response) => {
  const id = floorId(req);
  if (id === null || !exists(id)) return res.status(404).json({ error: 'No such floor', code: 'NOT_FOUND' });
  const file = req.file!;
  getDb().prepare("UPDATE floor_maps SET image = ?, mime = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(file.buffer, imageType(file.buffer), id);
  res.json(floorsWithPins().find((f) => f.id === id));
});

// PUT /api/floors/:id/pins  { pins: [{ room, x, y }] }: replaces where the floor's rooms are.
floorsRouter.put('/:id/pins', requireAdmin, (req: Request, res: Response) => {
  const id = floorId(req);
  if (id === null || !exists(id)) return res.status(404).json({ error: 'No such floor', code: 'NOT_FOUND' });
  const pins = req.body?.pins;
  if (!Array.isArray(pins) || pins.length > MAX_PINS) {
    return res.status(400).json({ error: 'pins: a list of { room, x, y }', code: 'VALIDATION_ERROR' });
  }
  const seen = new Set<string>();
  const clean: { room: string; x: number; y: number }[] = [];
  for (const p of pins) {
    const room = typeof p?.room === 'string' ? p.room.trim() : '';
    const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
    if (!room || room.length > 100 || !ok(p.x) || !ok(p.y)) {
      return res.status(400).json({ error: 'Each pin needs a room and x and y from 0 to 1.', code: 'VALIDATION_ERROR' });
    }
    if (seen.has(room)) return res.status(400).json({ error: `${room} is placed twice.`, code: 'VALIDATION_ERROR' });
    seen.add(room);
    clean.push({ room, x: p.x, y: p.y });
  }
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM floor_pins WHERE floor_id = ?').run(id);
    const add = db.prepare('INSERT INTO floor_pins (floor_id, room, x, y) VALUES (?, ?, ?, ?)');
    for (const p of clean) add.run(id, p.room, p.x, p.y);
  })();
  res.json(floorsWithPins().find((f) => f.id === id));
});

// DELETE /api/floors/:id
floorsRouter.delete('/:id', requireAdmin, (req: Request, res: Response) => {
  const id = floorId(req);
  if (id === null || !exists(id)) return res.status(404).json({ error: 'No such floor', code: 'NOT_FOUND' });
  getDb().prepare('DELETE FROM floor_maps WHERE id = ?').run(id);
  res.status(204).end();
});
