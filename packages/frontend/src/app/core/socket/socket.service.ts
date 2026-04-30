import { Injectable, OnDestroy } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { AuthService } from '../auth/auth.service';

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

export interface SensorReadingEvent {
  id:           number;       // sensors.id
  sensorId:     string;       // sensors.sensor_id (the human key)
  rateM3h:      number;
  totalM3:      number | null;
  recordedAt:   string;
}

export interface SensorAlertEvent {
  id:           number;       // sensors.id
  sensorId:     string;
  eventId:      number;
  alertLevel:   number;
  rateM3h:      number;
}

@Injectable({ providedIn: 'root' })
export class SocketService implements OnDestroy {
  private socket: Socket | null = null;

  constructor(private auth: AuthService) {}

  connect(): void {
    if (this.socket?.connected) return;

    this.socket = io('/', {
      // auth callback: called before every connect/reconnect attempt
      // so it always uses the current (possibly refreshed) token
      auth: (cb) => cb({ token: this.auth.accessToken() ?? '' }),
      transports: ['websocket', 'polling'],
    });

    this.socket.on('connect', () => console.log('[socket] connected'));
    this.socket.on('disconnect', () => console.log('[socket] disconnected'));
    this.socket.on('connect_error', (err) => {
      console.warn('[socket] error', err.message);
      // If auth failed, refresh the token then let socket.io auto-reconnect
      if (err.message === 'Invalid or expired token') {
        this.auth.refresh().subscribe({
          next: () => this.socket?.connect(),
          error: () => {},
        });
      }
    });
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

  onSensorReading(callback: (event: SensorReadingEvent) => void): () => void {
    this.socket?.on('sensor:flow:reading', callback);
    return () => this.socket?.off('sensor:flow:reading', callback);
  }

  onSensorAlert(callback: (event: SensorAlertEvent) => void): () => void {
    this.socket?.on('sensor:flow:alert', callback);
    return () => this.socket?.off('sensor:flow:alert', callback);
  }

  ngOnDestroy(): void {
    this.disconnect();
  }
}
