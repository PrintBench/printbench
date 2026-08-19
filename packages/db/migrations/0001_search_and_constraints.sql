-- Everything drizzle-kit cannot emit: extensions, a text-search configuration,
-- GIN / trigram / partial indexes, circular foreign keys and check constraints.
-- Hand-written and hand-reviewed.

--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Accent-folding English search config, so "pokemon" matches "Pokémon".
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'pm_search') THEN
    CREATE TEXT SEARCH CONFIGURATION pm_search ( COPY = english );
    ALTER TEXT SEARCH CONFIGURATION pm_search
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, english_stem;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Roles and identity
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT user_role_check
  CHECK (role IN ('admin', 'member', 'viewer'));

-- ---------------------------------------------------------------------------
-- Full-text search. Weighting: name > creator/tags > notes > filenames.
-- The vector is maintained by packages/core/search/refresh.ts, not a generated
-- column, because it must include data from joined rows.
-- ---------------------------------------------------------------------------
--> statement-breakpoint
CREATE INDEX models_search_gin ON models USING gin (search_vector);
--> statement-breakpoint
CREATE INDEX creators_search_gin ON creators USING gin (search_vector);
--> statement-breakpoint
CREATE INDEX collections_search_gin ON collections USING gin (search_vector);

-- Trigram indexes give typo tolerance ("dargon" -> "Dragon") via the % operator.
--> statement-breakpoint
CREATE INDEX models_name_trgm ON models USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX creators_name_trgm ON creators USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX tags_name_trgm ON tags USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX model_files_filename_trgm ON model_files USING gin (filename gin_trgm_ops);

-- Case-insensitive uniqueness on human-entered names.
--> statement-breakpoint
CREATE UNIQUE INDEX creators_name_lower_uq ON creators (lower(name));
--> statement-breakpoint
CREATE UNIQUE INDEX tags_name_lower_uq ON tags (lower(name));

-- ---------------------------------------------------------------------------
-- Browse paths. Partial indexes keep soft-deleted rows out of the hot indexes.
-- ---------------------------------------------------------------------------
--> statement-breakpoint
CREATE INDEX models_browse_idx ON models (library_id, name, id) WHERE missing_at IS NULL;
--> statement-breakpoint
CREATE INDEX models_recent_idx ON models (created_at DESC, id DESC) WHERE missing_at IS NULL;
--> statement-breakpoint
CREATE INDEX models_missing_idx ON models (missing_at) WHERE missing_at IS NOT NULL;

-- Duplicate detection joins on digest; most rows have one, none are interesting when null.
--> statement-breakpoint
CREATE INDEX model_files_digest_idx ON model_files (digest) WHERE digest IS NOT NULL;
-- The thumbnail worker's queue query, kept tiny by the partial predicate.
--> statement-breakpoint
CREATE INDEX model_files_thumb_todo ON model_files (thumb_state)
  WHERE thumb_state = 'pending' AND previewable;
--> statement-breakpoint
CREATE INDEX model_files_analysis_todo ON model_files (analysis_state)
  WHERE analysis_state = 'pending' AND previewable;

-- ---------------------------------------------------------------------------
-- Circular FK: a model points at its preview file, which belongs to the model.
-- Deferred to here because neither table can be created after the other.
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE models ADD CONSTRAINT models_preview_file_fk
  FOREIGN KEY (preview_file_id) REFERENCES model_files(id) ON DELETE SET NULL;

-- Remaining cross-table FKs left off the Drizzle definitions to avoid import cycles.
--> statement-breakpoint
ALTER TABLE library_dirs ADD CONSTRAINT library_dirs_model_fk
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE collection_models ADD CONSTRAINT collection_models_model_fk
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE collections ADD CONSTRAINT collections_parent_fk
  FOREIGN KEY (parent_id) REFERENCES collections(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE collections ADD CONSTRAINT collections_preview_model_fk
  FOREIGN KEY (preview_model_id) REFERENCES models(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE model_tags ADD CONSTRAINT model_tags_model_fk
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE model_links ADD CONSTRAINT model_links_model_fk
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE list_items ADD CONSTRAINT list_items_model_fk
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE print_runs ADD CONSTRAINT print_runs_model_fk
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE print_runs ADD CONSTRAINT print_runs_model_file_fk
  FOREIGN KEY (model_file_id) REFERENCES model_files(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE problems ADD CONSTRAINT problems_model_fk
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE problems ADD CONSTRAINT problems_model_file_fk
  FOREIGN KEY (model_file_id) REFERENCES model_files(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE libraries ADD CONSTRAINT libraries_last_scan_fk
  FOREIGN KEY (last_scan_id) REFERENCES scan_runs(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Domain invariants
-- ---------------------------------------------------------------------------
-- A collection cannot be its own parent. Deeper cycles are prevented in the
-- service layer, where the whole ancestor chain is visible.
--> statement-breakpoint
ALTER TABLE collections ADD CONSTRAINT collections_no_self_parent CHECK (id <> parent_id);

-- Exactly one "liked" list per user.
--> statement-breakpoint
CREATE UNIQUE INDEX lists_user_liked_uq ON lists (user_id) WHERE kind = 'liked';

-- A rating, when given, is 1-5.
--> statement-breakpoint
ALTER TABLE print_runs ADD CONSTRAINT print_runs_rating_range
  CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5));

-- A library must actually say where its bytes are.
--> statement-breakpoint
ALTER TABLE libraries ADD CONSTRAINT libraries_backend_target CHECK (
  (backend = 'local' AND path IS NOT NULL) OR
  (backend = 's3'    AND s3_bucket IS NOT NULL)
);

-- One open problem of a given kind per subject. Lets the scanner re-raise
-- problems idempotently with ON CONFLICT DO NOTHING.
--> statement-breakpoint
CREATE UNIQUE INDEX problems_open_uq ON problems (
  kind,
  coalesce(model_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(model_file_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE resolved_at IS NULL;
