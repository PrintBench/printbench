-- Marking a queued request "printed" now records it in the print history.
--
-- Without this the two halves disagree: a request could be marked printed
-- against a linked model and that model would still report "never printed",
-- which is not a cosmetic gap — the never-printed search facet and the
-- per-model success rate are both built on print_runs.
--
-- The link is kept rather than fired and forgotten, so the history entry can
-- be withdrawn again if the request is reopened. ON DELETE SET NULL because
-- deleting the print run by hand from the model page is a legitimate thing to
-- do, and it should not take the request with it.
ALTER TABLE "print_requests"
  ADD COLUMN "print_run_id" uuid REFERENCES "print_runs"("id") ON DELETE SET NULL;

-- Only ever looked up from a request that has one, and most never will.
CREATE INDEX "print_requests_print_run_idx" ON "print_requests" ("print_run_id")
  WHERE "print_run_id" IS NOT NULL;
