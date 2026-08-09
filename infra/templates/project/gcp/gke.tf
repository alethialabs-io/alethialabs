module "gke" {
  source = "./modules/gke"
  count  = var.provision_gke ? 1 : 0

  # The IAM binding is a HARD dependency, not an ordering preference: GKE performs the envelope
  # encryption as its own service agent, and a cluster create against a key it cannot yet use fails
  # outright. Without this, whether the cluster comes up depends on which resource tofu happens to
  # finish first (#2004).
  depends_on = [module.vpc_network, google_kms_crypto_key_iam_member.gke_secrets]

  secrets_kms_key_id = local.gke_secrets_encryption ? google_kms_crypto_key.gke_secrets[0].id : ""

  project_id  = var.project_id
  region      = var.region
  environment = var.environment

  cluster_name     = local.gke_name
  node_pool_name   = local.gke_node_pool_name
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

  # Boot-disk performance (aws parity: eks_volume_iops). Both null by default; the module renders no
  # `boot_disk` block at all in that case, so the default plan is unchanged.
  volume_iops       = var.gke_volume_iops
  volume_throughput = var.gke_volume_throughput

  # Interruptible capacity (aws parity: eks_ng_capacity_type). gke_spot and gke_preemptible were
  # BOTH declared and read by nothing before this line — gke_spot at `default = true`, so the
  # template claimed Spot for every node pool it has ever built. Its default is flipped to false in
  # the same commit (variables.tf) precisely so that wiring it changes nothing that already exists.
  spot        = var.gke_spot
  preemptible = var.gke_preemptible

  master_authorized_cidr_blocks = var.gke_master_authorized_cidr_blocks

  labels = local.gcp_default_labels
}
