-- Per-model share links.
--
-- A separate secret from public_id, which is already the internal URL segment
-- and is therefore known to everyone who can see the model. Sharing has to be
-- an explicit act with its own token, or every model would be reachable by
-- anyone who had ever seen its address.
ALTER TABLE "models" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "shared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "shared_by" text;--> statement-breakpoint

-- Partial: only shared models occupy the index, and revoking sets the token
-- back to NULL rather than deleting the row.
CREATE UNIQUE INDEX "models_share_token_uq" ON "models" ("share_token")
  WHERE "share_token" IS NOT NULL;
