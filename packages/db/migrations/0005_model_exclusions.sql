-- Models the user has removed from a library.
--
-- Deleting the model row alone is not enough: the files are still on disk, so
-- the next scan finds the folder and recreates it. This records the decision
-- so scanning skips it.
--
-- Keyed on the path rather than the model id precisely because the row is
-- gone. Restoring is deleting the row here; the next scan picks the folder up
-- again as if it were new.
CREATE TABLE "model_exclusions" (
  "library_id" uuid NOT NULL REFERENCES "libraries"("id") ON DELETE CASCADE,
  "path" text NOT NULL,
  "name" text,
  "excluded_at" timestamp with time zone NOT NULL DEFAULT now(),
  "excluded_by" text,
  CONSTRAINT "model_exclusions_pk" PRIMARY KEY ("library_id", "path")
);
