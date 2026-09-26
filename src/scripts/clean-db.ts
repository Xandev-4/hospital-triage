import "dotenv/config";
import { sql } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { client, db } from "../shared/config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.resolve(__dirname, "../../uploads");

async function main() {
  console.log("=================================================");
  console.log("   CLEANUP: Clearing Test Data & Database        ");
  console.log("=================================================");

  // 1. Inspect current row counts
  console.log("\n📊 Current Database Counts:");
  const tables = [
    "audit_log",
    "case_report_versions",
    "case_uploads",
    "triage_cases",
    "consent",
    "users",
    "patients",
  ];

  for (const t of tables) {
    const res: any = await db.execute(sql.raw(`SELECT count(*) FROM "${t}"`));
    const cnt = res[0]?.count ?? res.rows?.[0]?.count ?? 0;
    console.log(`   - ${t.padEnd(22)}: ${cnt} rows`);
  }

  // 2. Truncate tables in dependency order with CASCADE
  console.log("\n🧹 Truncating database tables...");
  // Using CASCADE to cleanly wipe test data while preserving table structures, indices, enums
  await db.execute(
    sql.raw(`
    TRUNCATE TABLE 
      audit_log,
      case_report_versions,
      case_uploads,
      triage_cases,
      consent,
      users,
      patients
    CASCADE;
  `)
  );
  console.log("   ✓ All database tables truncated successfully.");

  // 3. Clear uploads directory
  console.log("\n📁 Cleaning uploads directory...");
  if (fs.existsSync(UPLOADS_DIR)) {
    const files = fs.readdirSync(UPLOADS_DIR);
    let deletedCount = 0;
    for (const f of files) {
      if (f === ".gitkeep") continue;
      const filePath = path.join(UPLOADS_DIR, f);
      if (fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    }
    console.log(`   ✓ Removed ${deletedCount} test files from ${UPLOADS_DIR}`);
  } else {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    console.log(`   ✓ Created empty uploads directory.`);
  }

  // Ensure .gitkeep in uploads
  const gitkeepPath = path.join(UPLOADS_DIR, ".gitkeep");
  if (!fs.existsSync(gitkeepPath)) {
    fs.writeFileSync(gitkeepPath, "");
  }

  // 4. Verify clean counts
  console.log("\n📊 Verification - Post-Cleanup Database Counts:");
  for (const t of tables) {
    const res: any = await db.execute(sql.raw(`SELECT count(*) FROM "${t}"`));
    const cnt = res[0]?.count ?? res.rows?.[0]?.count ?? 0;
    console.log(`   - ${t.padEnd(22)}: ${cnt} rows`);
  }

  console.log(
    "\n✨ Cleanup completed successfully! Database and uploads are completely clean."
  );
}

main()
  .catch((err) => {
    console.error("❌ Cleanup failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await client.end();
  });
