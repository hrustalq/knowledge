-- Chat search links (#407): the Time/Mattermost team a bound channel is in, so
-- a hit links to its thread with no platform call at search time. NULL = not
-- resolved yet (the next kept message resolves it), '' = in no team.
-- Nullable and additive: the previous release ignores the column, so this survives a rollback.
ALTER TABLE "chat_channel_bindings" ADD COLUMN "team_name" TEXT;
