module "vpc_network" {
  source = "./modules/vpc-network"
  count  = var.provision_network ? 1 : 0

  project_id   = var.project_id
  region       = local.gcp_region_key
  environment  = var.environment
  project_name = var.project_name

  network_cidr     = var.network_cidr
  gke_cluster_name = local.gke_name

  pod_ip_range     = var.pods_cidr_range
  service_ip_range = var.services_cidr_range

  single_cloud_nat = var.single_cloud_nat

  labels = local.gcp_default_labels
}
