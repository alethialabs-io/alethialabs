<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# `local` project template — hermetic provisioning-E2E keystone

A local, in-tofu [`kind`](https://kind.sigs.k8s.io/) (Kubernetes-IN-Docker) cluster.
This template exists for ONE purpose: to drive the **real**
`packages/core/provisioner.RunDeployV2` spine end to end against a genuine
Kubernetes cluster — **with no cloud account and no cloud credentials** — so the
provisioning path is exercised on every capable machine and (later) in the
merge-queue.

## The spine it lights up

```
tofu plan -out
  -> verify.Evaluate (fail-closed gate)
  -> sign evidence receipt (sealed to the plan hash)
  -> tofu apply            <-- kind_cluster created here
  -> ExtractClusterName(outputs) != ""   <-- keyed on talos_cluster_name
       -> ConfigureKubeconfig            (reads the `kubeconfig` output)
       -> applyBootstrapManifests        (NO-OP: bootstrap_manifests == "")
       -> WaitClusterReady + WaitPodToAPIServer
       -> installArgoCD + infra services + add-ons
```

Because the runner discovers the cluster from a **hardcoded output-name allowlist**
(`eks_/gke_/aks_/talos_/ack_cluster_name`), this module emits its cluster under the
**`talos_*`** names and is driven as **`Provider="hetzner"`** (the Talos post-apply
path). That means the whole spine lights up with **zero `cloud_provider`-enum
surgery** — there is deliberately **no `local` CloudProvider value**.

## Outputs

| Output                   | Value                                             | Why                                                                                 |
| ------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `talos_cluster_name`     | `"<project>-<environment>"`                       | `ExtractClusterName` keys on it → the post-apply spine runs (non-empty = not skipped) |
| `talos_cluster_endpoint` | `https://127.0.0.1:<random-host-port>`            | `ExtractClusterEndpoint`                                                             |
| `kubeconfig` (sensitive) | kind's raw kubeconfig                             | `ConfigureKubeconfig` writes it and points `KUBECONFIG` at it                        |
| `bootstrap_manifests`    | `""` (empty)                                      | kind ships kindnet (its own CNI) → nothing to bootstrap; also exercises the empty-bootstrap NO-OP branch |

## Plan-out-safety

Like the Hetzner/Talos template, this module applies **no Kubernetes objects
in-tofu** and wires **no** kubernetes/helm/kubectl provider from the cluster's own
(known-after-apply) kubeconfig. The single `kind_cluster` resource's kubeconfig is a
known-after-apply **output** consumed by the runner post-apply. So `tofu plan -out`
(the runner's only path) resolves every provider at plan time —
`scripts/check-templates-plan-safe.sh` enforces this.

## Provider

Uses the [`tehcyx/kind`](https://registry.terraform.io/providers/tehcyx/kind)
provider (pinned `>= 0.9, < 1.0`), which **bundles** the kind toolchain (it does not
shell out to a `kind` binary) and creates the cluster against the local Docker
daemon at apply. Verified working in-tofu: `tofu apply` brings a single-node cluster
Ready in ~45s and `tofu destroy` removes it in ~2s.

## Running the E2E

The keystone test is `packages/core/provisioner/deploy_e2e_test.go` (build tag
`e2e_local`). It is OFF for bare `go test`/every-PR CI and ON where docker + tofu are
available:

```bash
# convenience wrapper (preflights docker/tofu/kubectl/helm, then runs the test)
scripts/e2e/provision-hermetic.sh

# or directly
cd packages/core
go test -tags=e2e_local ./provisioner/ -run TestE2ELocalKindProvisioning -v
```

A fast, **docker-free** companion — `TestE2EProvisionWiringClusterless` (untagged,
runs on every PR that has `tofu`) — proves the plan → verify → signed-receipt wiring
on a trivial `terraform_data` module without provisioning a cluster.

## Accepted-but-ignored variables

The module is driven through the Hetzner provider's `ProviderTfvars`, which emits a
Talos-shaped tfvars map. `variables.tf` therefore declares those inputs (region,
`*_cidr`, node counts, bucket/S3 knobs, …) even though a local kind cluster ignores
them — purely to keep a hetzner-driven `-var-file` free of "undeclared variable"
warnings. Only `project_name`, `environment`, `node_image`, and `wait_for_ready`
affect the cluster.
