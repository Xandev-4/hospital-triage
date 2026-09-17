import "dotenv/config";

export const env = {
  PORT: parseInt(process.env.PORT || "8000", 10),
  NODE_ENV: process.env.NODE_ENV || "development",
  DATABASE_URL: process.env.DATABASE_URL || "",
  DATABASE_URL_POOLED: process.env.DATABASE_URL_POOLED || "",
  JWT_SECRET:
    process.env.JWT_SECRET || "default_jwt_secret_change_in_production",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "7d",
};
