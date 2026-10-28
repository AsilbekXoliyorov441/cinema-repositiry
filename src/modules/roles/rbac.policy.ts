import { AppError } from '../../common/errors/app-error.js';
import type { AuthContext } from '../../common/types/auth.js';

/**
 * Privilege-escalation rules shared by role and user management. Pure functions — unit tested.
 *
 *  1. Nobody can change their own roles or status.
 *  2. An actor can only manage roles strictly below their own highest level.
 *  3. An actor can only manage users whose highest level is strictly below their own.
 *  4. An actor can only grant permissions they hold themselves.
 *  5. Protected accounts (bootstrap super admin) cannot be banned/deleted/demoted by anyone else.
 */
export const rbacPolicy = {
  assertNotSelf(actor: Pick<AuthContext, 'userId'>, targetUserId: string): void {
    if (actor.userId === targetUserId) throw AppError.forbidden('You cannot perform this action on your own account');
  },

  assertCanManageRoleLevel(actor: Pick<AuthContext, 'roleLevel'>, roleLevel: number): void {
    if (roleLevel >= actor.roleLevel) {
      throw AppError.forbidden('You can only manage roles below your own privilege level');
    }
  },

  assertCanManageUser(
    actor: Pick<AuthContext, 'roleLevel' | 'userId'>,
    target: { id: string; roleLevel: number; isProtected: boolean },
  ): void {
    this.assertNotSelf(actor, target.id);
    if (target.isProtected) throw AppError.forbidden('This account is protected');
    if (target.roleLevel >= actor.roleLevel) {
      throw AppError.forbidden('You can only manage users below your own privilege level');
    }
  },

  assertCanGrantPermissions(actor: Pick<AuthContext, 'permissions'>, permissionKeys: string[]): void {
    const notHeld = permissionKeys.filter((p) => !actor.permissions.has(p as never));
    if (notHeld.length) {
      throw AppError.forbidden(`You cannot grant permissions you do not hold: ${notHeld.join(', ')}`);
    }
  },
};
