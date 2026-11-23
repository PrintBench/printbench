CREATE TABLE "model_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"print_run_id" uuid,
	"user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_notes" ADD CONSTRAINT "model_notes_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_notes" ADD CONSTRAINT "model_notes_print_run_id_print_runs_id_fk" FOREIGN KEY ("print_run_id") REFERENCES "public"."print_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_notes" ADD CONSTRAINT "model_notes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_notes_model_idx" ON "model_notes" USING btree ("model_id","created_at");--> statement-breakpoint
CREATE INDEX "model_notes_print_idx" ON "model_notes" USING btree ("print_run_id");