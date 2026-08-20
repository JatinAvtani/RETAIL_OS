-- Adds notifications.read_at (the in-app notification centre) — deliberately separate from
-- resolved_at (the underlying condition cleared) and acted_at (a human took a genuine action),
-- confirmed with the user rather than reusing acted_at, since no notification_deliveries row
-- exists for in-app notifications until real per-channel delivery is built.
ALTER TABLE "notifications" ADD COLUMN "read_at" timestamp with time zone;
