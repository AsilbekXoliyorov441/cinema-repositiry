export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  SUBSCRIPTION_REQUIRED: 'SUBSCRIPTION_REQUIRED',
  AGE_RESTRICTED: 'AGE_RESTRICTED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  FILE_UPLOAD_ERROR: 'FILE_UPLOAD_ERROR',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  PAYMENT_ERROR: 'PAYMENT_ERROR',
  PAYMENT_PROVIDER_UNAVAILABLE: 'PAYMENT_PROVIDER_UNAVAILABLE',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  DATABASE_ERROR: 'DATABASE_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorDetail {
  path?: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Operational error with an HTTP status and stable machine-readable code.
 * Anything that is not an AppError is treated as an unexpected 500.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details: ErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message = 'Bad request', details: ErrorDetail[] = []) {
    return new AppError(400, ErrorCode.BAD_REQUEST, message, details);
  }
  static validation(details: ErrorDetail[], message = 'Validation failed') {
    return new AppError(422, ErrorCode.VALIDATION_ERROR, message, details);
  }
  static unauthenticated(message = 'Authentication required', code: ErrorCode = ErrorCode.UNAUTHENTICATED) {
    return new AppError(401, code, message);
  }
  static forbidden(message = 'You do not have permission to perform this action', code: ErrorCode = ErrorCode.FORBIDDEN) {
    return new AppError(403, code, message);
  }
  static notFound(resource = 'Resource') {
    return new AppError(404, ErrorCode.NOT_FOUND, `${resource} not found`);
  }
  static conflict(message: string, details: ErrorDetail[] = []) {
    return new AppError(409, ErrorCode.CONFLICT, message, details);
  }
  static payment(message: string, code: ErrorCode = ErrorCode.PAYMENT_ERROR, status = 402) {
    return new AppError(status, code, message);
  }
  static upload(message: string, code: ErrorCode = ErrorCode.FILE_UPLOAD_ERROR, status = 400) {
    return new AppError(status, code, message);
  }
  static unavailable(message = 'Service temporarily unavailable') {
    return new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, message);
  }
}
