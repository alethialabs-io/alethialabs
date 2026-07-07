<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# cloud — the provider seam

`CloudProvider` (`provider.go`) is the four-method contract every cloud implements so the
provisioner stays cloud-agnostic:

```go
type CloudProvider interface {
    Name() string
    RequiredCLIs() []string
    ProviderTfvars(config *types.ProjectConfig) map[string]interface{}
    ConfigureKubeconfig(ctx, config, outputs, stdout) error
}
```

`NewCloudProvider(provider)` wires `aws` / `gcp` / `azure`; the rest return "coming soon".

## Adding a cloud — the checklist

The provisioner (`provisioner/deploy.go` `RunDeployV2`) is ~95% cloud-agnostic. A new cloud
is these five edits — nothing in the deploy flow itself changes:

1. **CloudProvider impl + factory case.** Add `packages/core/cloud/<cloud>_provider.go`
   implementing the interface, and a `case "<cloud>"` in `NewCloudProvider`.

2. **Terraform template + outputs.** Add `infra/templates/project/<cloud>/` provisioning a
   Kubernetes cluster + backing services. It MUST emit:
   - `<engine>_cluster_name` + `<engine>_cluster_endpoint` (the cluster the runner targets),
   - a **workload-identity** binding for the external-dns KSA (`external-dns/external-dns-sa`)
     with **no static key**, and export the identity: e.g. `external_dns_service_account`
     (GCP GSA email) or `external_dns_client_id` (Azure MI client id). See
     `gcp/workload-identity.tf` / `azure/workload-identity.tf` for the pattern.
   Validate with `tofu validate` in the template dir.

3. **Runner credential activation.** Teach `apps/runner/internal/agent/runner.go` how to
   activate the cloud's credentials before `tofu` runs (AWS AssumeRole / GCP WIF / Azure
   federated identity).

4. **ArgoCD facts.** Add a `case "<cloud>"` to `argocd/infra_facts.go` `BuildFromOutputs`
   extracting the cluster + workload-identity outputs into a per-cloud block, and extend
   `DNSProvider()` with the external-dns provider value.

5. **ArgoCD templates.** Add the cloud's branch to `infra/templates/argocd/external-dns.yaml`
   (provider value + the SA annotation), and guard cloud-specific apps
   (`aws-load-balancer-controller.yaml`, `karpenter.yaml`, `storage-class-gp3.yaml`) so they
   render empty (→ skipped) on other clouds. Empty template output is dropped by
   `RenderApplications`, so "not applicable" == render nothing.

## The GitOps seam (why this is small now)

`argocd/infra_facts.go` used to be AWS/IRSA/EKS-hardcoded — the single blocker to GCP/Azure
deploying apps. It is now `Provider`-discriminated: common facts + a per-cloud
workload-identity block, extracted per provider in `BuildFromOutputs`. The ArgoCD templates
switch on `.Provider`, so external-dns gets the right service-account annotation
(`eks.amazonaws.com/role-arn` | `iam.gke.io/gcp-service-account` |
`azure.workload.identity/client-id`). `render_test.go` pins AWS-unchanged + GCP/Azure render.
