module "cloud_storage" {
  source = "./modules/cloud-storage"
  count  = var.create_cloud_storage ? 1 : 0

  project_id   = var.project_id
  region       = local.gcp_region_key
  environment  = var.environment
  project_name = var.project_name

  buckets = var.cloud_storage_buckets

  # Read through the GRANT, not the key: the bucket create must wait for the service agent to hold
  # the key, or Cloud Storage refuses the bucket ("permission denied on Cloud KMS key"). Null when no
  # bucket asked for CMEK, which the module never reads in that case.
  cmek_key_name = one(google_kms_crypto_key_iam_member.storage[*].crypto_key_id)

  labels = local.gcp_default_labels
}

# ── Bucket encryption with your own key (CMEK, #5532) ───────────────────────────────────────────
#
# The knob is the ITEM attribute `cloud_storage_buckets[*].cmek_enabled`, not a root switch: the
# console's bucket passthrough is item-shaped (`mergeItemProviderConfig` in buildGCSBuckets,
# packages/core/cloud/gcp_provider.go), so a root variable attributed to `bucket` could never be set
# from a bucket's provider_config. Encryption is per bucket on GCS anyway, so only the buckets that
# ask get the key; one key serves all of them.
#
# Off for every bucket by default, which plans no key, no grant and no ring (unless GKE Secrets
# encryption already made one), and no `encryption` block on any bucket.
locals {
  storage_cmek = var.create_cloud_storage && anytrue([for b in var.cloud_storage_buckets : b.cmek_enabled])
}

# The Cloud Storage service agent — the principal that actually calls Cloud KMS when a CMEK bucket
# reads or writes an object. Read through the data source rather than composed from the project
# number: the agent is created lazily, and this read is what creates it, so the grant below never
# names an account that does not exist yet.
data "google_storage_project_service_account" "gcs" {
  count   = local.storage_cmek ? 1 : 0
  project = var.project_id
}

# In the project's one key ring (secrets-encryption.tf), which is regional: a CMEK bucket must be in
# the key's location, and `terraform_data.storage_cmek_location_guard` below refuses at plan a CMEK
# bucket whose `location` is elsewhere.
resource "google_kms_crypto_key" "storage" {
  count = local.storage_cmek ? 1 : 0

  name     = "gcs-buckets"
  key_ring = one(google_kms_key_ring.gke_secrets[*].id)
  purpose  = "ENCRYPT_DECRYPT"

  # 90 days. New objects are written under the new primary version; existing objects stay readable
  # because Cloud KMS keeps the old versions.
  rotation_period = "7776000s"

  # Turning cmek_enabled off on EVERY bucket takes this key's count to 0, and destroying a crypto key
  # in tofu schedules all of its versions for destruction — after which objects written under it can
  # never be read again. 30 days (the Cloud KMS maximum is 120) is pinned explicitly, rather than left
  # to the API default, so the recovery window is a stated property of the template: a version
  # scheduled for destruction can be restored until it ends. The docs page says this in full.
  #
  # Cloud KMS never deletes a key or a key ring, so after that count-to-0 the `gcs-buckets` key (and,
  # with no GKE Secrets encryption, the ring) still exist under fixed names, and turning cmek_enabled
  # back on 409s (AlreadyExists). Not made sticky: there is no input that remembers "was ever on"
  # without a new always-present resource, which would move every project's default plan. The docs
  # callout states the consequence instead.
  destroy_scheduled_duration = "2592000s"
}

# The ONE grant this feature makes, scoped to the ONE key. Not a project-level binding: #300 removed
# setIamPolicy on the project from the provisioner, so a project-scoped grant would 403 at apply, and
# it would also let the agent use every key in the project.
resource "google_kms_crypto_key_iam_member" "storage" {
  count = local.storage_cmek ? 1 : 0

  crypto_key_id = one(google_kms_crypto_key.storage[*].id)
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${one(data.google_storage_project_service_account.gcs[*].email_address)}"
}

# The key ring is regional (local.gcp_region_key), and Cloud Storage requires a CMEK bucket to be in
# its key's location. A CMEK bucket with its own `location` elsewhere (a multi-region such as "US",
# or another region) would be refused at apply. Refused at plan instead, naming the bucket.
locals {
  storage_cmek_misplaced = var.create_cloud_storage ? [
    for b in var.cloud_storage_buckets : b.name_suffix
    if b.cmek_enabled && lower(coalesce(b.location, local.gcp_region_key)) != lower(local.gcp_region_key)
  ] : []
}

resource "terraform_data" "storage_cmek_location_guard" {
  count = local.storage_cmek ? 1 : 0

  lifecycle {
    precondition {
      condition     = length(local.storage_cmek_misplaced) == 0
      error_message = "cmek_enabled bucket(s) ${join(", ", local.storage_cmek_misplaced)} are not in ${local.gcp_region_key}, where the bucket key lives. Cloud Storage requires the key and the bucket in the same location. Leave location unset or set it to ${local.gcp_region_key}, or turn cmek_enabled off."
    }
  }
}
