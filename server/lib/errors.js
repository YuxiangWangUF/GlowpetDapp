export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function assert(condition, code, message, status = 400) {
  if (!condition) throw new AppError(code, message, status);
}

export function isUniqueViolation(error) {
  return error?.code === "23505" || /duplicate key|unique constraint/i.test(error?.message ?? "");
}

export function publicError(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
    };
  }
  return {
    status: 500,
    body: { code: "INTERNAL_ERROR", message: "The request could not be completed. Please try again." },
  };
}
