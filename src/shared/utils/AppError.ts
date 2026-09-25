export type ErrorCode =
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "consent_required"
  | "not_found"
  | "invalid_state_transition"
  | "conflict"
  | "internal_error";

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details: Record<string, unknown>;
  public readonly isOperational: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;

    // Preserve clean stack trace in V8 engines
    Error.captureStackTrace(this, this.constructor);
  }

  static validation(message: string, details?: Record<string, unknown>) {
    return new AppError("validation_error", message, 400, details);
  }

  static unauthorized(message = "Invalid or missing credentials") {
    return new AppError("unauthorized", message, 401);
  }

  static forbidden(message = "Not allowed to access this resource") {
    return new AppError("forbidden", message, 403);
  }

  static consentRequired(
    message = "Valid consent is required before this action"
  ) {
    return new AppError("consent_required", message, 403);
  }

  static notFound(
    message = "Resource not found",
    details?: Record<string, unknown>
  ) {
    return new AppError("not_found", message, 404, details);
  }

  static invalidStateTransition(
    message: string,
    details?: Record<string, unknown>
  ) {
    return new AppError("invalid_state_transition", message, 409, details);
  }

  static conflict(message: string, details?: Record<string, unknown>) {
    return new AppError("conflict", message, 409, details);
  }

  static internal(message = "Something went wrong") {
    return new AppError("internal_error", message, 500);
  }
}
