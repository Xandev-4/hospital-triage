import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../../shared/config/db.js";
import { users, patients } from "../../shared/config/schema.js";
import { env } from "../../shared/config/env.js";
import { AppError } from "../../shared/utils/AppError.js";

const SALT_ROUNDS = 10;

export async function register(input: {
  name: string;
  email: string;
  password: string;
  phone_number?: string;
}) {
  const { name, password, phone_number } = input;
  const email = input.email?.trim().toLowerCase();

  if (
    !name ||
    !email ||
    !password ||
    password.length < 8 ||
    !email.includes("@")
  ) {
    throw AppError.validation(
      "name, valid email, and an 8+ character password are required"
    );
  }

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));

  if (existing.length > 0) {
    // Same generic error as any other validation failure — don't leak whether the email exists
    throw AppError.validation("Could not register with the provided details");
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  // Both inserts succeed together or not at all — a user row with no
  // linked patient row (or vice versa) would violate the ERD fix's whole point.
  return db.transaction(async (tx) => {
    const [patient] = await tx
      .insert(patients)
      .values({
        name,
        phoneNumber: phone_number,
      })
      .returning({ id: patients.id });

    if (!patient) {
      throw AppError.internal("Failed to create patient record");
    }

    const [user] = await tx
      .insert(users)
      .values({
        role: "patient",
        name,
        email,
        passwordHash,
        patientId: patient.id,
      })
      .returning({ id: users.id, role: users.role });

    if (!user) {
      throw AppError.internal("Failed to create user record");
    }

    return { user_id: user.id, role: user.role };
  });
}

export async function login(input: { email: string; password: string }) {
  const email = input.email?.trim().toLowerCase();
  const password = input.password;

  if (!email || !password) {
    throw AppError.unauthorized("Invalid email or password");
  }

  const [user] = await db.select().from(users).where(eq(users.email, email));

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw AppError.unauthorized("Invalid email or password");
  }

  const token = jwt.sign({ sub: user.id, role: user.role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn as jwt.SignOptions["expiresIn"],
  });

  return { token, role: user.role };
}

export async function getCurrentUser(userId: string) {
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) {
    throw AppError.notFound("User not found");
  }

  return {
    user_id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}
