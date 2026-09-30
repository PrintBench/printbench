ALTER TABLE "models"
  ADD COLUMN "license_url" text,
  ADD COLUMN "license_expires_at" date,
  ADD COLUMN "commercial_use" boolean,
  ADD COLUMN "license_notes" text;
