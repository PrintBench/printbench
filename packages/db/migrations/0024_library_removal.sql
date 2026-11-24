CREATE TYPE "public"."library_removal_mode" AS ENUM('delete_files', 'move');--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "removal_mode" "library_removal_mode";--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "removal_destination_id" uuid;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "removal_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "removal_error" text;--> statement-breakpoint
ALTER TABLE "libraries" ADD CONSTRAINT "libraries_removal_destination_id_libraries_id_fk" FOREIGN KEY ("removal_destination_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;