// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/k8s"
	"github.com/alethialabs-io/alethialabs/packages/core/telemetry"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// Persistent `vcluster`-placement exec (#1231, the activation half of the #960 vcluster epic). A vcluster
// env runs the customer's app on its OWN virtual control plane provisioned on the shared Fabric: this path
// mints keyless HOST access (same as the namespace path — the vcluster + its host ArgoCD live on the Fabric
// the console resolved), helm-installs the vcluster (VClusterProvisioner, vcluster.go), registers it with
// the host ArgoCD as a `cluster` Secret (argocd.EnsureVClusterClusterSecret, #1230), and delivers the app
// onto it via `destination.name = <VClusterName>` (argocd.RenderVClusterApp). Runs NO tofu.
//
// Like the namespace path it is a FULLY separate body from RunDeployV2's full-cluster path (the `dedicated`
// path stays byte-identical), and — because no cloud infrastructure is mutated — the tofu plan / verify
// gate / cost guard / evidence receipt do not apply (a vcluster deploy mutates only in-cluster objects on a
// Fabric that already passed the gate at ITS creation).
//
// The spec-derivation + provision sequencing live HERE in core (not runner-side) because core cannot import
// the runner and RunDeployV2 — the per-placement dispatch — is core. AWS-first, per-cloud parity
// fail-closed (vclusterRemintProviders), mirroring namespace.

const (
	// vclusterArgoNamespace is where ArgoCD runs on the Fabric — the host namespace the exported vcluster
	// kubeconfig Secret is written into (and where the cluster-registration Secret lives).
	vclusterArgoNamespace = "argocd"
	// vclusterHostNamespacePrefix / vclusterServiceAccountPrefix / vclusterKubeconfigSecretPrefix derive
	// the per-env resource names from the env's namespace. Distinct prefixes keep the control-plane host
	// namespace, the SA, and the exported Secret from colliding.
	vclusterHostNamespacePrefix    = "vcluster-"
	vclusterServiceAccountPrefix   = "vcluster-argocd-"
	vclusterKubeconfigSecretPrefix = "vcluster-kubeconfig-"
)

// vclusterRemintProviders is the allowlist of clouds whose OUTPUT-FREE keyless host re-mint is wired for
// `vcluster` placement — the SINGLE control that activates a cloud (selectPlacementPath routes vcluster
// here only for a cloud in this set; runVClusterDeploy fail-closes anything else). It mirrors
// namespaceRemintProviders because a vcluster runs ON the host Fabric cluster and reaches it exactly the
// way a namespace env does — EXCEPT vcluster needs no per-namespace identity, so a cloud is activatable
// here as soon as its host re-mint (the KubeConnResolver) is wired, ahead of the namespace tier.
//
//   - aws: EKS DescribeCluster (in-core, ambient) — ConfigureKubeconfig resolves from the name.
//
//   - gcp: GKE clusters.get via the runner-injected KubeConnResolver (mintGCPToken + ResolveGKEClusterConn);
//     project = CloudAccountID, location = Region (the shared cluster's region).
//
//   - azure: AKS ManagedClusters get/list + listClusterUserCredentials via the runner-injected resolver
//     (ARM token + ResolveAKSResourceGroup by name + ResolveAKSClusterConn); subscription = CloudAccountID.
//
//   - alibaba: ACK resolved output-free IN-CORE (like aws) — alibabaProvider.ConfigureKubeconfig builds
//     the keyless RRSA-signing http.Client (packages/core/cloud/alibaba_sign.go) and resolves the cluster
//     by name → ClusterId → a short-lived user kubeconfig (DescribeClusterUserKubeconfig). ACK embeds an
//     x509 client cert (no exec-plugin bearer), so it needs no KubeConnResolver (absent from
//     namespaceClusterConnKeys, like aws).
//
//   - hetzner: no cloud API to re-mint — the runner-injected TalosKubeconfigMinter mints a fresh kubeconfig
//     from the Fabric's PERSISTED talosconfig (delivered encrypted on the job claim), which mintClusterOutputs
//     hands to hetznerProvider.ConfigureKubeconfig under the `kubeconfig` key. vcluster needs no per-namespace
//     identity, so hetzner activates here identically to the namespace tier.
//
// Cloud parity is a hard rule: every gap is a documented, fail-closed exclusion, never silent.
// vclusterAppInput builds the vcluster delivery renderer's input from the config snapshot. Pure, for
// the same reason as namespaceTenantInput: it makes the AppsPath wiring assertable without a cluster.
func vclusterAppInput(vc *types.ProjectConfig, vcName, ns string) argocd.VClusterAppInput {
	return argocd.VClusterAppInput{
		Project:      vc.ProjectName,
		VClusterName: vcName,
		Namespace:    ns,
		AppsRepoURL:  vc.Repositories.AppsDestinationRepo,
		// Per-tier Kustomize overlay subpath. EMPTY ⇒ the renderer defaults to "." (the repo root).
		AppsPath: vc.Repositories.AppsPath,
		Labels:   cloud.ClassificationLabels(vc),
	}
}

