-- Add new integration categories and auth methods for observability, registry, DNS, and secrets integrations
-- Enum additions must be committed before they can be referenced, so this migration only extends the enums.

ALTER TYPE public.integration_category ADD VALUE IF NOT EXISTS 'observability';
ALTER TYPE public.integration_category ADD VALUE IF NOT EXISTS 'registry';
ALTER TYPE public.integration_category ADD VALUE IF NOT EXISTS 'dns';
ALTER TYPE public.integration_category ADD VALUE IF NOT EXISTS 'secrets';

ALTER TYPE public.integration_auth_method ADD VALUE IF NOT EXISTS 'api_key';
