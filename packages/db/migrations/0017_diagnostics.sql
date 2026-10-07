CREATE TABLE "app_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"source" text NOT NULL,
	"scope" text,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"outcome" text DEFAULT 'success' NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"target_type" text,
	"target_id" text,
	"target_label" text,
	"detail" jsonb,
	"ip" text,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "process_status" (
	"source" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"info" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "app_logs_at_idx" ON "app_logs" USING btree ("at");--> statement-breakpoint
CREATE INDEX "app_logs_level_idx" ON "app_logs" USING btree ("level","at");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_id","occurred_at");