var vclusterRemintProviders = map[string]bool{
	"aws":     true,
	"gcp":     true,
	"azure":   true,
	"alibaba": true,
	"hetzner": true,
}

// vclusterRemintWired reports whether provider's output-free host re-mint is activated for vcluster.
func vclusterRemintWired(provider string) bool { return vclusterRemintProviders[provider] }

// vclusterRemintNotWired is the fail-closed error for a cloud whose vcluster host re-mint isn't wired.
func vclusterRemintNotWired(provider string) error {
	return fmt.Errorf("vcluster placement: output-free keyless host re-mint is not wired for provider %q — activated for aws (EKS DescribeCluster), gcp (GKE clusters.get), azure (AKS ManagedClusters), alibaba (ACK DescribeClusterUserKubeconfig, keyless RRSA) and hetzner (Talos-API kubeconfig from the persisted talosconfig) today", provider)
}

// buildVClusterSpec derives the vcluster provisioning spec for a `vcluster`-placement env from its config
// snapshot. The env's Namespace is the ArgoCD destination.name (the registered virtual cluster's name);
// the control plane, SA, and exported Secret get deterministic per-env names off it. Fail-closed: returns
// an error (never a half-built spec) if the snapshot is missing the namespace or a derived name isn't a
// valid k8s identifier.
func buildVClusterSpec(vc *types.ProjectConfig) (VClusterSpec, error) {
	if vc == nil {
		return VClusterSpec{}, fmt.Errorf("vcluster: nil project config")
	}
	name := strings.TrimSpace(vc.Namespace)
	if name == "" {
		return VClusterSpec{}, fmt.Errorf("vcluster: no destination namespace on the config snapshot — a vcluster env needs a resolved namespace (its ArgoCD destination name)")
	}
	spec := VClusterSpec{
		Name:                name,
		HostNamespace:       vclusterHostNamespacePrefix + name,
		ServiceAccount:      vclusterServiceAccountPrefix + name,
		KubeconfigSecret:    vclusterKubeconfigSecretPrefix + name,
		KubeconfigNamespace: vclusterArgoNamespace,
		// APIServerURL "" + Expose false ⇒ the in-cluster ClusterIP Service address (on-host ArgoCD reach).
	}
	if err := spec.Validate(); err != nil {
		return VClusterSpec{}, err
	}
	return spec, nil
}

// vclusterPreflight checks the runner image carries the tooling the vcluster path shells out to.
func vclusterPreflight() error {
	if err := utils.CheckDependencies("helm", "kubectl"); err != nil {
		return fmt.Errorf("vcluster preflight failed (runner image missing tooling): %w", err)
	}
	return nil
}

// mintVClusterHostAccess mints keyless kube access to the EXISTING shared-Fabric HOST cluster by name,
// output-free (no tofu) — the same re-mint the namespace path uses (the vcluster + its ArgoCD live on the
// host). For a cloud whose ConfigureKubeconfig reads endpoint/CA from outputs, the runner-injected
// resolver supplies them (mintClusterOutputs). Fail-closed for any cloud not in vclusterRemintProviders
// (defence-in-depth behind selectPlacementPath).
func mintVClusterHostAccess(ctx context.Context, provider cloud.CloudProvider, resolver KubeConnResolver, talosMinter TalosKubeconfigMinter, config *types.ProjectConfig, providerSlug, clusterName string, stdout io.Writer) error {
	if !vclusterRemintWired(providerSlug) {
		return vclusterRemintNotWired(providerSlug)
	}
	nameKey, ok := namespaceClusterNameOutputKey[providerSlug]
	if !ok {
		return vclusterRemintNotWired(providerSlug)
	}
	mintOutputs, err := mintClusterOutputs(ctx, resolver, talosMinter, providerSlug, config, clusterName, nameKey)
	if err != nil {
		return err
	}
	return provider.ConfigureKubeconfig(ctx, config, mintOutputs, stdout)
}

