import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "../utils/AppError.js";
import { env } from "../config/env.js";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  // 1. Handled domain/operational AppError
  if (err instanceof AppError) {
    if (env.nodeEnv !== "production") {
      console.error(
        `[AppError] ${req.method} ${req.originalUrl} -> ${err.statusCode} ${err.code}: ${err.message}`,
        Object.keys(err.details).length > 0 ? err.details : ""
      );
    }

    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // 2. Client JSON syntax error (from express.json parser)
  if (
    err instanceof SyntaxError &&
    "status" in err &&
    err.status === 400 &&
    "body" in err
  ) {
    res.status(400).json({
      error: {
        code: "validation_error",
        message: "Malformed JSON in request body",
        details: {},
      },
    });
    return;
  }

  // 3. Multer upload errors (file size limit, unexpected fields, etc.)
  if (err instanceof multer.MulterError) {
    let message = "File upload error";
    if (err.code === "LIMIT_FILE_SIZE") {
      message = "File size exceeds the allowed limit (maximum 10MB)";
    } else if (err.code === "LIMIT_UNEXPECTED_FILE") {
      message = `Unexpected field in upload: ${err.field}`;
    } else if (err.code === "LIMIT_FILE_COUNT") {
      message = "Too many files uploaded in a single request";
    }

    res.status(400).json({
      error: {
        code: "validation_error",
        message,
        details: { multer_code: err.code, field: err.field },
      },
    });
    return;
  }

  // 4. Unhandled runtime error or bug (log context server-side, mask internal details to client)
  console.error(
    `[Unhandled Error] ${req.method} ${req.originalUrl}:`,
    err instanceof Error ? err.stack || err.message : err
  );

  res.status(500).json({
    error: {
      code: "internal_error",
      message: "Something went wrong",
      details: {},
    },
  });
}
