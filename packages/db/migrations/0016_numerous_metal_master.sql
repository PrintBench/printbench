CREATE TABLE "filament_spools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filament_id" uuid NOT NULL,
	"label" text,
	"nominal_weight_g" numeric(10, 2) DEFAULT '1000' NOT NULL,
	"empty_weight_g" numeric(10, 2),
	"purchase_cost" numeric(10, 2),
	"location" text,
	"notes" text,
	"low_stock_g" numeric(10, 2) DEFAULT '100' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filament_stock_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"spool_id" uuid NOT NULL,
	"amount_g" numeric(10, 2) NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"print_run_id" uuid,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filaments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"material" text NOT NULL,
	"color_name" text,
	"color_hex" text,
	"diameter_mm" numeric(5, 2) DEFAULT '1.75' NOT NULL,
	"nozzle_temp_c" numeric(5, 1),
	"bed_temp_c" numeric(5, 1),
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_filament_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"print_run_id" uuid NOT NULL,
	"spool_id" uuid NOT NULL,
	"grams" numeric(10, 2) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"cost_per_gram" numeric(16, 8)
);
--> statement-breakpoint
ALTER TABLE "print_runs" ADD COLUMN "filament_cost_manual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "print_runs" ADD COLUMN "recording_key" text;--> statement-breakpoint
ALTER TABLE "filament_spools" ADD CONSTRAINT "filament_spools_filament_id_filaments_id_fk" FOREIGN KEY ("filament_id") REFERENCES "public"."filaments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filament_stock_changes" ADD CONSTRAINT "filament_stock_changes_spool_id_filament_spools_id_fk" FOREIGN KEY ("spool_id") REFERENCES "public"."filament_spools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filament_stock_changes" ADD CONSTRAINT "filament_stock_changes_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_filament_usage" ADD CONSTRAINT "print_filament_usage_print_run_id_print_runs_id_fk" FOREIGN KEY ("print_run_id") REFERENCES "public"."print_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_filament_usage" ADD CONSTRAINT "print_filament_usage_spool_id_filament_spools_id_fk" FOREIGN KEY ("spool_id") REFERENCES "public"."filament_spools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "filament_spools_filament_idx" ON "filament_spools" USING btree ("filament_id");--> statement-breakpoint
CREATE INDEX "filament_stock_changes_spool_idx" ON "filament_stock_changes" USING btree ("spool_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "print_filament_usage_run_spool_idx" ON "print_filament_usage" USING btree ("print_run_id","spool_id");--> statement-breakpoint
CREATE INDEX "print_filament_usage_spool_idx" ON "print_filament_usage" USING btree ("spool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "print_runs_recording_key_idx" ON "print_runs" USING btree ("recording_key");