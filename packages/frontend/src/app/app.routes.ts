import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
  {
    path: 'login',
    loadComponent: () => import('./features/login/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'dashboard',
    loadComponent: () => import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
    canActivate: [authGuard],
  },
  {
    path: 'schedules',
    loadComponent: () => import('./features/schedules/schedules.component').then((m) => m.SchedulesComponent),
    canActivate: [authGuard],
  },
  {
    path: 'chat',
    loadComponent: () => import('./features/chat/chat.component').then((m) => m.ChatComponent),
    canActivate: [authGuard],
  },
  {
    path: 'energy',
    loadComponent: () => import('./features/energy/energy.component').then((m) => m.EnergyComponent),
    canActivate: [authGuard],
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/settings/settings.component').then((m) => m.SettingsComponent),
    canActivate: [authGuard],
  },
  {
    path: 'scenes',
    loadComponent: () => import('./features/scenes/scenes.component').then((m) => m.ScenesComponent),
    canActivate: [authGuard],
  },
  {
    path: 'sensors',
    loadComponent: () => import('./features/sensors/sensors.component').then((m) => m.SensorsComponent),
    canActivate: [authGuard],
  },
  {
    path: 'sensors/:id',
    loadComponent: () => import('./features/sensors/sensor-detail.component').then((m) => m.SensorDetailComponent),
    canActivate: [authGuard],
  },
  {
    path: 'activity',
    loadComponent: () => import('./features/activity/activity.component').then((m) => m.ActivityComponent),
    canActivate: [authGuard],
  },
  {
    path: 'cameras',
    loadComponent: () => import('./features/cameras/cameras.component').then((m) => m.CamerasComponent),
    canActivate: [authGuard],
  },
  {
    path: 'firmware',
    loadComponent: () => import('./features/firmware/firmware.component').then((m) => m.FirmwareComponent),
    canActivate: [authGuard],
  },
  {
    path: 'notifications',
    loadComponent: () => import('./features/notifications/notifications.component').then((m) => m.NotificationsComponent),
    canActivate: [authGuard],
  },
  { path: '**', redirectTo: 'dashboard' },
];
