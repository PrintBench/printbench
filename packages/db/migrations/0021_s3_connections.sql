CREATE TABLE "s3_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"bucket" text NOT NULL,
	"endpoint" text,
	"region" text,
	"access_key_id" text,
	"secret_access_key" text,
	"force_path_style" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "s3_connection_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "s3_connections_name_idx" ON "s3_connections" USING btree ("name");--> statement-breakpoint
ALTER TABLE "libraries" ADD CONSTRAINT "libraries_s3_connection_id_s3_connections_id_fk" FOREIGN KEY ("s3_connection_id") REFERENCES "public"."s3_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "libraries_s3_connection_idx" ON "libraries" USING btree ("s3_connection_id");