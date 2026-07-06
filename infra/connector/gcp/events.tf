# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Alethia near-real-time asset-inventory event forwarder (GCP). A Cloud Asset Inventory FEED publishes
# network/subnetwork changes to a Pub/Sub topic; a Cloud Function normalizes each change to Alethia's
# NormalizedCloudEvent contract and POSTs it to the console ingester (/api/cloud-events/gcp). Opt-in
# companion to the WIF connector; only normalized {kind, native_id, region, deleted} events leave the
# project — never credentials.
#
# NOTE: deploy/verify in a real GCP project (the Cloud Asset API + Cloud Functions API must be enabled).
# The console ingester + the normalized contract are live; this is the in-project forwarder half.

# project_id / pool_id / provider_id / service_account_name are declared in main.tf (same module).
variable "ingestion_url" {
  type        = string
  description = "Base URL of the Alethia console, e.g. https://app.alethialabs.io"
}
variable "ingestion_secret" {
  type      = string
  sensitive = true
}

resource "google_pubsub_topic" "asset_changes" {
  project = var.project_id
  name    = "alethia-asset-changes"
}

# Cloud Asset Inventory feed → Pub/Sub on VPC network + subnetwork changes.
resource "google_cloud_asset_project_feed" "networks" {
  project      = var.project_id
  feed_id      = "alethia-networks"
  content_type = "RESOURCE"
  asset_types = [
    "compute.googleapis.com/Network",
    "compute.googleapis.com/Subnetwork",
  ]
  feed_output_config {
    pubsub_destination {
      topic = google_pubsub_topic.asset_changes.id
    }
  }
}

# The forwarder source (normalizes a CAI change → POST). Packaged from ./forwarder/gcp.
data "archive_file" "forwarder" {
  type        = "zip"
  source_dir  = "${path.module}/forwarder"
  output_path = "${path.module}/.build/forwarder-gcp.zip"
}

resource "google_storage_bucket" "forwarder" {
  project                     = var.project_id
  name                        = "${var.project_id}-alethia-forwarder"
  location                    = "US"
  uniform_bucket_level_access = true
}

resource "google_storage_bucket_object" "forwarder" {
  name   = "forwarder-${data.archive_file.forwarder.output_md5}.zip"
  bucket = google_storage_bucket.forwarder.name
  source = data.archive_file.forwarder.output_path
}

resource "google_cloudfunctions2_function" "forwarder" {
  project  = var.project_id
  name     = "alethia-asset-forwarder"
  location = "us-central1"
  build_config {
    runtime     = "nodejs20"
    entry_point = "forward"
    source {
      storage_source {
        bucket = google_storage_bucket.forwarder.name
        object = google_storage_bucket_object.forwarder.name
      }
    }
  }
  service_config {
    available_memory = "256M"
    timeout_seconds  = 30
    environment_variables = {
      INGESTION_URL    = var.ingestion_url
      INGESTION_SECRET = var.ingestion_secret
      GCP_PROJECT_ID   = var.project_id
    }
  }
  event_trigger {
    trigger_region = "us-central1"
    event_type     = "google.cloud.pubsub.topic.v1.messagePublished"
    pubsub_topic   = google_pubsub_topic.asset_changes.id
  }
}
