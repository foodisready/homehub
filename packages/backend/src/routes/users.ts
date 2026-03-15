import { Router, Request, Response } from 'express';
import {
  listUsers,
  createUser,
  findUserById,
  updatePassword,
  deleteUser,
  type Role,
} from '../auth/auth.service';
import { requireAdmin } from '../middleware/auth';
import { logger } from '../logger';

export const usersRouter = Router();

// GET /api/users — admin only
usersRouter.get('/', requireAdmin, (_req: Request, res: Response) => {
  res.json(listUsers());
});

// POST /api/users — admin only
usersRouter.post('/', requireAdmin, async (req: Request, res: Response) => {
  const { name, password, role = 'member' } = req.body as {
    name?: string; password?: string; role?: Role;
  };

  if (!name || !password) {
    return res.status(400).json({ error: 'name and password are required', code: 'VALIDATION_ERROR' });
  }
  if (!['admin', 'member'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin or member', code: 'VALIDATION_ERROR' });
  }

  try {
    const user = await createUser(name, password, role);
    logger.info({ createdBy: req.user?.name, newUser: name, role }, 'User created');
    res.status(201).json({ id: user.id, name: user.name, role: user.role, createdAt: user.created_at });
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Username already exists', code: 'CONFLICT' });
    }
    throw err;
  }
});

// PATCH /api/users/:id/password — own account or admin
usersRouter.patch('/:id/password', async (req: Request, res: Response) => {
  const targetId  = Number(req.params.id);
  const requestor = req.user!;

  // Members can only change their own password
  if (requestor.role !== 'admin' && requestor.sub !== targetId) {
    return res.status(403).json({ error: 'Cannot change another user\'s password', code: 'FORBIDDEN' });
  }

  const target = findUserById(targetId);
  if (!target) return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });

  const { newPassword } = req.body as { newPassword?: string };
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'newPassword must be at least 8 characters', code: 'VALIDATION_ERROR' });
  }

  await updatePassword(targetId, newPassword);
  logger.info({ changedBy: requestor.name, targetUser: target.name }, 'Password updated');
  res.status(204).send();
});

// DELETE /api/users/:id — admin only, cannot delete own account
usersRouter.delete('/:id', requireAdmin, (req: Request, res: Response) => {
  const targetId = Number(req.params.id);

  if (targetId === req.user!.sub) {
    return res.status(400).json({ error: 'Cannot delete your own account', code: 'VALIDATION_ERROR' });
  }

  const deleted = deleteUser(targetId);
  if (!deleted) return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });

  logger.info({ deletedBy: req.user?.name, targetId }, 'User deleted');
  res.status(204).send();
});
