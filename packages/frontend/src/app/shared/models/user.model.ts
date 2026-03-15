export type Role = 'admin' | 'member';

export interface AuthUser {
  id: number;
  name: string;
  role: Role;
}
