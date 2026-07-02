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

  network_name          = var.provision_network ? module.vpc_network[0].network_name : data.google_compute_network.existing[0].name
  subnet_name           = var.provision_network ? module.vpc_network[0].private_subnet_name : data.google_compute_subnetwork.existing[0].name
  pod_ip_range_name     = var.provision_network ? module.vpc_network[0].pod_ip_range_name : local.existing_pods_range_name
  service_ip_range_name = var.provision_network ? module.vpc_network[0].service_ip_range_name : local.existing_services_range_name

  machine_types     = var.gke_instance_types
  node_min_size     = var.gke_node_min_size
  node_max_size     = var.gke_node_max_size
  node_desired_size = var.gke_node_desired_size
  disk_size_gb      = var.gke_disk_size_gb
  disk_type         = var.gke_disk_type

  master_authorized_cidr_blocks = var.gke_master_authorized_cidr_blocks

  labels = local.gcp_default_labels
}
