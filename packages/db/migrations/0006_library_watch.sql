-- Optional live filesystem watching, per library.
--
-- Off by default: recursive watching burns one inotify watch per directory
-- and blows past fs.inotify.max_user_watches on a large library, so this is
-- an opt-in on top of the scan schedule, not a replacement for it.
ALTER TABLE "libraries" ADD COLUMN "watch_enabled" boolean NOT NULL DEFAULT false;