// runVClusterDeploy deploys a `vcluster`-placement env: mint host access → provision the vcluster on the
// host Fabric → register it with the host ArgoCD → deliver the app onto it (destination.name). aws-first,
// fail-closed for un-wired clouds. Runs no tofu. Mirrors runNamespaceDeploy's structure.
func runVClusterDeploy(ctx context.Context, params DeployParams) (_ *PlanResult, retErr error) {
	vc := params.ProjectConfig

	stdout := params.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := params.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	// Reduced provisioning-stage spans (kube_configure → vcluster_provision → argocd), same pattern as
	// runNamespaceDeploy / RunDeployV2.
	var curSpan trace.Span
	setStage := func(name string) {
		if curSpan != nil {
			curSpan.End()
		}
		_, curSpan = telemetry.StartStage(ctx, name)
	}
	defer func() {
		if curSpan != nil {
			if retErr != nil {
				curSpan.RecordError(retErr)
				curSpan.SetStatus(codes.Error, retErr.Error())
			}
			curSpan.End()
		}
	}()

	// Belt-and-suspenders: selectPlacementPath already routed only a re-mint-wired cloud here.
	if !vclusterRemintWired(params.Provider) {
		return nil, unactivatedPlacementError(vc.PlacementMode, params.Provider)
	}

	// The serving (host Fabric) cluster + destination namespace must be resolved onto the snapshot by the
	// console. Fail closed if absent — never guess a cluster/namespace.
	hostCluster := strings.TrimSpace(vc.Cluster.ClusterName)
	if hostCluster == "" {
		return nil, fmt.Errorf("vcluster placement: no serving cluster on the config snapshot — the Fabric's cluster must be provisioned (a 'dedicated' env owning the Fabric) before a vcluster env can be placed onto it")
	}
	ns := strings.TrimSpace(vc.Namespace)
	if ns == "" {
		return nil, fmt.Errorf("vcluster placement: no destination namespace on the config snapshot")
	}

	// Defense-in-depth: both values flow into shell commands (kubectl/helm via bash -c) and rendered
	// manifests. The console derives them, but the RUNNER is the trust boundary for a (project-data-
	// influenced) snapshot — fail closed on anything that isn't a strict DNS-1123 label / valid cluster
	// name so a malformed or hostile value can never inject a shell command or break a manifest.
	if !isDNS1123Label(ns) {
		return nil, fmt.Errorf("vcluster placement: destination namespace %q is not a valid DNS-1123 label", ns)
	}
	if !isValidClusterName(hostCluster) {
		return nil, fmt.Errorf("vcluster placement: serving cluster name %q contains invalid characters", hostCluster)
	}
	// Same trust-boundary argument for the apps-repo subpath: it is project data that ends up in the
	// vcluster Application's source.path. Reject it HERE — before helm-installing a virtual cluster
	// on the shared Fabric — rather than at render time. Empty is valid and means the repo root.
	if err := argocd.ValidateAppsPath(vc.Repositories.AppsPath); err != nil {
		return nil, fmt.Errorf("vcluster placement: %w", err)
	}

	spec, err := buildVClusterSpec(vc)
	if err != nil {
		return nil, err
	}

	provider, err := cloud.NewCloudProvider(params.Provider)
	if err != nil {
		return nil, err
	}

	fmt.Fprintf(stdout, "vcluster placement: provisioning virtual cluster %q on existing shared Fabric cluster %q (provider: %s).\n", spec.Name, hostCluster, provider.Name())

	var result PlanResult
	result.ClusterName = spec.Name

	// Plan job: a vcluster placement provisions no cloud infrastructure (no tofu), so there is nothing to
	// plan/verify/price. Report the resolved target and return.
	if params.DryRun {
		fmt.Fprintf(stdout, "Dry-run (plan): vcluster placement provisions no cloud infrastructure — at deploy, the vcluster %q is helm-installed on cluster %q, registered with ArgoCD, and the app delivered onto it.\n", spec.Name, hostCluster)
		return &result, nil
	}

	if err := vclusterPreflight(); err != nil {
		return nil, err
	}

	// Keyless host access to the EXISTING named Fabric cluster, output-free (no tofu). Then a cheap
	// API-reachability probe so a wrong Fabric/region fails honestly here rather than as a later helm error.
	setStage("kube_configure")
	if err := mintVClusterHostAccess(ctx, provider, params.KubeConn, params.TalosKubeconfig, vc, params.Provider, hostCluster, stdout); err != nil {
		return nil, fmt.Errorf("kubeconfig mint failed for existing host cluster %q — the vcluster env is placed on a Fabric whose cluster is unreachable: %w", hostCluster, err)
	}
	if err := k8s.WaitClusterReady(ctx, clusterReadyTimeout(), false, stdout); err != nil {
		return nil, fmt.Errorf("existing host cluster %q unreachable after minting kube access: %w", hostCluster, err)
	}
	result.ClusterReady = true

	// Provision the vcluster on the host Fabric (helm + exportKubeConfig), then wait for its control plane.
	setStage("vcluster_provision")
	prov := NewVClusterProvisioner()
	if err := prov.Create(ctx, spec, stdout, stderr); err != nil {
		return &result, fmt.Errorf("failed to create vcluster %q: %w", spec.Name, err)
	}
	if err := prov.WaitReady(ctx, spec, clusterReadyTimeout(), stdout, stderr); err != nil {
		return &result, fmt.Errorf("vcluster %q control plane not ready: %w", spec.Name, err)
	}

	// Register the vcluster with the host ArgoCD as a `cluster` Secret named spec.Name, reading the
	// exported kubeconfig Secret (#1230). ArgoCD needs this BEFORE the app can sync to destination.name.
	setStage("argocd")
	if err := argocd.EnsureVClusterClusterSecret(spec.Name, spec.KubeconfigSecret, spec.KubeconfigNamespace, stdout, stderr); err != nil {
		return &result, fmt.Errorf("failed to register vcluster %q with ArgoCD: %w", spec.Name, err)
	}

	// GitOps delivery onto the host Fabric's ArgoCD (do NOT install ArgoCD — it belongs to the Fabric).
	gitopsRequested := vc.Repositories.AppsDestinationRepo != ""
	gitopsFailed := func(step string, err error) *argocd.GitopsStatus {
		return gitopsFailure(gitopsRequested, vc.Repositories.AppsDestinationRepo, step, err, params.GitAccessToken)
	}

	// Register the tenant apps-repo credential on the host ArgoCD so it can clone the repo (public repos
	// need none). Mirrors the namespace/dedicated switch.
	if gitopsRequested {
		switch {
		case params.GitAccessToken != "":
			if err := argocd.ConfigureRepoCredentials(vc.Repositories.AppsDestinationRepo, params.GitAccessToken, stdout, stderr); err != nil {
				result.GitopsStatus = gitopsFailed(argocd.GitopsStepRepoCredentials, err)
				return &result, fmt.Errorf("failed to connect ArgoCD to apps repo %s: %w", vc.Repositories.AppsDestinationRepo, err)
			}
		case argocd.IsRepoAnonymouslyCloneable(ctx, vc.Repositories.AppsDestinationRepo):
			fmt.Fprintf(stdout, "Apps repo %s is publicly cloneable — ArgoCD will clone it anonymously; no git token required.\n", vc.Repositories.AppsDestinationRepo)
		default:
			err := fmt.Errorf("GitOps requested (apps repo %s) but no git access token is available and the repo is not anonymously cloneable — connect the git provider for the job owner, or make the repo public", vc.Repositories.AppsDestinationRepo)
			result.GitopsStatus = gitopsFailed(argocd.GitopsStepGitToken, err)
			return &result, err
		}
	}

	// Render the AppProject + app Application targeting the registered vcluster (destination.name).
	manifests, renderErr := argocd.RenderVClusterApp(vclusterAppInput(vc, spec.Name, ns))
	if renderErr != nil {
		result.GitopsStatus = gitopsFailed(argocd.GitopsStepRender, renderErr)
		return &result, fmt.Errorf("failed to render vcluster app delivery: %w", renderErr)
	}

	// Fail-closed ORDER: AppProject FIRST (ArgoCD rejects an Application whose AppProject is missing), then
	// the app Application.
	if err := kubectlApplyManifest(manifests.Project, "vcluster AppProject", stdout, stderr); err != nil {
		result.GitopsStatus = gitopsFailed(argocd.GitopsStepApply, err)
		return &result, fmt.Errorf("failed to apply vcluster AppProject: %w", err)
	}
	if manifests.App != "" {
		if err := kubectlApplyManifest(manifests.App, "vcluster app Application", stdout, stderr); err != nil {
			result.GitopsStatus = gitopsFailed(argocd.GitopsStepApply, err)
			return &result, fmt.Errorf("failed to apply vcluster app Application: %w", err)
		}
	} else {
		fmt.Fprintln(stdout, "No apps repo configured — vcluster provisioned + registered, no app Application deployed.")
	}

	result.GitopsStatus = readGitopsSnapshot(gitopsRequested, vc.Repositories.AppsDestinationRepo, stdout, stderr)
	fmt.Fprintf(stdout, "vcluster deployment completed: virtual cluster %q provisioned, registered with ArgoCD, and app delivered.\n", spec.Name)
	return &result, nil
}

