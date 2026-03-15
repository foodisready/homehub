import { Server, type Socket } from 'socket.io';
import { type Server as HttpServer } from 'http';
import { verifyAccessToken } from '../auth/auth.service';
import { logger } from '../logger';

let _io: Server | null = null;

export function initSocket(httpServer: HttpServer): Server {
  _io = new Server(httpServer, {
    cors: {
      origin:      process.env.CORS_ORIGIN || 'http://localhost:4200',
      credentials: true,
    },
  });

  // Require valid JWT on connection
  _io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('Authentication required'));
    try {
      verifyAccessToken(token);
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  _io.on('connection', (socket: Socket) => {
    logger.debug({ id: socket.id }, 'Socket connected');
    socket.on('disconnect', () => logger.debug({ id: socket.id }, 'Socket disconnected'));
  });

  logger.info('Socket.io initialized');
  return _io;
}

export function getIo(): Server {
  if (!_io) throw new Error('Socket.io not initialized — call initSocket() first');
  return _io;
}

export function emitDeviceState(
  deviceId: number,
  alias: string,
  state: boolean,
  wattage: number | null,
): void {
  _io?.emit('device:state', { id: deviceId, alias, state, wattage });
}

export function emitDeviceEnergy(
  deviceId: number,
  alias: string,
  wattage: number | null,
  voltage: number | null,
  current: number | null,
): void {
  _io?.emit('device:energy', { id: deviceId, alias, wattage, voltage, current });
}

export function emitDeviceOnline(deviceId: number, alias: string, online: boolean): void {
  _io?.emit('device:online', { id: deviceId, alias, online });
}
