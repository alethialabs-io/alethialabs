-- Activate Azure integration (was 'coming_soon')
UPDATE public.integrations SET status = 'active' WHERE slug = 'azure';