// runVClusterDestroy tears down a `vcluster`-placement env (called from RunDestroy). A vcluster env owns
// NO tofu (it's an app on a shared Fabric, like namespace) — teardown is: mint host access, then
// best-effort deregister the vcluster (helm uninstall + exported Secret) and its ArgoCD cluster Secret.
// Fail-open on an un-wired cloud (nothing was provisioned there). Best-effort so a partial failure still
// attempts the rest — a leaked ArgoCD cluster Secret keeps a dead vcluster registered.
func runVClusterDestroy(ctx context.Context, provider cloud.CloudProvider, params DestroyParams) error {
	vc := params.ProjectConfig
	stdout := params.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := params.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	if !vclusterRemintWired(params.Provider) {
		fmt.Fprintf(stdout, "vcluster teardown: provider %q is not activated for vcluster placement — nothing was provisioned; skipping.\n", params.Provider)
		return nil
	}

	spec, err := buildVClusterSpec(vc)
	if err != nil {
		return err
	}
	hostCluster := strings.TrimSpace(vc.Cluster.ClusterName)
	if hostCluster == "" || !isValidClusterName(hostCluster) {
		fmt.Fprintf(stderr, "Warning: vcluster teardown: no valid serving cluster on the snapshot — cannot mint host access to deregister vcluster %q.\n", spec.Name)
		return nil
	}

	fmt.Fprintf(stdout, "vcluster teardown: deregistering virtual cluster %q from host Fabric cluster %q...\n", spec.Name, hostCluster)
	if err := vclusterPreflight(); err != nil {
		return err
	}
	if err := mintVClusterHostAccess(ctx, provider, params.KubeConn, params.TalosKubeconfig, vc, params.Provider, hostCluster, stdout); err != nil {
		return fmt.Errorf("vcluster teardown: kubeconfig mint failed for host cluster %q: %w", hostCluster, err)
	}
	return deregisterVCluster(ctx, NewVClusterProvisioner(), spec, stdout, stderr)
}

// deregisterVCluster tears down a vcluster env: the control plane + its exported kubeconfig Secret
// (VClusterProvisioner.Deregister — helm uninstall + delete the exported Secret) AND the ArgoCD cluster
// registration Secret (argocd.DeregisterVClusterClusterSecret). Best-effort: both are attempted even if one
// fails (a leaked ArgoCD cluster Secret keeps a dead vcluster registered — the orphan-reclaim hazard), and
// the first error is returned.
func deregisterVCluster(ctx context.Context, prov VClusterProvisioner, spec VClusterSpec, stdout, stderr io.Writer) error {
	var firstErr error
	if err := prov.Deregister(ctx, spec, stdout, stderr); err != nil {
		fmt.Fprintf(stderr, "Warning: vcluster %q teardown (helm uninstall + exported Secret) failed: %v\n", spec.Name, err)
		firstErr = err
	}
	if err := argocd.DeregisterVClusterClusterSecret(spec.Name, stdout, stderr); err != nil {
		fmt.Fprintf(stderr, "Warning: vcluster %q ArgoCD cluster-Secret deregister failed: %v\n", spec.Name, err)
		if firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
