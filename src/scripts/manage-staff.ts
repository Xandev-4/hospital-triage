import "dotenv/config";
import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { client, db } from "../shared/config/db.js";
import { users } from "../shared/config/schema.js";
import { hashPassword } from "../modules/auth/auth.service.js";

function printHelp() {
  console.log(`
🏥 Staff Management CLI Tool

Usage:
  npm run staff:list
      List all active staff members (doctors & receptionists).

  npm run staff:add -- --role <doctor|receptionist> --name "<Full Name>" --email "<Email>" [--password "<Password>"]
      Create a new staff account. Generates a secure random password if omitted.

  npm run staff:remove -- <email>
  npm run staff:remove -- --email <email>
      Remove a staff account by email.

Examples:
  npm run staff:add -- --role doctor --name "Dr. Gregory House" --email "dr.house@hospital.org"
  npm run staff:remove -- dr.house@hospital.org
  npm run staff:list
`);
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();

  const options: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        options[key] = next;
        i++;
      } else {
        options[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, options, positional };
}

function generateSecurePassword(): string {
  const randomStr = crypto.randomBytes(12).toString("base64url");
  return `${randomStr}!9Aa`;
}

async function handleList() {
  console.log("\n📋 Fetching staff directory...");
  const staff = await db
    .select({
      id: users.id,
      role: users.role,
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(inArray(users.role, ["doctor", "receptionist"]))
    .orderBy(users.role, users.name);

  if (staff.length === 0) {
    console.log("No staff accounts found in database.\n");
    return;
  }

  console.table(
    staff.map((s) => ({
      Role: s.role.toUpperCase(),
      Name: s.name,
      Email: s.email,
      ID: s.id,
      Created: s.createdAt
        ? new Date(s.createdAt).toISOString().split("T")[0]
        : "N/A",
    }))
  );
  console.log(`Total staff accounts: ${staff.length}\n`);
}

async function handleAdd(options: Record<string, string>) {
  const roleInput = options["role"]?.toLowerCase();
  const name = options["name"]?.trim();
  const email = options["email"]?.toLowerCase().trim();
  let rawPassword = options["password"];

  if (!roleInput || (roleInput !== "doctor" && roleInput !== "receptionist")) {
    console.error(
      "❌ Error: --role must be either 'doctor' or 'receptionist'."
    );
    process.exit(1);
  }

  if (!name || name.length < 2) {
    console.error("❌ Error: --name is required (minimum 2 characters).");
    process.exit(1);
  }

  if (!email || !email.includes("@")) {
    console.error("❌ Error: A valid --email is required.");
    process.exit(1);
  }

  // Check if account already exists
  const [existing] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    console.error(
      `❌ Error: User with email '${email}' already exists (role: ${existing.role}, ID: ${existing.id}).`
    );
    process.exit(1);
  }

  const generated = !rawPassword;
  if (!rawPassword) {
    rawPassword = generateSecurePassword();
  }

  const passwordHash = await hashPassword(rawPassword);

  const [inserted] = await db
    .insert(users)
    .values({
      name,
      email,
      role: roleInput as "doctor" | "receptionist",
      passwordHash,
      patientId: null,
    })
    .returning({
      id: users.id,
      role: users.role,
      name: users.name,
      email: users.email,
    });

  if (!inserted) {
    console.error("❌ Error: Failed to insert staff member.");
    process.exit(1);
  }

  console.log(`\n✅ Staff account successfully created!`);
  console.table([
    {
      Role: inserted.role,
      Name: inserted.name,
      Email: inserted.email,
      Password: rawPassword,
      Generated: generated ? "Yes (randomly generated)" : "No (custom flag)",
    },
  ]);
  console.log(
    "⚠️  Please copy and securely deliver this password to the staff member.\n"
  );
}

async function handleRemove(
  options: Record<string, string>,
  positional: string[]
) {
  const targetEmail = (options["email"] || positional[0])?.toLowerCase().trim();

  if (!targetEmail || !targetEmail.includes("@")) {
    console.error("❌ Error: Please specify the staff email to remove.");
    console.error("   Example: npm run staff:remove -- dr.house@hospital.org");
    process.exit(1);
  }

  const [targetUser] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
    })
    .from(users)
    .where(eq(users.email, targetEmail))
    .limit(1);

  if (!targetUser) {
    console.error(`❌ Error: No user found with email '${targetEmail}'.`);
    process.exit(1);
  }

  if (targetUser.role === "patient") {
    console.error(
      `❌ Safety Guard: '${targetEmail}' is a patient account, not a staff member.`
    );
    console.error(
      "   This tool only manages staff accounts ('doctor' and 'receptionist')."
    );
    process.exit(1);
  }

  const [deleted] = await db
    .delete(users)
    .where(eq(users.id, targetUser.id))
    .returning({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
    });

  if (deleted) {
    console.log(`\n🗑️  Successfully removed staff member:`);
    console.log(`   - Name:  ${deleted.name}`);
    console.log(`   - Role:  ${deleted.role}`);
    console.log(`   - Email: ${deleted.email}`);
    console.log(`   - ID:    ${deleted.id}\n`);
  }
}

async function main() {
  const { command, options, positional } = parseCliArgs();

  switch (command) {
    case "list":
      await handleList();
      break;

    case "add":
    case "create":
      await handleAdd(options);
      break;

    case "remove":
    case "delete":
      await handleRemove(options, positional);
      break;

    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;

    default:
      console.error(`Unknown command: '${command}'`);
      printHelp();
      process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("❌ Unexpected CLI error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await client.end();
  });
