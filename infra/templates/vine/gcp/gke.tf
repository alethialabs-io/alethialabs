module "gke" {
  source = "./modules/gke"
  count  = var.provision_gke ? 1 : 0

  depends_on = [module.vpc_network]

  project_id  = var.project_id
  region      = var.region
  environment = var.environment

  cluster_name     = local.gke_name
  cluster_version  = var.gke_cluster_version
  enable_autopilot = var.gke_enable_autopilot

  network_name          = var.provision_network ? module.vpc_network[0].network_name : var.network_id
  subnet_name           = var.provision_network ? module.vpc_network[0].private_subnet_name : ""
  pod_ip_range_name     = var.provision_network ? module.vpc_network[0].pod_ip_range_name : "pods"
  service_ip_range_name = var.provision_network ? module.vpc_network[0].service_ip_range_name : "services"

  machine_types     = var.gke_instance_types
  node_min_size     = var.gke_node_min_size
  node_max_size     = var.gke_node_max_size
  node_desired_size = var.gke_node_desired_size
  disk_size_gb      = var.gke_disk_size_gb
  disk_type         = var.gke_disk_type

  master_authorized_cidr_blocks = var.gke_master_authorized_cidr_blocks

  labels = local.gcp_default_labels
}
