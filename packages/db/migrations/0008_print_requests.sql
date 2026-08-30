-- The print queue.
--
-- A list of things people have asked to have printed. Shared across the
-- instance, not per-user: a request is addressed to whoever runs the printer,
-- so a queue only its author can see is the wrong shape.
--
-- `title` is the only required column. Requests routinely arrive before the
-- file does — "something to hold the kitchen roll" is a real queue entry — so
-- the link to a model is optional and set later, either by hand or by the
-- exact-name match the service attempts on insert.
CREATE TYPE "print_request_status" AS ENUM ('requested', 'printing', 'done', 'cancelled');

-- Declaration order is the enum's sort order, which is what makes
-- `ORDER BY priority DESC` mean urgent-first without a CASE expression.
CREATE TYPE "print_request_priority" AS ENUM ('low', 'normal', 'high');

CREATE TABLE "print_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  "title" text NOT NULL,
  "notes" text,

  -- Free text, not a foreign key: most people who ask for a print do not have
  -- an account here. requested_by_user_id is filled in as well when they do.
  "requested_by" text,
  "requested_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,

  -- SET NULL rather than CASCADE. If the model goes, the request is still
  -- outstanding; it just has nothing to point at any more.
  "model_id" uuid REFERENCES "models"("id") ON DELETE SET NULL,
  "model_file_id" uuid REFERENCES "model_files"("id") ON DELETE SET NULL,

  "quantity" integer NOT NULL DEFAULT 1,
  "priority" "print_request_priority" NOT NULL DEFAULT 'normal',
  "status" "print_request_status" NOT NULL DEFAULT 'requested',

  "material" text,
  "color_hex" text,

  "due_at" timestamp with time zone,
  -- Set when the request reaches 'done' or 'cancelled'.
  "closed_at" timestamp with time zone,

  "created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "print_requests_title_not_blank" CHECK (btrim("title") <> ''),
  CONSTRAINT "print_requests_quantity_check" CHECK ("quantity" >= 1 AND "quantity" <= 999),
  -- A file may only be named alongside the model it belongs to; a file id with
  -- no model is a link that points nowhere useful.
  CONSTRAINT "print_requests_file_needs_model"
    CHECK ("model_file_id" IS NULL OR "model_id" IS NOT NULL)
);

-- The queue view: open requests, most urgent first.
CREATE INDEX "print_requests_status_idx"
  ON "print_requests" ("status", "priority" DESC, "due_at");

-- "What is queued for this model", shown on the model page.
CREATE INDEX "print_requests_model_idx" ON "print_requests" ("model_id")
  WHERE "model_id" IS NOT NULL;

-- A viewer may manage the requests they raised, so their own rows are looked
-- up by author on every permission check.
CREATE INDEX "print_requests_creator_idx" ON "print_requests" ("created_by");
