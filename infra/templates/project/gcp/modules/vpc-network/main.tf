terraform {
  required_version = ">= 1.3"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }
}

locals {
  network_name       = "${var.project_name}-${var.environment}-vpc"
  private_subnet     = "${var.project_name}-${var.environment}-private"
  public_subnet      = "${var.project_name}-${var.environment}-public"
  router_name        = "${var.project_name}-${var.environment}-router"
  nat_name           = "${var.project_name}-${var.environment}-nat"
  pod_range_name     = "${var.gke_cluster_name}-pods"
  service_range_name = "${var.gke_cluster_name}-services"

  # Derive a public subnet CIDR that doesn't overlap with the private subnet.
  # Uses the first /24 from 10.3.0.0/16 by default (assumes network_cidr is 10.0.0.0/16).
  public_subnet_cidr = cidrsubnet("10.3.0.0/16", 8, 0)

  merged_labels = merge(var.labels, {
    environment = var.environment
    project     = var.project_name
    managed-by  = "opentofu"
  })
}

################################################################################
# VPC Network
################################################################################

resource "google_compute_network" "vpc" {
  name                    = local.network_name
  project                 = var.project_id
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

################################################################################
# Subnets
################################################################################

resource "google_compute_subnetwork" "private" {
  name                     = local.private_subnet
  project                  = var.project_id
  region                   = var.region
  network                  = google_compute_network.vpc.self_link
  ip_cidr_range            = var.network_cidr
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = local.pod_range_name
    ip_cidr_range = var.pod_ip_range
  }

  secondary_ip_range {
    range_name    = local.service_range_name
    ip_cidr_range = var.service_ip_range
  }

  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_subnetwork" "public" {
  name          = local.public_subnet
  project       = var.project_id
  region        = var.region
  network       = google_compute_network.vpc.self_link
  ip_cidr_range = local.public_subnet_cidr
}

################################################################################
# Cloud Router + Cloud NAT
################################################################################

resource "google_compute_router" "router" {
  name    = local.router_name
  project = var.project_id
  region  = var.region
  network = google_compute_network.vpc.self_link

  bgp {
    asn = 64514
  }
}

resource "google_compute_router_nat" "nat" {
  name                               = local.nat_name
  project                            = var.project_id
  region                             = var.region
  router                             = google_compute_router.router.name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  # When single_cloud_nat is true, use NO_AUTO_ONLY endpoint type to restrict
  # to a single NAT. When false, the default gives one mapping per zone.
  endpoint_types = ["ENDPOINT_TYPE_VM"]

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

################################################################################
# Firewall Rules
################################################################################

resource "google_compute_firewall" "allow_internal" {
  name    = "${local.network_name}-allow-internal"
  project = var.project_id
  network = google_compute_network.vpc.self_link

  direction = "INGRESS"
  priority  = 1000

  allow {
    protocol = "tcp"
    ports    = ["0-65535"]
  }

  allow {
    protocol = "udp"
    ports    = ["0-65535"]
  }

  allow {
    protocol = "icmp"
  }

  source_ranges = [
    var.network_cidr,
    var.pod_ip_range,
    var.service_ip_range,
  ]

  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_firewall" "allow_health_checks" {
  name    = "${local.network_name}-allow-health-checks"
  project = var.project_id
  network = google_compute_network.vpc.self_link

  direction = "INGRESS"
  priority  = 1000

  allow {
    protocol = "tcp"
  }

  # Google Cloud health check probe ranges
  # https://cloud.google.com/load-balancing/docs/health-check-concepts#ip-ranges
  source_ranges = [
    "35.191.0.0/16",
    "130.211.0.0/22",
  ]

  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}
