import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ==============================================================================
// Database ENUMs (pgEnum)
// ==============================================================================
export const roleEnum = pgEnum("role", ["patient", "receptionist", "doctor"]);

export const givenByEnum = pgEnum("given_by", ["self", "staff"]);

export const caseModeEnum = pgEnum("case_mode", ["self", "assisted"]);

export const caseStatusEnum = pgEnum("case_status", [
  "submitted",
  "processing",
  "queued",
  "manual_fallback",
  "assigned",
  "closed",
  "withdrawn",
]);

export const caseTypeEnum = pgEnum("case_type", ["walk_in", "follow_up"]);

export const riskLevelEnum = pgEnum("risk_level", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const uploadModalityEnum = pgEnum("upload_modality", [
  "voice",
  "image_ocr",
]);

export const reportSourceEnum = pgEnum("report_source", [
  "ai",
  "doctor_edit",
  "manual",
]);

export const auditEventTypeEnum = pgEnum("audit_event_type", [
  "consent_given",
  "intake_submitted",
  "ai_report_generated",
  "status_changed",
  "report_edited",
  "risk_overridden",
  "assigned",
  "closed",
  "patient_search",
  "patient_created",
]);

// ==============================================================================
// 1. Users
// ==============================================================================
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  role: roleEnum("role").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  patientId: uuid("patient_id")
    .references(() => patients.id, { onDelete: "set null" })
    .unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  patient: one(patients, {
    fields: [users.patientId],
    references: [patients.id],
  }),
  createdCases: many(triageCases),
  auditLogs: many(auditLog),
  editedReportVersions: many(caseReportVersions),
}));

// ==============================================================================
// 2. Patients
// ==============================================================================
export const patients = pgTable(
  "patients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    phoneNumber: varchar("phone_number", { length: 50 }), // Nullable for self-registration, populated during intake
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("patients_name_idx").on(table.name),
    index("patients_phone_idx").on(table.phoneNumber),
  ]
);

export const patientsRelations = relations(patients, ({ one, many }) => ({
  user: one(users, {
    fields: [patients.id],
    references: [users.patientId],
  }),
  consents: many(consent),
  cases: many(triageCases),
}));

// ==============================================================================
// 3. Consent
// ==============================================================================
export const consent = pgTable(
  "consent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    givenBy: givenByEnum("given_by").notNull(),
    staffId: uuid("staff_id").references(() => users.id, {
      onDelete: "set null",
    }),
    policyVersion: varchar("policy_version", { length: 50 }).notNull(),
    givenAt: timestamp("given_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("consent_patient_idx").on(table.patientId)]
);

export const consentRelations = relations(consent, ({ one, many }) => ({
  patient: one(patients, {
    fields: [consent.patientId],
    references: [patients.id],
  }),
  staff: one(users, {
    fields: [consent.staffId],
    references: [users.id],
  }),
  cases: many(triageCases),
}));

// ==============================================================================
// 4. Triage Cases
// ==============================================================================
export const triageCases = pgTable(
  "triage_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    consentId: uuid("consent_id")
      .notNull()
      .references(() => consent.id, { onDelete: "restrict" }),
    mode: caseModeEnum("mode").notNull(),
    status: caseStatusEnum("status").default("submitted").notNull(),
    caseType: caseTypeEnum("case_type").default("walk_in").notNull(),
    chiefComplaint: text("chief_complaint"),
    duration: varchar("duration", { length: 100 }),
    symptoms: text("symptoms"),
    vitals: jsonb("vitals"),
    riskLevel: riskLevelEnum("risk_level"),
    aiRulesDisagreement: boolean("ai_rules_disagreement")
      .default(false)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("cases_status_risk_idx").on(table.status, table.riskLevel),
    index("cases_patient_idx").on(table.patientId),
    index("cases_created_by_idx").on(table.createdBy),
  ]
);

export const triageCasesRelations = relations(triageCases, ({ one, many }) => ({
  patient: one(patients, {
    fields: [triageCases.patientId],
    references: [patients.id],
  }),
  creator: one(users, {
    fields: [triageCases.createdBy],
    references: [users.id],
  }),
  consent: one(consent, {
    fields: [triageCases.consentId],
    references: [consent.id],
  }),
  uploads: many(caseUploads),
  reportVersions: many(caseReportVersions),
  auditLogs: many(auditLog),
}));

// ==============================================================================
// 5. Case Uploads
// ==============================================================================
export const caseUploads = pgTable(
  "case_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => triageCases.id, { onDelete: "cascade" }),
    modality: uploadModalityEnum("modality").notNull(),
    filePath: text("file_path").notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    fileSize: integer("file_size").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("uploads_case_idx").on(table.caseId)]
);

export const caseUploadsRelations = relations(caseUploads, ({ one }) => ({
  case: one(triageCases, {
    fields: [caseUploads.caseId],
    references: [triageCases.id],
  }),
}));

// ==============================================================================
// 6. Case Report Versions
// ==============================================================================
export const caseReportVersions = pgTable(
  "case_report_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => triageCases.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    source: reportSourceEnum("source").notNull(),
    content: jsonb("content").notNull(),
    editedBy: uuid("edited_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("case_version_unique").on(table.caseId, table.versionNumber),
    index("report_versions_case_idx").on(table.caseId),
  ]
);

export const caseReportVersionsRelations = relations(
  caseReportVersions,
  ({ one }) => ({
    case: one(triageCases, {
      fields: [caseReportVersions.caseId],
      references: [triageCases.id],
    }),
    editor: one(users, {
      fields: [caseReportVersions.editedBy],
      references: [users.id],
    }),
  })
);

// ==============================================================================
// 7. Audit Log
// ==============================================================================
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id").references(() => triageCases.id, {
      onDelete: "set null",
    }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    eventType: auditEventTypeEnum("event_type").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_case_idx").on(table.caseId),
    index("audit_actor_idx").on(table.actorId),
  ]
);

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  case: one(triageCases, {
    fields: [auditLog.caseId],
    references: [triageCases.id],
  }),
  actor: one(users, {
    fields: [auditLog.actorId],
    references: [users.id],
  }),
}));

// ==============================================================================
// TypeScript Types
// ==============================================================================
export type Role = (typeof roleEnum.enumValues)[number];
export type GivenBy = (typeof givenByEnum.enumValues)[number];
export type CaseMode = (typeof caseModeEnum.enumValues)[number];
export type CaseStatus = (typeof caseStatusEnum.enumValues)[number];
export type CaseType = (typeof caseTypeEnum.enumValues)[number];
export type RiskLevel = (typeof riskLevelEnum.enumValues)[number];
export type UploadModality = (typeof uploadModalityEnum.enumValues)[number];
export type ReportSource = (typeof reportSourceEnum.enumValues)[number];
export type AuditEventType = (typeof auditEventTypeEnum.enumValues)[number];

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Patient = typeof patients.$inferSelect;
export type NewPatient = typeof patients.$inferInsert;

export type Consent = typeof consent.$inferSelect;
export type NewConsent = typeof consent.$inferInsert;

export type TriageCase = typeof triageCases.$inferSelect;
export type NewTriageCase = typeof triageCases.$inferInsert;

export type CaseUpload = typeof caseUploads.$inferSelect;
export type NewCaseUpload = typeof caseUploads.$inferInsert;

export type CaseReportVersion = typeof caseReportVersions.$inferSelect;
export type NewCaseReportVersion = typeof caseReportVersions.$inferInsert;

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
