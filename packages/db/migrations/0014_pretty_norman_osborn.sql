ALTER TABLE "provider_credentials" ALTER COLUMN "makerworld_cookie_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN "thingiverse_token_encrypted" text;