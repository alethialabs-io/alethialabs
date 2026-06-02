module "memorystore" {
  source = "./modules/memorystore"
  count  = var.create_memorystore ? 1 : 0

  depends_on = [module.vpc_network]

  project_id   = var.project_id
  region       = var.region
  environment  = var.environment
  project_name = var.project_name

  tier           = var.memorystore_tier
  memory_size_gb = var.memorystore_memory_size_gb
  redis_version  = var.memorystore_redis_version

  network_self_link = var.provision_network ? module.vpc_network[0].network_self_link : var.network_id

  labels = local.gcp_default_labels
}
