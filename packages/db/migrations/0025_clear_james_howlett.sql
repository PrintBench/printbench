CREATE TABLE "filament_catalog_brands" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"origin" text,
	"parent_brand_uuid" uuid,
	"discontinued" boolean DEFAULT false NOT NULL,
	"logo_path" text,
	"ofd_id" text NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seen_version" text NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "filament_catalog_filaments" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"brand_uuid" uuid NOT NULL,
	"material_uuid" uuid NOT NULL,
	"name" text NOT NULL,
	"material" text NOT NULL,
	"density_g_cm3" double precision,
	"diameter_tolerance_mm" double precision,
	"min_print_temp_c" double precision,
	"max_print_temp_c" double precision,
	"preheat_temp_c" double precision,
	"min_bed_temp_c" double precision,
	"max_bed_temp_c" double precision,
	"chamber_temp_c" double precision,
	"min_chamber_temp_c" double precision,
	"max_chamber_temp_c" double precision,
	"dry_temp_c" double precision,
	"dry_time_h" double precision,
	"max_dry_temp_c" double precision,
	"enclosure" text,
	"min_nozzle_mm" double precision,
	"min_print_speed_mm_s" double precision,
	"max_print_speed_mm_s" double precision,
	"min_fan_speed_pct" double precision,
	"max_fan_speed_pct" double precision,
	"max_volumetric_speed_mm3_s" double precision,
	"shore_hardness_a" double precision,
	"shore_hardness_d" double precision,
	"data_sheet_url" text,
	"safety_sheet_url" text,
	"slicer_settings" jsonb,
	"certifications" text[] DEFAULT '{}' NOT NULL,
	"discontinued" boolean DEFAULT false NOT NULL,
	"ofd_id" text NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seen_version" text NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "filament_catalog_materials" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"brand_uuid" uuid NOT NULL,
	"material" text NOT NULL,
	"material_class" text,
	"default_max_dry_temp_c" double precision,
	"default_slicer_settings" jsonb,
	"ofd_id" text NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seen_version" text NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "filament_catalog_meta" (
	"id" text PRIMARY KEY DEFAULT 'ofd' NOT NULL,
	"dataset_version" text NOT NULL,
	"source_tag" text NOT NULL,
	"source_sha256" text NOT NULL,
	"content_sha256" text NOT NULL,
	"generated_at" text NOT NULL,
	"counts" jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filament_catalog_purchase_links" (
	"ofd_id" text PRIMARY KEY NOT NULL,
	"size_uuid" uuid NOT NULL,
	"store_uuid" uuid NOT NULL,
	"url" text NOT NULL,
	"spool_refill" boolean DEFAULT false NOT NULL,
	"affiliate" boolean DEFAULT false NOT NULL,
	"ships_from" text[] DEFAULT '{}' NOT NULL,
	"ships_to" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filament_catalog_sizes" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"variant_uuid" uuid NOT NULL,
	"filament_weight_g" double precision,
	"diameter_mm" double precision,
	"empty_spool_weight_g" double precision,
	"spool_core_diameter_mm" double precision,
	"spool_refill" boolean DEFAULT false NOT NULL,
	"article_number" text,
	"gtin" text,
	"container_material" text,
	"discontinued" boolean DEFAULT false NOT NULL,
	"ofd_id" text NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seen_version" text NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "filament_catalog_stores" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"storefront_url" text,
	"ships_from" text[] DEFAULT '{}' NOT NULL,
	"ships_to" text[] DEFAULT '{}' NOT NULL,
	"logo_path" text,
	"ofd_id" text NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seen_version" text NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "filament_catalog_variants" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"filament_uuid" uuid NOT NULL,
	"name" text NOT NULL,
	"color_hex" text,
	"color_hexes" text[] DEFAULT '{}' NOT NULL,
	"traits" text[] DEFAULT '{}' NOT NULL,
	"transmission_distance" double precision,
	"discontinued" boolean DEFAULT false NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"search_vector" "tsvector",
	"ofd_id" text NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seen_version" text NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "filament_spools" ADD COLUMN "catalog_size_uuid" uuid;--> statement-breakpoint
ALTER TABLE "filaments" ADD COLUMN "catalog_variant_uuid" uuid;--> statement-breakpoint
CREATE INDEX "filament_catalog_brands_name_idx" ON "filament_catalog_brands" USING btree ("name");--> statement-breakpoint
CREATE INDEX "filament_catalog_filaments_brand_idx" ON "filament_catalog_filaments" USING btree ("brand_uuid");--> statement-breakpoint
CREATE INDEX "filament_catalog_filaments_material_idx" ON "filament_catalog_filaments" USING btree ("material");--> statement-breakpoint
CREATE INDEX "filament_catalog_materials_brand_idx" ON "filament_catalog_materials" USING btree ("brand_uuid");--> statement-breakpoint
CREATE INDEX "filament_catalog_purchase_links_size_idx" ON "filament_catalog_purchase_links" USING btree ("size_uuid");--> statement-breakpoint
CREATE INDEX "filament_catalog_sizes_variant_idx" ON "filament_catalog_sizes" USING btree ("variant_uuid");--> statement-breakpoint
CREATE INDEX "filament_catalog_sizes_gtin_idx" ON "filament_catalog_sizes" USING btree ("gtin");--> statement-breakpoint
CREATE INDEX "filament_catalog_variants_filament_idx" ON "filament_catalog_variants" USING btree ("filament_uuid");--> statement-breakpoint
CREATE INDEX "filament_catalog_variants_search_gin" ON "filament_catalog_variants" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "filament_catalog_variants_search_trgm" ON "filament_catalog_variants" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "filaments_catalog_variant_idx" ON "filaments" USING btree ("catalog_variant_uuid");