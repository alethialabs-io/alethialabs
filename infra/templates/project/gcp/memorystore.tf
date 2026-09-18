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
  # `memorystore_auth_enabled` is deliberately NOT threaded here: its root default (false) disagrees
  # with the module's (true), so a plain wire would turn Redis AUTH OFF on every instance whose
  # caller never set it. That one waits on a maintainer ruling (#4320).
  transit_encryption = var.memorystore_transit_encryption_mode == "SERVER_AUTHENTICATION"

  network_self_link = try(module.vpc_network[0].network_self_link, null) != null ? module.vpc_network[0].network_self_link : var.network_id

  labels = local.gcp_default_labels
}
