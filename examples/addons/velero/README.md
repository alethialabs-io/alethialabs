<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Velero

## The hetzner ceiling is closed, and it was never a ceiling

This file used to say there was no `hetzner.yaml` because velero's `provider` knob is
`aws | gcp | azure` and Hetzner is none of those — "not a missing credential, a missing choice."

That confused the **plugin** with the **cloud**. `aws` is velero's S3 plugin, and it speaks the S3 API
to anything that does: upstream says so directly — *"Velero's AWS Object Store plugin uses Amazon's
Go SDK to connect to the AWS S3 API. Some third-party storage providers also support the S3 API"*
([supported providers](https://velero.io/docs/v1.14/supported-providers/)). Hetzner Object Storage is
one of them, and this repository already drives it over S3 in `scripts/e2e/hcloud-cleanup.sh`.

What was genuinely missing was somewhere to put the **endpoint**. `s3Url` and `s3ForcePathStyle` are
now knobs, so `hetzner.yaml` and `alibaba.yaml` exist. Two things do not come with them, and both are
recorded rather than papered over:

- **No volume snapshots.** An S3 endpoint is a bucket, not a disk-snapshot API. The catalog does not
  emit a `VolumeSnapshotLocation` when `s3Url` is set, and both files turn the node-agent on because
  file-level backup is then the only way volume data leaves the cluster.
- **`alibaba.yaml` is derived, not measured.** It follows Alibaba's published S3-compatibility
  contract (including *path-style requests are denied*, so `s3ForcePathStyle` must stay false). No
  Alethia run has exercised it.

## The chart needs a plugin, and the catalog now installs one

The velero chart ships `initContainers: []` and says in its own values file that *at least one plugin
provider image is required*. The catalog set none. So every velero installed from this marketplace
before that fix came up with no object-store plugin at all — a `velero server` that cannot reach S3,
GCS or Blob, reporting **Healthy** the whole time because its probes are an HTTP GET on `/metrics`.

The plugin is now derived from `provider` and pinned (`v1.10.1`, which is what upstream's
compatibility table pairs with the velero `v1.14.1` this chart runs). Nothing to configure.

## The bucket is yours, deliberately

Alethia does not create the backup bucket, and that is a decision rather than an omission. The project
template's buckets are canvas nodes inside the cluster's OpenTofu state, so `tofu destroy` takes them
with it — and a backup store whose lifetime is the lifetime of the thing it backs up restores nothing
on the one day it matters. Point velero at a bucket you own.

Leaving `bucket` empty is a supported state: velero installs, runs, and takes no backups until you
give it a location. That is now literally true — it used to render a `BackupStorageLocation` with a
null `provider`, which the CRD rejects, so the whole Application failed to sync.

## Every file here is deliberately incomplete

`cloud` — the plugin's credentials file — is a secret. It is stored encrypted at rest and mounted
from a runner-seeded Secret, and it does not belong in a repository. Set it in the configure form.
