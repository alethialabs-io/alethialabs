<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Keyless OCI ECR Helm chart-repo — parity & e2e board

Living status for the **keyless OCI ECR Helm chart-repo** feature (`oci-ecr` / `oci-public-ecr` — pull
Helm charts from an Amazon ECR (private, cross-account) or ECR Public registry with **no stored key**).
It is the `helm_registry` analogue of the cross-account image-pull registry
([`xacct-registry-parity.md`](./xacct-registry-parity.md)): ECR issues a ~12h token, so no static ArgoCD
repo credential can back it. The token is minted in-cluster from a Workload Identity by
`alethia helm-repo-token` and patched into the `repo-helm-<hash>` ArgoCD repo-cred Secret (in the
`argocd` namespace). Issue: **#1185** (follow-up to `#926`).

**Key differences from the image side:** Helm registries are a **list** (a project may connect several
ECR chart repos) — not a single dominant registry — so the collector is plural
(`categories.KeylessHelmRepoTargets`) and one refresher Deployment is rendered per repo, all sharing one
KSA (`argocd:alethia-helm-repo-pull`). The patched Secret is an Opaque ArgoCD `repo-creds` (`type: helm`,
`username=AWS`, `password=<token>`), **not** a `.dockerconfigjson`.

Legend: ✅ done/green · ⏳ pending · 🚫 blocked (reason) · — n/a

## Parity matrix (feature × cloud)

| Cloud | Catalog+model | Refresher mint | Tofu pull role | Wiring | **Real mint e2e** | **In-cluster e2e** | Security-reviewed |
|-------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **AWS — ECR** (`oci-ecr`) | ✅ | ✅ | ✅ | ✅ | ⏳ | ⏳ | ⏳ |
| **AWS — ECR Public** (`oci-public-ecr`) | ✅ | ✅ | ✅ | ✅ | ⏳ | ⏳ | ⏳ |
| GCP / Azure / Alibaba / Hetzner | — | — | — | — | — | — | — |

- **Non-AWS is n/a, not an exclusion:** ECR / ECR Public are **AWS-only services**. There is no non-AWS
  OCI-Helm-from-ECR analogue to build, so this is not a documented cloud-parity gap ([[cloud-parity-rule]])
  — it is simply out of scope for other clouds. (A GCP Artifact-Registry / Azure ACR OCI-Helm keyless path
  would be its own feature, mirroring `gar-xacct` / `acr-xacct`.)
- **Real mint e2e** = `mintECRAuth` / `mintECRPublicAuth` run against a live ECR, token proven to pull a
  chart, with local ambient creds — no cluster.
- **In-cluster e2e** = full path: tofu `helm-repo-pull` IRSA → the refresher Deployment's KSA mints **with
  no local creds** → patches the `repo-helm-<hash>` Secret → an ArgoCD Application whose repoURL is
  `oci://<ecr-host>` syncs a private chart. Main-gated (T2 harness), `ALETHIA_XACCT_HELM_ECR_ENABLED=1`.

## What's left

- [ ] **Real mint + in-cluster e2e** — main-gated; prove a private ECR chart and an ECR-Public chart both
      sync via the refresher on a live EKS cluster against a second AWS account.
- [ ] **`alethia-security-review`** — required before shipping (keyless cross-account, fail-closed render,
      token handling). See focus list below.
- [ ] **Flip `coming_soon` → `active`** on the two catalog rows + default `ALETHIA_XACCT_HELM_ECR_ENABLED`
      on in prod — **only after** the in-cluster e2e is green (maintainer action). Rows stay `coming_soon`
      in the implementation PR, matching the image `ecr-xacct` precedent (never expose a selectable-but-
      non-functional connector).

## Security-review focus

- **Keyless cross-account trust** — the cluster IRSA (`helm-repo-pull.tf`) grants ONLY `sts:AssumeRole` on
  the exact target-role list, plus `ecr-public:GetAuthorizationToken` when a public repo is connected. KSA
  binding is `argocd:alethia-helm-repo-pull` only; each refresher Role is `get`+`patch` on exactly its one
  Secret (no create/list/delete/wildcard).
- **Token handling** — the token only ever lives in a 0600 `kubectl patch --patch-file`; never on argv,
  logs, `config_snapshot`, or a git-committed manifest (the placeholder Secret ships an empty password).
  `kubectl patch` (not apply) so no create permission is needed.
- **Fail-closed render** — a missing `helm_repo_pull_irsa_arn` output, an empty provider_config, or an
  empty target list renders nothing and reports a secret-free skip.
- **Fixed public host** — ECR / ECR Public mint via the AWS SDK (no token POSTed to a config-supplied
  host, unlike ACR), and the public host is fixed to `public.ecr.aws` (never taken from provider_config).
