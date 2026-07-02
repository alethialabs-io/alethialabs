# Brownfield networking: when `provision_network = false`, attach GKE to an EXISTING VPC network instead
# of creating one. The console sends `network_id` (the network's name or self-link); we data-source the
# network, resolve the subnetwork that lives in `var.region` (subnet self-links embed the region), and
# read that subnet's pod/service secondary-range names — mirroring how the AWS template consumes an
# existing VPC + its subnets. Greenfield (provision_network = true) is untouched: these data sources have
# count = 0 and the `module.vpc_network` seam is used as before.
#
# NOTE: verify against a real GKE + existing network. Assumption: the existing network has one subnetwork
# per region, with pod/service secondary ranges (matched by name, else by order).

data "google_compute_network" "existing" {
  count   = var.provision_network ? 0 : 1
  name    = var.network_id
  project = var.project_id
}

locals {
  # The existing network's subnetwork in this region (self-links look like
  # .../regions/<region>/subnetworks/<name>).
  existing_subnet_self_link = var.provision_network ? "" : try(
    [
      for s in data.google_compute_network.existing[0].subnetworks_self_links : s
      if length(regexall("/regions/${var.region}/", s)) > 0
    ][0],
    "",
  )
}

data "google_compute_subnetwork" "existing" {
  count     = var.provision_network ? 0 : 1
  self_link = local.existing_subnet_self_link
}

locals {
  existing_secondary = var.provision_network ? [] : data.google_compute_subnetwork.existing[0].secondary_ip_range

  # GKE needs the pod + service secondary-range NAMES. Match by name, else fall back to declared order.
  existing_pods_range_name = var.provision_network ? "pods" : try(
    [for r in local.existing_secondary : r.range_name if length(regexall("pod", lower(r.range_name))) > 0][0],
    try(local.existing_secondary[0].range_name, "pods"),
  )
  existing_services_range_name = var.provision_network ? "services" : try(
    [for r in local.existing_secondary : r.range_name if length(regexall("svc|service", lower(r.range_name))) > 0][0],
    try(local.existing_secondary[1].range_name, "services"),
  )
}
