-- #424 phase 5: the Projects v2 board URL a person pasted, shown back on the
-- settings page. Nullable; the previous image never reads it.
ALTER TABLE "project_tracker_routes" ADD COLUMN "board_url" TEXT;
