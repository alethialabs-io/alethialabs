-- Enable full replica identity so UPDATE events include all columns
-- (not just the primary key). Required for realtime notifications.
ALTER TABLE public.provision_jobs REPLICA IDENTITY FULL;
