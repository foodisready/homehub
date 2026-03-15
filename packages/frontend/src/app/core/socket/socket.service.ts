import { Injectable, OnDestroy } from '@angular/core';
import { io, Socket } from 'socket.io-client';

export interface DeviceStateEvent {
  id: number;
  alias: string;
  state: boolean;
  wattage: number | null;
}

export interface DeviceOnlineEvent {
  id: number;
  alias: string;
  online: boolean;
}

@Injectable({ providedIn: 'root' })
export class SocketService implements OnDestroy {
  private socket: Socket | null = null;

  connect(token: string): void {
    if (this.socket?.connected) return;

    this.socket = io('/', {
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    this.socket.on('connect', () => console.log('[socket] connected'));
    this.socket.on('disconnect', () => console.log('[socket] disconnected'));
    this.socket.on('connect_error', (err) => console.warn('[socket] error', err.message));
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  onDeviceState(callback: (event: DeviceStateEvent) => void): () => void {
    this.socket?.on('device:state', callback);
    return () => this.socket?.off('device:state', callback);
  }

  onDeviceOnline(callback: (event: DeviceOnlineEvent) => void): () => void {
    this.socket?.on('device:online', callback);
    return () => this.socket?.off('device:online', callback);
  }

  ngOnDestroy(): void {
    this.disconnect();
  }
}
