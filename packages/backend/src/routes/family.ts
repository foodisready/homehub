import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { getDb } from '../db';
import { getHomeSettings } from '../home/home-settings';
import { getVoiceSettings, lastBridgeReport } from '../system/voice-bridge';
import {
  audience, CheckinError, deleteCheckin, getCheckin, listCheckins, preview, readSettings, saveCheckin, sendTest,
} from '../family/checkin';
import {
  announce, announcementStatus, deleteReminder, getReminder, listReminders, ReminderError, saveReminder, voiceFor, type ReminderLanguage,
} from '../family/reminders';

/** Daily check-ins and spoken reminders, mounted at /api/family. Check-ins are an admin's to set. */
export const familyRouter = Router();

const id = (req: Request) => Number(req.params['id']);
const bad = (res: Response, err: unknown) => {
  if (err instanceof CheckinError || err instanceof ReminderError) return res.status(400).json({ error: err.message, code: 'VALIDATION_ERROR' });
  throw err;
};

function speakers() {
  const r = lastBridgeReport();
  const fresh = !!r && Date.now() - r.at < 5 * 60_000;
  return (fresh ? r!.speakers : []).map((s) => ({ name: s.name, connected: s.connected, announce: s.announce }));
}

// GET /api/family — everything the Family page shows
familyRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  res.json({
    checkins: listCheckins(),
    reminders: listReminders(),
    audience: audience(),
    voice: { ...getVoiceSettings(), speakers: speakers() },
    users: (db.prepare('SELECT name FROM users ORDER BY name').all() as { name: string }[]).map((u) => u.name),
    motionRules: (db.prepare('SELECT id, name, ring_camera_id FROM motion_rules ORDER BY name').all() as { id: number; name: string; ring_camera_id: number | null }[])
      .map((r) => ({ id: r.id, name: r.name, ring: r.ring_camera_id !== null })),
    hasFlowSensor: !!db.prepare("SELECT 1 FROM sensors WHERE type = 'flow' LIMIT 1").get(),
    timezone: getHomeSettings().timezone,
  });
});

// ── Check-ins ───────────────────────────────────────────────────

// POST /api/family/checkins/preview  { from, by, devices, motion, appUsers, voice, water, days? }
// What these settings would have done on each of the last 14 days.
familyRouter.post('/checkins/preview', requireAdmin, (req: Request, res: Response) => {
  try {
    const s = readSettings(req.body ?? {});
    const days = Array.isArray(req.body?.days) ? (req.body.days as unknown[]).filter((d): d is number => Number.isInteger(d)) : undefined;
    res.json({ days: preview(s, days) });
  } catch (err) { bad(res, err); }
});

familyRouter.post('/checkins', requireAdmin, (req: Request, res: Response) => {
  try { res.status(201).json(saveCheckin(req.body)); } catch (err) { bad(res, err); }
});

familyRouter.put('/checkins/:id', requireAdmin, (req: Request, res: Response) => {
  try { res.json(saveCheckin(req.body, id(req))); } catch (err) { bad(res, err); }
});

familyRouter.delete('/checkins/:id', requireAdmin, (req: Request, res: Response) => {
  if (!deleteCheckin(id(req))) return res.status(404).json({ error: 'No such check-in', code: 'NOT_FOUND' });
  res.status(204).end();
});

// POST /api/family/checkins/:id/test — sends a test alert, so the family knows they'd get one
familyRouter.post('/checkins/:id/test', requireAdmin, async (req: Request, res: Response) => {
  const c = getCheckin(id(req));
  if (!c) return res.status(404).json({ error: 'No such check-in', code: 'NOT_FOUND' });
  res.json(await sendTest(c));
});

// ── Reminders: anyone in the family can set them ────────────────

familyRouter.post('/reminders', (req: Request, res: Response) => {
  try { res.status(201).json(saveReminder(req.body)); } catch (err) { bad(res, err); }
});

familyRouter.put('/reminders/:id', (req: Request, res: Response) => {
  try { res.json(saveReminder(req.body, id(req))); } catch (err) { bad(res, err); }
});

familyRouter.delete('/reminders/:id', (req: Request, res: Response) => {
  if (!deleteReminder(id(req))) return res.status(404).json({ error: 'No such reminder', code: 'NOT_FOUND' });
  res.status(204).end();
});

// POST /api/family/reminders/say  { text, language } or { id } — say it on the speakers now, to hear it
familyRouter.post('/reminders/say', (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { id?: unknown; text?: unknown; language?: unknown };
  const saved = typeof b.id === 'number' ? getReminder(b.id) : null;
  const text = saved?.text ?? (typeof b.text === 'string' ? b.text.trim().slice(0, 200) : '');
  const language = (saved?.language ?? (typeof b.language === 'string' ? b.language : 'auto')) as ReminderLanguage;
  if (!text) return res.status(400).json({ error: 'Nothing to say', code: 'VALIDATION_ERROR' });
  if (!getVoiceSettings().enabled) return res.status(409).json({ error: 'Voice control is off: turn it on in Settings → Voice control', code: 'VOICE_OFF' });
  const lang = voiceFor(text, language);
  if (!lang) return res.status(400).json({ error: 'That language isn’t on in Settings → Voice control', code: 'VALIDATION_ERROR' });
  res.status(202).json({ id: announce(text, lang, saved?.id ?? null), lang });
});

// GET /api/family/reminders/say/:id — whether the speakers said it yet
familyRouter.get('/reminders/say/:id', (req: Request, res: Response) => {
  const r = announcementStatus(String(req.params['id']));
  if (!r) return res.status(404).json({ error: 'Not known, or too long ago', code: 'NOT_FOUND' });
  res.json(r);
});
