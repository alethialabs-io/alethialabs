-- 0120 data migration (hand-authored): remove the `prometheus` connector.
-- Prometheus as a "connector" installed in-cluster Prometheus — that is the
-- `kube-prometheus-stack` add-on's job, not a connector (a stored credential to
-- an external system Alethia acts through). We reset any project that had
-- selected it back to native/none, then delete the seeded catalog row. The
-- `connector_credentials.connector_id` FK is ON DELETE CASCADE, so deleting the
-- catalog row automatically removes any orphaned prometheus credential rows.

UPDATE project_observability
SET provider = NULL, enabled = false, provider_config = NULL
WHERE provider = 'prometheus';
--> statement-breakpoint
DELETE FROM connectors WHERE slug = 'prometheus';
