/**
 * Security Utility: API Key and Secret Sanitization
 *
 * Ensures no third-party API keys (Groq, Gemini/Google, Bearer tokens, etc.)
 * are ever leaked into client-facing HTTP error responses, internal exceptions,
 * or server audit logs.
 */

export function sanitizeErrorMessage(message: unknown): string {
  if (!message) return "";
  let sanitized = typeof message === "string" ? message : (message as any)?.message ?? String(message);

  // 1. Redact Groq API keys (format: gsk_...)
  sanitized = sanitized.replace(/gsk_[a-zA-Z0-9_-]+/g, "[REDACTED_GROQ_KEY]");

  // 2. Redact Google / Gemini API keys (format: AIzaSy...)
  sanitized = sanitized.replace(/AIza[0-9A-Za-z-_]{35}/g, "[REDACTED_GEMINI_KEY]");

  // 3. Redact query parameter keys (e.g. ?key=... or &key=...)
  sanitized = sanitized.replace(/([?&]key=)[^&\s"']+/gi, "$1[REDACTED]");

  // 4. Redact Authorization Bearer headers or tokens
  sanitized = sanitized.replace(/(Bearer\s+)[a-zA-Z0-9_\-\.]+/gi, "$1[REDACTED]");

  // 5. Redact live environment secrets if present in runtime
  if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.length > 5) {
    sanitized = sanitized.split(process.env.GROQ_API_KEY).join("[REDACTED_GROQ_KEY]");
  }
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 5) {
    sanitized = sanitized.split(process.env.GEMINI_API_KEY).join("[REDACTED_GEMINI_KEY]");
  }
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length > 5) {
    sanitized = sanitized.split(process.env.JWT_SECRET).join("[REDACTED_JWT_SECRET]");
  }

  return sanitized;
}
