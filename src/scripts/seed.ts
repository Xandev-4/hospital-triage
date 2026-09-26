import "dotenv/config";
import crypto from "node:crypto";
import { count, eq } from "drizzle-orm";
import { client, db } from "../shared/config/db.js";
import { users } from "../shared/config/schema.js";
import { hashPassword } from "../modules/auth/auth.service.js";

interface SeedAccountDef {
  name: string;
  email: string;
  role: "doctor" | "receptionist";
  envPasswordKey: string;
}

const SEED_ACCOUNTS: SeedAccountDef[] = [
  {
    name: "Dr. Aisha Sharma",
    email: "dr.aisha.sharma@hospital.org",
    role: "doctor",
    envPasswordKey: "SEED_DOCTOR_1_PASSWORD",
  },
  {
    name: "Dr. Marcus Chen",
    email: "dr.marcus.chen@hospital.org",
    role: "doctor",
    envPasswordKey: "SEED_DOCTOR_2_PASSWORD",
  },
  {
    name: "Priya Nair",
    email: "reception.priya@hospital.org",
    role: "receptionist",
    envPasswordKey: "SEED_RECEPTIONIST_1_PASSWORD",
  },
  {
    name: "Rahul Verma",
    email: "reception.rahul@hospital.org",
    role: "receptionist",
    envPasswordKey: "SEED_RECEPTIONIST_2_PASSWORD",
  },
];

function generateSecurePassword(): string {
  // Generate random 14 base64url characters + mix symbols and numbers to ensure strong complexity
  const randomStr = crypto.randomBytes(12).toString("base64url");
  return `${randomStr}!9Aa`;
}

async function runSeed() {
  const hasForce = process.argv.includes("--force");
  console.log("🌱 Starting staff account seed script...");

  // Guard 1: Production check
  if (process.env.NODE_ENV === "production" && !hasForce) {
    console.error(
      "❌ [SAFETY GUARD] NODE_ENV is set to 'production'. Aborting seed."
    );
    console.error(
      "   To bypass this safety check intentionally, pass --force."
    );
    process.exit(1);
  }

  // Guard 2: Production-like database size check
  try {
    const countResult = await db.select({ count: count() }).from(users);

    const userCountNum = countResult[0] ? Number(countResult[0].count) : 0;
    if (userCountNum > 50 && !hasForce) {
      console.error(
        `❌ [SAFETY GUARD] Detected ${userCountNum} existing users in the database.`
      );
      console.error(
        "   Aborting to prevent accidentally polluting a production or populated database."
      );
      console.error("   Pass --force to proceed anyway.");
      process.exit(1);
    }
  } catch (error) {
    console.warn(
      "⚠️  Could not verify existing user count. Proceeding with caution..."
    );
  }

  const createdCredentials: Array<{
    name: string;
    role: string;
    email: string;
    password: string;
  }> = [];

  const existingAccounts: string[] = [];

  for (const accountDef of SEED_ACCOUNTS) {
    const email = accountDef.email.toLowerCase().trim();

    // Idempotency check: does user already exist?
    const existing = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const shouldSyncPasswords = process.argv.includes("--sync-passwords");
    const existingUser = existing[0];

    if (existingUser) {
      if (shouldSyncPasswords) {
        const rawPassword =
          process.env[accountDef.envPasswordKey] || generateSecurePassword();
        const passwordHash = await hashPassword(rawPassword);
        await db
          .update(users)
          .set({ passwordHash })
          .where(eq(users.email, email));
        createdCredentials.push({
          name: accountDef.name,
          role: accountDef.role,
          email,
          password: rawPassword,
        });
      } else {
        existingAccounts.push(`${email} (${existingUser.role})`);
      }
      continue;
    }

    // Determine password: from environment variable or securely generated
    const rawPassword =
      process.env[accountDef.envPasswordKey] || generateSecurePassword();

    // Hash password using the same auth module hashing logic
    const passwordHash = await hashPassword(rawPassword);

    await db.insert(users).values({
      name: accountDef.name,
      email,
      role: accountDef.role,
      passwordHash,
      patientId: null, // Staff accounts are not patients
    });

    createdCredentials.push({
      name: accountDef.name,
      role: accountDef.role,
      email,
      password: rawPassword,
    });
  }

  if (existingAccounts.length > 0) {
    console.log(`ℹ️  Skipped ${existingAccounts.length} existing account(s):`);
    for (const acc of existingAccounts) {
      console.log(`   - ${acc}`);
    }
  }

  if (createdCredentials.length > 0) {
    console.log(
      `\n✅ Successfully seeded ${createdCredentials.length} staff account(s):`
    );
    console.table(
      createdCredentials.map((c) => ({
        Role: c.role,
        Name: c.name,
        Email: c.email,
        Password: c.password,
      }))
    );
    console.log(
      "⚠️  NOTE: Save these credentials for testing or login. Passwords are generated uniquely per account and will not be displayed again.\n"
    );
  } else {
    console.log(
      "\n✨ All staff accounts are already up to date. No new accounts created."
    );
  }
}

runSeed()
  .catch((err) => {
    console.error("❌ Seed script failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await client.end();
  });
