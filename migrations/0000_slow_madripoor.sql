CREATE TYPE "public"."audit_event_type" AS ENUM('consent_given', 'intake_submitted', 'ai_report_generated', 'status_changed', 'report_edited', 'risk_overridden', 'assigned', 'closed', 'patient_search', 'patient_created');--> statement-breakpoint
CREATE TYPE "public"."case_mode" AS ENUM('self', 'assisted');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('submitted', 'processing', 'queued', 'manual_fallback', 'assigned', 'closed', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."case_type" AS ENUM('walk_in', 'follow_up');--> statement-breakpoint
CREATE TYPE "public"."given_by" AS ENUM('self', 'staff');--> statement-breakpoint
CREATE TYPE "public"."report_source" AS ENUM('ai', 'doctor_edit', 'manual');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('patient', 'receptionist', 'doctor');--> statement-breakpoint
CREATE TYPE "public"."upload_modality" AS ENUM('voice', 'image_ocr');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid,
	"actor_id" uuid NOT NULL,
	"event_type" "audit_event_type" NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_report_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"source" "report_source" NOT NULL,
	"content" jsonb NOT NULL,
	"edited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_version_unique" UNIQUE("case_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "case_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"modality" "upload_modality" NOT NULL,
	"file_path" text NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"file_size" integer NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"given_by" "given_by" NOT NULL,
	"staff_id" uuid,
	"policy_version" varchar(50) NOT NULL,
	"given_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"phone_number" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triage_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"mode" "case_mode" NOT NULL,
	"status" "case_status" DEFAULT 'submitted' NOT NULL,
	"case_type" "case_type" DEFAULT 'walk_in' NOT NULL,
	"chief_complaint" text,
	"duration" varchar(100),
	"symptoms" text,
	"vitals" jsonb,
	"risk_level" "risk_level",
	"ai_rules_disagreement" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "role" NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"patient_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_patient_id_unique" UNIQUE("patient_id")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_case_id_triage_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."triage_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_report_versions" ADD CONSTRAINT "case_report_versions_case_id_triage_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."triage_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_report_versions" ADD CONSTRAINT "case_report_versions_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_uploads" ADD CONSTRAINT "case_uploads_case_id_triage_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."triage_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_staff_id_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_cases" ADD CONSTRAINT "triage_cases_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_cases" ADD CONSTRAINT "triage_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_cases" ADD CONSTRAINT "triage_cases_consent_id_consent_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."consent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_case_idx" ON "audit_log" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "report_versions_case_idx" ON "case_report_versions" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "uploads_case_idx" ON "case_uploads" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "consent_patient_idx" ON "consent" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "cases_status_risk_idx" ON "triage_cases" USING btree ("status","risk_level");--> statement-breakpoint
CREATE INDEX "cases_patient_idx" ON "triage_cases" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "cases_created_by_idx" ON "triage_cases" USING btree ("created_by");