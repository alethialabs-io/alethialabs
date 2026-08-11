locals {
  # The hostnames the platform actually serves on the GKE Ingress's load balancer. Today that is
  # exactly one: the ArgoCD Ingress installArgoCD renders at argocd.<domain>. Add a name here when
  # — and only when — something starts serving it AND external-dns publishes a record for it. A
  # name on a Google-managed certificate that resolves nowhere does not degrade gracefully: it
  # holds the entire certificate in FAILED_NOT_VISIBLE and takes every working name down with it.
  #
  # The apex is deliberately absent for exactly that reason. This template creates a zone and a
  # certificate and NO record sets, so the apex would never resolve, and `allow-http: "false"` on
  # the Ingress means there is no plaintext fallback to serve in the meantime.
  #
  # Derived HERE rather than inside the module so `tofu test` can assert on it: `assert` reads
  # `local.`, but cannot reach a module's internals without an output.
}

module "cloud_dns" {
  source = "./modules/cloud-dns"
  count  = var.cloud_dns_enabled && var.dns_provider == "native" ? 1 : 0

  project_id   = var.project_id
  environment  = var.environment
  project_name = var.project_name

  # Always the derived name. `cloud_dns_zone_name` now means ONE thing — the zone the CALLER
  # BROUGHT — and a brought zone leaves this module absent entirely (count 0), so the old
  # `var.cloud_dns_zone_name != "" ? … : local.cloud_dns_name` ternary was not merely dead, it was
  # the bug: it is how a zone id supplied to ATTACH to became the NAME of a second zone we created
  # (#2294). Azure settled the same ambiguity the same way in #1992 — the variable carries a brought
  # zone and nothing else.
  zone_name = local.cloud_dns_name
  domain    = var.cloud_dns_domain


  labels = local.gcp_default_labels
}
