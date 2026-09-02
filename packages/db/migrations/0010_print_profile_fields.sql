-- Print history grows into a print profile.
--
-- print_runs already recorded the printer, material, layer height and nozzle
-- DIAMETER. What it could not answer is the question people actually get wrong
-- — what the nozzle was made of — along with everything the slicer was asked to
-- do, and which spool the filament came off.
--
-- Every column here is nullable, and deliberately so. A print logged by hand
-- genuinely does not know its wall count, and the existing rows never will. A
-- NOT NULL with a default would invent an answer for thousands of past prints,
-- which is worse than admitting the gap: "unknown" and "zero walls" are not the
-- same fact. This is why `supports` is a nullable boolean rather than defaulting
-- to false — null is unknown, false is a deliberate "no supports".
--
-- All ADD COLUMN on nullable columns with no default, so Postgres rewrites
-- nothing and this is instant on a large table.

CREATE TYPE "nozzle_type" AS ENUM ('brass', 'hardened_steel', 'ruby', 'tungsten_carbide', 'other');
CREATE TYPE "bed_adhesion" AS ENUM ('none', 'skirt', 'brim', 'raft');

ALTER TABLE "print_runs"
  ADD COLUMN "nozzle_type"    "nozzle_type",
  -- Filament: which spool, and what it cost. A bare number with no currency
  -- column — a self-hosted instance has one owner and therefore one currency.
  ADD COLUMN "filament_brand" text,
  ADD COLUMN "color_name"     text,
  ADD COLUMN "filament_cost"  numeric(10, 2),
  -- Slicer settings.
  ADD COLUMN "infill_percent" smallint,
  ADD COLUMN "wall_count"     smallint,
  ADD COLUMN "supports"       boolean,
  ADD COLUMN "adhesion"       "bed_adhesion",
  ADD COLUMN "nozzle_temp_c"  smallint,
  ADD COLUMN "bed_temp_c"     smallint,
  ADD COLUMN "slicer_name"    text,
  ADD COLUMN "slicer_version" text,
  -- The named profile inside the slicer, e.g. "0.20mm Standard @BBL X1C".
  ADD COLUMN "slicer_profile" text;

-- No index. These are display fields: they are read as part of a row already
-- found by print_runs_model_idx, never searched on. An index per column would
-- cost every insert and buy nothing.
