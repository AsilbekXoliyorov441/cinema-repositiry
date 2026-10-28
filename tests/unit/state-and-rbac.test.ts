import { describe, expect, it } from 'vitest';
import { canTransitionPayment, canTransitionSubscription, assertSubscriptionTransition } from '../../src/modules/subscriptions/subscription-state.js';
import { rbacPolicy } from '../../src/modules/roles/rbac.policy.js';
import { AppError } from '../../src/common/errors/app-error.js';
import type { Permission } from '../../src/common/constants/permissions.js';

describe('subscription state machine', () => {
  it('allows the documented lifecycle', () => {
    expect(canTransitionSubscription('PENDING', 'ACTIVE')).toBe(true);
    expect(canTransitionSubscription('ACTIVE', 'PAST_DUE')).toBe(true);
    expect(canTransitionSubscription('PAST_DUE', 'ACTIVE')).toBe(true);
    expect(canTransitionSubscription('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(canTransitionSubscription('SUSPENDED', 'ACTIVE')).toBe(true);
  });
  it('treats CANCELED and EXPIRED as terminal', () => {
    for (const to of ['ACTIVE', 'PENDING', 'PAST_DUE', 'SUSPENDED'] as const) {
      expect(canTransitionSubscription('CANCELED', to)).toBe(false);
      expect(canTransitionSubscription('EXPIRED', to)).toBe(false);
    }
    expect(() => assertSubscriptionTransition('EXPIRED', 'ACTIVE')).toThrow(AppError);
  });
  it('never jumps from PENDING to PAST_DUE or SUSPENDED', () => {
    expect(canTransitionSubscription('PENDING', 'PAST_DUE')).toBe(false);
    expect(canTransitionSubscription('PENDING', 'SUSPENDED')).toBe(false);
  });
});

describe('payment state machine', () => {
  it('allows retries after failure and refunds after success', () => {
    expect(canTransitionPayment('FAILED', 'SUCCEEDED')).toBe(true);
    expect(canTransitionPayment('SUCCEEDED', 'REFUNDED')).toBe(true);
    expect(canTransitionPayment('PARTIALLY_REFUNDED', 'REFUNDED')).toBe(true);
  });
  it('blocks impossible transitions', () => {
    expect(canTransitionPayment('PENDING', 'REFUNDED')).toBe(false);
    expect(canTransitionPayment('REFUNDED', 'SUCCEEDED')).toBe(false);
    expect(canTransitionPayment('CANCELED', 'SUCCEEDED')).toBe(false);
  });
});

describe('rbacPolicy', () => {
  const admin = { userId: 'a', roleLevel: 80, permissions: new Set(['users:manage', 'content:write'] as Permission[]) };

  it('blocks acting on yourself', () => {
    expect(() => rbacPolicy.assertCanManageUser(admin, { id: 'a', roleLevel: 10, isProtected: false })).toThrow(/own account/);
  });
  it('blocks managing peers, superiors and protected accounts', () => {
    expect(() => rbacPolicy.assertCanManageUser(admin, { id: 'b', roleLevel: 80, isProtected: false })).toThrow(/below your own/);
    expect(() => rbacPolicy.assertCanManageUser(admin, { id: 'b', roleLevel: 100, isProtected: false })).toThrow();
    expect(() => rbacPolicy.assertCanManageUser(admin, { id: 'b', roleLevel: 10, isProtected: true })).toThrow(/protected/);
  });
  it('allows managing lower-level users', () => {
    expect(() => rbacPolicy.assertCanManageUser(admin, { id: 'b', roleLevel: 50, isProtected: false })).not.toThrow();
  });
  it('blocks granting roles at or above own level and permissions not held', () => {
    expect(() => rbacPolicy.assertCanManageRoleLevel(admin, 80)).toThrow();
    expect(() => rbacPolicy.assertCanManageRoleLevel(admin, 79)).not.toThrow();
    expect(() => rbacPolicy.assertCanGrantPermissions(admin, ['content:write', 'roles:manage'])).toThrow(/roles:manage/);
    expect(() => rbacPolicy.assertCanGrantPermissions(admin, ['content:write'])).not.toThrow();
  });
});
