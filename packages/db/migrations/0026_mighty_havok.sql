CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"object_name" text,
	"bytes" bigint,
	"pruned" integer DEFAULT 0 NOT NULL,
	"key_id" text,
	"error" text,
	"requested_by" text
);
--> statement-breakpoint
CREATE TABLE "backup_schedule" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"s3_connection_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"cron" text NOT NULL,
	"keep" integer DEFAULT 14 NOT NULL,
	"key_id" text NOT NULL,
	"public_key" text NOT NULL,
	"sealed_private_key" jsonb NOT NULL,
	"key_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_schedule_single_row" CHECK ("backup_schedule"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "instance_identity" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"instance_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_identity_single_row" CHECK ("instance_identity"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "backup_schedule" ADD CONSTRAINT "backup_schedule_s3_connection_id_s3_connections_id_fk" FOREIGN KEY ("s3_connection_id") REFERENCES "public"."s3_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_runs_started_idx" ON "backup_runs" USING btree ("started_at");