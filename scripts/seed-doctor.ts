import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import { db } from "../src/shared/config/db.js";
import {
  users,
  triageCases,
  patients,
  consent,
} from "../src/shared/config/schema.js";

async function main() {
  console.log("--- Doctor Seeder & DB State Inspector ---");

  // 1. Seed or ensure Doctor exists
  const doctorEmail = "dr.house@hospital.org";
  const doctorPassword = "DoctorPassword123!";

  const existingDoctor = await db
    .select()
    .from(users)
    .where(eq(users.email, doctorEmail));

  let doctorId: string;
  if (existingDoctor.length > 0) {
    console.log(
      `Doctor already exists: ${doctorEmail} (ID: ${existingDoctor[0].id})`
    );
    doctorId = existingDoctor[0].id;
  } else {
    const passwordHash = await bcrypt.hash(doctorPassword, 10);
    const [newDoc] = await db
      .insert(users)
      .values({
        name: "Dr. Gregory House",
        email: doctorEmail,
        passwordHash,
        role: "doctor",
      })
      .returning();
    console.log(`Created new Doctor: ${doctorEmail} (ID: ${newDoc.id})`);
    doctorId = newDoc.id;
  }

  // 2. Check existing cases
  const existingCases = await db.select().from(triageCases);
  console.log(`Current triage cases in DB: ${existingCases.length}`);

  for (const c of existingCases) {
    console.log(
      `- [${c.status}] Risk: ${c.riskLevel} | ID: ${c.id} | Complaint: ${c.chiefComplaint?.substring(0, 50)}`
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Seeder failed:", err);
  process.exit(1);
});
