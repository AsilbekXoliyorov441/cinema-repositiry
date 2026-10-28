import type { AuditSeverity, Prisma } from '@prisma/client';
import { prisma, type DbOrTx } from '../../config/database.js';
import { logger } from '../../config/logger.js';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  severity?: AuditSeverity;
  metadata?: Prisma.InputJsonValue;
  client?: { ip?: string | undefined; userAgent?: string | undefined };
}

/**
 * Writes an audit record. Pass a transaction client to make the audit entry atomic with the change
 * it describes; otherwise failures are logged but never break the business operation.
 */
export async function writeAudit(entry: AuditEntry, db: DbOrTx = prisma): Promise<void> {
  const data = {
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    severity: entry.severity ?? 'LOW',
    metadata: entry.metadata ?? undefined,
    ipAddress: entry.client?.ip ?? null,
    userAgent: entry.client?.userAgent ?? null,
  };
  if (db !== prisma) {
    await db.auditLog.create({ data });
    return;
  }
  try {
    await prisma.auditLog.create({ data });
  } catch (err) {
    logger.error({ err, action: entry.action }, 'Failed to write audit log');
  }
}
