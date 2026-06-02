-- Activate GCP integration (was 'coming_soon')
UPDATE public.integrations SET status = 'active' WHERE slug = 'gcp';
