CREATE TYPE "public"."derived_state" AS ENUM('pending', 'ok', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."file_category" AS ENUM('model', 'image', 'archive', 'document', 'slicer', 'video', 'other');--> statement-breakpoint
CREATE TYPE "public"."grouping_mode" AS ENUM('deepest', 'top_level', 'flat');--> statement-breakpoint
CREATE TYPE "public"."library_kind" AS ENUM('in_place', 'managed');--> statement-breakpoint
CREATE TYPE "public"."list_kind" AS ENUM('normal', 'liked');--> statement-breakpoint
CREATE TYPE "public"."print_host_protocol" AS ENUM('octoprint', 'moonraker', 'prusalink');--> statement-breakpoint
CREATE TYPE "public"."print_status" AS ENUM('in_progress', 'success', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."problem_kind" AS ENUM('missing', 'empty', 'duplicate_digest', 'no_license', 'no_creator', 'no_image', 'no_tags', 'nested_model', 'unparseable');--> statement-breakpoint
CREATE TYPE "public"."problem_severity" AS ENUM('info', 'warning', 'danger');--> statement-breakpoint
CREATE TYPE "public"."scan_mode" AS ENUM('fast', 'deep');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."storage_backend" AS ENUM('local', 's3');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'viewer' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "libraries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "library_kind" DEFAULT 'in_place' NOT NULL,
	"backend" "storage_backend" DEFAULT 'local' NOT NULL,
	"path" text,
	"s3_bucket" text,
	"s3_prefix" text,
	"s3_endpoint" text,
	"s3_region" text,
	"s3_access_key_id" text,
	"s3_secret_access_key" text,
	"s3_force_path_style" boolean DEFAULT true NOT NULL,
	"allow_writes" boolean DEFAULT false NOT NULL,
	"write_sidecar" boolean DEFAULT true NOT NULL,
	"scan_enabled" boolean DEFAULT true NOT NULL,
	"scan_cron" text,
	"last_scan_id" uuid,
	"grouping_mode" "grouping_mode" DEFAULT 'deepest' NOT NULL,
	"grouping_depth" integer,
	"default_y_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_dirs" (
	"library_id" uuid NOT NULL,
	"rel_path" text NOT NULL,
	"mtime_ms" bigint,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"is_model_root" boolean DEFAULT false NOT NULL,
	"model_id" uuid,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_dirs_library_id_rel_path_pk" PRIMARY KEY("library_id","rel_path")
);
--> statement-breakpoint
CREATE TABLE "collection_models" (
	"collection_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "collection_models_collection_id_model_id_pk" PRIMARY KEY("collection_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "collection_tags" (
	"collection_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "collection_tags_collection_id_tag_id_pk" PRIMARY KEY("collection_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"public_id" text NOT NULL,
	"caption" text,
	"notes" text,
	"parent_id" uuid,
	"creator_id" uuid,
	"preview_model_id" uuid,
	"search_vector" "tsvector",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"host" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_tags" (
	"creator_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "creator_tags_creator_id_tag_id_pk" PRIMARY KEY("creator_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"public_id" text NOT NULL,
	"notes" text,
	"avatar_key" text,
	"search_vector" "tsvector",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"host" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_tags" (
	"model_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "model_tags_model_id_tag_id_pk" PRIMARY KEY("model_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"extension" text NOT NULL,
	"media_type" text,
	"category" "file_category" DEFAULT 'other' NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"mtime_ms" bigint,
	"etag" text,
	"digest" text,
	"presupported" boolean DEFAULT false NOT NULL,
	"y_up" boolean DEFAULT false NOT NULL,
	"previewable" boolean DEFAULT false NOT NULL,
	"triangle_count" integer,
	"bbox_x" numeric(12, 4),
	"bbox_y" numeric(12, 4),
	"bbox_z" numeric(12, 4),
	"bbox_unit" text DEFAULT 'mm',
	"manifold" boolean,
	"thumb_key" text,
	"thumb_state" "derived_state" DEFAULT 'pending' NOT NULL,
	"thumb_error" text,
	"analysis_state" "derived_state" DEFAULT 'pending' NOT NULL,
	"analysis_error" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"missing_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" uuid NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"public_id" text NOT NULL,
	"notes" text,
	"license" text,
	"creator_id" uuid,
	"preview_file_id" uuid,
	"is_file_model" boolean DEFAULT false NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"total_size" bigint DEFAULT 0 NOT NULL,
	"dir_mtime_ms" bigint,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"missing_at" timestamp with time zone,
	"search_vector" "tsvector",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "list_items" (
	"list_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "list_items_list_id_model_id_pk" PRIMARY KEY("list_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" "list_kind" DEFAULT 'normal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"protocol" "print_host_protocol" NOT NULL,
	"endpoint" text NOT NULL,
	"credentials" text,
	"last_seen_ok" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"model_file_id" uuid,
	"user_id" text,
	"printer_name" text,
	"material" text,
	"color_hex" text,
	"layer_height_mm" numeric(5, 3),
	"nozzle_mm" numeric(4, 2),
	"status" "print_status" DEFAULT 'success' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_min" integer,
	"filament_used_g" numeric(10, 2),
	"rating" smallint,
	"notes" text,
	"photo_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "problems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "problem_kind" NOT NULL,
	"severity" "problem_severity" DEFAULT 'info' NOT NULL,
	"model_id" uuid,
	"model_file_id" uuid,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"ignored_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" uuid NOT NULL,
	"status" "scan_status" DEFAULT 'queued' NOT NULL,
	"mode" "scan_mode" DEFAULT 'fast' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"dirs_walked" integer DEFAULT 0 NOT NULL,
	"files_seen" integer DEFAULT 0 NOT NULL,
	"models_created" integer DEFAULT 0 NOT NULL,
	"models_updated" integer DEFAULT 0 NOT NULL,
	"models_missing" integer DEFAULT 0 NOT NULL,
	"files_queued" integer DEFAULT 0 NOT NULL,
	"abort_reason" text,
	"errors" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_dirs" ADD CONSTRAINT "library_dirs_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_models" ADD CONSTRAINT "collection_models_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_tags" ADD CONSTRAINT "collection_tags_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_tags" ADD CONSTRAINT "collection_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_links" ADD CONSTRAINT "creator_links_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_tags" ADD CONSTRAINT "creator_tags_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_tags" ADD CONSTRAINT "creator_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_tags" ADD CONSTRAINT "model_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_files" ADD CONSTRAINT "model_files_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_runs" ADD CONSTRAINT "print_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_role_idx" ON "user" USING btree ("role");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "libraries_path_idx" ON "libraries" USING btree ("path");--> statement-breakpoint
CREATE INDEX "library_dirs_model_idx" ON "library_dirs" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "collection_models_model_idx" ON "collection_models" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "collection_tags_tag_idx" ON "collection_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_slug_uq" ON "collections" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_public_id_uq" ON "collections" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "collections_parent_idx" ON "collections" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_links_creator_url_uq" ON "creator_links" USING btree ("creator_id","url");--> statement-breakpoint
CREATE INDEX "creator_tags_tag_idx" ON "creator_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creators_slug_uq" ON "creators" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "creators_public_id_uq" ON "creators" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_links_model_url_uq" ON "model_links" USING btree ("model_id","url");--> statement-breakpoint
CREATE INDEX "model_tags_tag_idx" ON "model_tags" USING btree ("tag_id","model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_slug_uq" ON "tags" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "model_files_model_filename_uq" ON "model_files" USING btree ("model_id","filename");--> statement-breakpoint
CREATE INDEX "model_files_category_idx" ON "model_files" USING btree ("model_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "models_library_path_uq" ON "models" USING btree ("library_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "models_public_id_uq" ON "models" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "models_creator_idx" ON "models" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "models_library_idx" ON "models" USING btree ("library_id");--> statement-breakpoint
CREATE INDEX "list_items_model_idx" ON "list_items" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "lists_user_idx" ON "lists" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "print_runs_model_idx" ON "print_runs" USING btree ("model_id","started_at");--> statement-breakpoint
CREATE INDEX "print_runs_user_idx" ON "print_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "problems_kind_idx" ON "problems" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "problems_model_idx" ON "problems" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "scan_runs_library_idx" ON "scan_runs" USING btree ("library_id","started_at");