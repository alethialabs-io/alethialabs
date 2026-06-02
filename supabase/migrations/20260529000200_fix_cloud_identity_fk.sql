-- Fix FK on configurations table: allow SET NULL on cloud_identity delete
-- The original migration had no ON DELETE clause (defaults to RESTRICT),
-- blocking disconnection when configurations reference the identity.
ALTER TABLE public.configurations DROP CONSTRAINT IF EXISTS configurations_cloud_identity_id_fkey;
ALTER TABLE public.configurations ADD CONSTRAINT configurations_cloud_identity_id_fkey
  FOREIGN KEY (cloud_identity_id) REFERENCES public.cloud_identities(id) ON DELETE SET NULL;
