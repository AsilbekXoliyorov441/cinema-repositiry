import type { Permission } from '../constants/permissions.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  emailVerified: boolean;
  roles: string[];
  /** Highest role level the user holds — used for privilege-escalation checks. */
  roleLevel: number;
  permissions: ReadonlySet<Permission>;
  mfaVerified: boolean;
  birthDate: Date | null;
}
