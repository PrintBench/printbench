-- Moves each S3 library's bucket and credentials into a connection of its own.
--
-- One connection per library rather than merging libraries that look alike:
-- the secrets are encrypted with a random IV, so two libraries holding the
-- same key cannot be told apart in SQL, and guessing would hand a library the
-- wrong secret. An admin can point libraries at one connection afterwards.
--
-- The connection reuses the library's id, which is what lets the UPDATE below
-- find it again without a mapping table. The ciphertext is copied as it is:
-- both columns are encrypted under the same BETTER_AUTH_SECRET.
--
-- This also runs when an older backup is restored: its credentials are written
-- back into the legacy columns first, then carried across by this step.
INSERT INTO "s3_connections" (
	"id", "name", "bucket", "endpoint", "region", "access_key_id", "secret_access_key",
	"force_path_style", "created_at", "updated_at"
)
SELECT
	"id",
	-- Connection names are unique; library names never were.
	CASE WHEN count(*) OVER (PARTITION BY "name") > 1
		THEN "name" || ' (' || left("id"::text, 8) || ')'
		ELSE "name"
	END,
	"s3_bucket", "s3_endpoint", "s3_region", "s3_access_key_id", "s3_secret_access_key",
	"s3_force_path_style", "created_at", now()
FROM "libraries"
WHERE "backend" = 's3' AND "s3_bucket" IS NOT NULL;
--> statement-breakpoint
UPDATE "libraries" SET "s3_connection_id" = "id"
WHERE "backend" = 's3' AND "s3_bucket" IS NOT NULL;
