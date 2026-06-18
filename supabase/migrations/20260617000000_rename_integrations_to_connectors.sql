-- Rename the "integrations" registry to "connectors" for naming consistency with
-- the cloud connector feature. RENAME preserves all rows (seeded catalog), the
-- slug unique index, the RLS policy, and all enum values — no data migration.

ALTER TABLE public.integrations RENAME TO connectors;

ALTER TYPE public.integration_category    RENAME TO connector_category;
ALTER TYPE public.integration_auth_method RENAME TO connector_auth_method;
ALTER TYPE public.integration_status      RENAME TO connector_status;

ALTER POLICY "Authenticated users can view integrations" ON public.connectors
  RENAME TO "Authenticated users can view connectors";
