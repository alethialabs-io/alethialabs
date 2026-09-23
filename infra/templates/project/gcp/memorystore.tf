module "memorystore" {
  source = "./modules/memorystore"
  count  = var.create_memorystore ? 1 : 0

  depends_on = [module.vpc_network]

  project_id   = var.project_id
  region       = local.gcp_region_key
  environment  = var.environment
  project_name = var.project_name

  tier           = var.memorystore_tier
  memory_size_gb = var.memorystore_memory_size_gb
  redis_version  = var.memorystore_redis_version

  # In-transit TLS. Declared at the root as the API's enum and threaded nowhere before #4320, so the
  # module's `false` always won. The root default ("DISABLED") maps to that same `false`, so wiring
  # it changes no existing instance; the root variable's validation rejects any other spelling.
  #
  transit_encryption = var.memorystore_transit_encryption_mode == "SERVER_AUTHENTICATION"

  # Redis AUTH. Also threaded nowhere before #4320, and the one knob in that batch where the two
  # ends DISAGREED: root `false`, module `true`. Because nothing threaded it, the module's `true`
  # is what every Memorystore instance is actually running, and a plain wire would have turned AUTH
  # OFF on every instance whose caller never set the knob.
  #
  # Resolved by moving the ROOT default to `true` (the maintainer's ruling on #4320: a knob that
  # governs security takes the secure default), not by leaving the wire out. Both ends now say
  # `true`, so no deployed instance changes, and a caller who explicitly sets `false` finally gets
  # the thing they asked for instead of silently getting AUTH.
  auth_enabled = var.memorystore_auth_enabled

  network_self_link = try(module.vpc_network[0].network_self_link, null) != null ? module.vpc_network[0].network_self_link : var.network_id

  labels = local.gcp_default_labels
}
