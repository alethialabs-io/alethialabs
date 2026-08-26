<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Velero

## There is no `hetzner.yaml`, and that is a ceiling rather than an omission

Velero's `provider` knob is `aws | gcp | azure` — those are the object-store plugins velero ships.
Hetzner Object Storage is S3-compatible, but the catalog does not offer an S3-compatible-endpoint
option, so there is **no valid selection** on hetzner: not a missing credential, a missing choice.

Recorded here so nobody spends a run rediscovering it, and so the absence of the file reads as a fact
rather than as work somebody forgot.

## Every file here is deliberately incomplete

`cloud` — the plugin's credentials file — is a secret. It is stored encrypted at rest and mounted
from a runner-seeded Secret, and it does not belong in a repository. Set it in the configure form.
