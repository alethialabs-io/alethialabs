-- Enable Supabase Realtime on provision_jobs so the frontend can subscribe
-- to status changes instead of polling.
ALTER PUBLICATION supabase_realtime ADD TABLE public.provision_jobs;
