ALTER TABLE "models" ADD COLUMN "license_url" text;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "license_expires_at" date;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "commercial_use" boolean;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "license_notes" text;