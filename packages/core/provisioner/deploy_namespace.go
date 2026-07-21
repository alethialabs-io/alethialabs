// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
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

// placementPath classifies how RunDeployV2 must handle a config's placement. Kept as a pure decision
// (selectPlacementPath) so the branch is unit-testable without a cluster or a cloud.
type placementPath int

const (
	// placementDedicated provisions a full cluster via tofu — the legacy env=cluster path and the only
	// mode shipped to the customer base. Empty PlacementMode maps here (legacy).
	placementDedicated placementPath = iota
	// placementNamespaceAWS deploys onto an EXISTING shared Fabric cluster via keyless re-mint (no
	// tofu) — the activated `namespace` path, aws-first.
	placementNamespaceAWS
	// placementUnactivated is a placement the runner cannot deploy yet (namespace on a cloud whose
	// keyless re-mint isn't wired, or vcluster) — fail closed rather than run the full-cluster tofu.
	placementUnactivated
)

// selectPlacementPath decides the deploy path from placement mode + provider, WITHOUT side effects so
// it is unit-testable. `dedicated`/"" → full cluster; `namespace` on aws → the activated shared-cluster
// path; everything else (namespace on non-aws, vcluster, any unknown) → fail closed.
func selectPlacementPath(pm types.PlacementMode, provider string) placementPath {
	switch pm {
	case "", types.PlacementModeDedicated:
		return placementDedicated
	case types.PlacementModeNamespace:
		if provider == "aws" {
			return placementNamespaceAWS
		}
		return placementUnactivated
	case types.PlacementModeVcluster:
		// vcluster exec is P2 (#960) — not activated on any cloud yet.
		return placementUnactivated
	default:
		// any unrecognized/future mode → fail closed.
		return placementUnactivated
	}
}

// unactivatedPlacementError explains, per placement + cloud, WHY a placement isn't deployable yet — an
// explicit, documented fail-closed exclusion (cloud parity is a hard rule: a per-cloud gap is never a
// silent omission). namespace is activated on aws; other clouds + vcluster are tracked follow-ups.
func unactivatedPlacementError(pm types.PlacementMode, provider string) error {
	if pm == types.PlacementModeNamespace {
		return fmt.Errorf("placement_mode %q is not yet activated for deploy on provider %q — namespace placement mints keyless access to an existing shared cluster, wired for aws (EKS DescribeCluster) today; gcp/azure/alibaba need output-based kubeconfig mint helpers and hetzner-talos a Fabric-create-time kubeconfig (per-cloud follow-ups). 'dedicated' provisions on every cloud", pm, provider)
	}
	return fmt.Errorf("placement_mode %q is not yet activated for deploy — only 'dedicated' (full cluster, every cloud) and 'namespace' (aws) provision today; vcluster is tracked (#960)", pm)
}

// runNamespaceDeploy deploys a `namespace`-placement env onto an EXISTING shared Fabric cluster
// (#955/#956), aws-first. It runs NO tofu: it mints keyless kube access to the named cluster, applies
// the fail-closed per-namespace isolation (hardened AppProject + Namespace w/ PSA + the guardrail
// bundle), and delivers the tenant app as ONE ArgoCD Application into the namespace — WITHOUT
// reinstalling the shared Fabric's ArgoCD. v1 provisions no per-env cloud resources and grants the
// tenant NO Kubernetes-API credential (default-SA token automount off, no IRSA — per-namespace
// identity is the #957 follow-up).
//
// It is a fully separate path from RunDeployV2's full-cluster body so the `dedicated` path stays
// byte-identical. Because no infrastructure (cloud) is mutated, the tofu plan / verify gate / cost
// guard / evidence receipt do not apply and are deliberately absent — a namespace deploy mutates only
// in-cluster Kubernetes objects on a Fabric that already passed the gate at ITS creation.
//
// SECURITY — INCOMPLETE tenant isolation on the current Fabric (do NOT offer namespace placement in
// the UI until closed; the placement selector is parked precisely for this bar):
//   - The default-deny NetworkPolicy in the guardrail bundle is only enforced if the Fabric's CNI
//     enforces NetworkPolicy. The AWS EKS Fabric template does NOT enable VPC-CNI NetworkPolicy today,
//     so the network half is currently a NO-OP on AWS — tenants are not network-isolated from each
//     other, and (with node metadata hop-limit 2) a pod can reach IMDS and assume the NODE IAM role
//     (cluster-wide node creds: ECR, ENI/EC2). Closing this needs, on the Fabric: VPC-CNI
//     NetworkPolicy enforcement (parity: Calico/Cilium equivalents on the other clouds) AND node IMDS
//     hop-limit 1 (or an explicit metadata-egress deny), AND per-namespace IRSA/WI (#957). Until then
//     the honest isolation level is "soft, and not a cloud-credential boundary."
func runNamespaceDeploy(ctx context.Context, params DeployParams) (_ *PlanResult, retErr error) {
	vc := params.ProjectConfig

	stdout := params.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := params.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	// Reduced provisioning-stage spans (kube_configure → argocd). Same pattern as RunDeployV2: setStage
	// ends the previous span and opens the next; the deferred close ends the last and stamps the error.
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

	// Belt-and-suspenders: the dispatcher already routed only aws-namespace here, but never run the
	// namespace path for a cloud whose keyless re-mint isn't wired.
	if params.Provider != "aws" {
		return nil, unactivatedPlacementError(vc.PlacementMode, params.Provider)
	}

	// The serving cluster + destination namespace must be resolved onto the snapshot by the console
	// (buildConfigSnapshot → resolveServingCluster / resolveTargetEnvironment). Fail closed if absent —
	// never guess a cluster/namespace.
	clusterName := strings.TrimSpace(vc.Cluster.ClusterName)
	if clusterName == "" {
		return nil, fmt.Errorf("namespace placement: no serving cluster on the config snapshot — the Fabric's cluster must be provisioned (a 'dedicated' env owning the Fabric) before a namespace env can be placed onto it")
	}
	ns := strings.TrimSpace(vc.Namespace)
	if ns == "" {
		return nil, fmt.Errorf("namespace placement: no destination namespace on the config snapshot")
	}

	// Defense-in-depth: `ns` and `clusterName` flow into SHELL commands (utils.ExecuteCommand runs
	// `bash -c`, e.g. `kubectl apply -n <ns> ...`) and into rendered YAML manifests. The console builds
	// the snapshot and derives `ns` as a DNS-1123 slug, but the RUNNER is the trust boundary for a
	// (project-data-influenced) snapshot — reject anything that isn't a strict DNS-1123 label / valid
	// cluster name, so a malformed or hostile value can never inject a shell command (it would run with
	// the runner's ambient cloud creds) or break the manifest.
	if !isDNS1123Label(ns) {
		return nil, fmt.Errorf("namespace placement: destination namespace %q is not a valid DNS-1123 label", ns)
	}
	if !isValidClusterName(clusterName) {
		return nil, fmt.Errorf("namespace placement: serving cluster name %q contains invalid characters", clusterName)
	}

	provider, err := cloud.NewCloudProvider(params.Provider)
	if err != nil {
		return nil, err
	}

	fmt.Fprintf(stdout, "Namespace placement: deploying into namespace %q on existing shared cluster %q (provider: %s) — no cluster provisioning.\n", ns, clusterName, provider.Name())

	var result PlanResult
	result.ClusterName = clusterName

	// Plan job: a namespace placement provisions no infrastructure (no tofu), so there is nothing to
	// plan/verify/price. Report the resolved target and return — no verify report / receipt / cost
	// breakdown (nil, not a fabricated pass).
	if params.DryRun {
		fmt.Fprintf(stdout, "Dry-run (plan): namespace placement provisions no infrastructure — at deploy, the app + isolation guardrails are applied into namespace %q on cluster %q.\n", ns, clusterName)
		return &result, nil
	}

	if err := utils.CheckDependencies("kubectl"); err != nil {
		return nil, fmt.Errorf("preflight check failed: %w", err)
	}

	// Keyless kube access to the EXISTING named cluster. AWS ConfigureKubeconfig resolves
	// endpoint/CA/ARN via EKS DescribeCluster on the ambient keyless session (no tofu outputs), then
	// writes the in-process `kube-token` exec-plugin kubeconfig. Feed the cluster name via the same
	// output key ExtractClusterName reads.
	setStage("kube_configure")
	mintOutputs := map[string]interface{}{"eks_cluster_name": clusterName}
	if err := provider.ConfigureKubeconfig(ctx, vc, mintOutputs, stdout); err != nil {
		return nil, fmt.Errorf("kubeconfig mint failed for existing cluster %q — the namespace env is placed on a Fabric whose cluster is unreachable: %w", clusterName, err)
	}
	// Reachability probe: minting only proves DescribeCluster succeeded, not that the exec-plugin token
	// is ACCEPTED by the API server. A cheap API-reachability check (requireNode=false — the shared
	// Fabric's nodes are already Ready) fails a wrong Fabric/region or an authz denial HONESTLY here
	// rather than as a confusing ArgoCD apply error later. No CNI bootstrap / pod-datapath gate: those
	// are Fabric-provisioning concerns; the cluster is already healthy.
	if err := k8s.WaitClusterReady(ctx, clusterReadyTimeout(), false, stdout); err != nil {
		return nil, fmt.Errorf("existing cluster %q unreachable after minting kube access: %w", clusterName, err)
	}
	result.ClusterReady = true

	// GitOps delivery onto the SHARED Fabric's ArgoCD. DO NOT install ArgoCD — it belongs to the Fabric
	// (a namespace tenant must never re-install / upgrade the shared control plane).
	setStage("argocd")
	gitopsRequested := vc.Repositories.AppsDestinationRepo != ""
	gitopsFailed := func(step string, err error) *argocd.GitopsStatus {
		return gitopsFailure(gitopsRequested, vc.Repositories.AppsDestinationRepo, step, err, params.GitAccessToken)
	}

	// Register the tenant apps-repo credential on the shared ArgoCD so it can clone the repo (public
	// repos need none). Mirrors the dedicated switch.
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

	// Render the hardened isolation (Namespace + AppProject) + the app Application.
	manifests, renderErr := argocd.RenderNamespaceTenant(argocd.NamespaceTenantInput{
		Project:     vc.ProjectName,
		Namespace:   ns,
		AppsRepoURL: vc.Repositories.AppsDestinationRepo,
		Labels:      cloud.ClassificationLabels(vc),
	})
	if renderErr != nil {
		result.GitopsStatus = gitopsFailed(argocd.GitopsStepRender, renderErr)
		return &result, fmt.Errorf("failed to render namespace tenant isolation: %w", renderErr)
	}

	// Fail-closed ORDER: (1) Namespace + hardened AppProject, (2) the guardrail bundle INTO the ns, (3)
	// the app Application. The app carries CreateNamespace=false and is pinned to the hardened
	// AppProject, so it can never sync into an un-guarded namespace even if it raced ahead.
	if err := kubectlApplyManifest(manifests.Isolation, "namespace isolation (Namespace + hardened AppProject)", stdout, stderr); err != nil {
		result.GitopsStatus = gitopsFailed(argocd.GitopsStepApply, err)
		return &result, fmt.Errorf("failed to apply namespace isolation: %w", err)
	}
	if err := applyNamespaceGuardrailBundle(ns, stdout, stderr); err != nil {
		result.GitopsStatus = gitopsFailed(argocd.GitopsStepApply, err)
		return &result, fmt.Errorf("failed to apply namespace guardrail bundle into %q: %w", ns, err)
	}
	if manifests.App != "" {
		if err := kubectlApplyManifest(manifests.App, "namespace app Application", stdout, stderr); err != nil {
			result.GitopsStatus = gitopsFailed(argocd.GitopsStepApply, err)
			return &result, fmt.Errorf("failed to apply namespace app Application: %w", err)
		}
	} else {
		fmt.Fprintln(stdout, "No apps repo configured — namespace guarded, no app Application deployed.")
	}

	result.GitopsStatus = readGitopsSnapshot(gitopsRequested, vc.Repositories.AppsDestinationRepo, stdout, stderr)
	fmt.Fprintf(stdout, "Namespace deployment completed: app + isolation guardrails applied into namespace %q on cluster %q.\n", ns, clusterName)
	return &result, nil
}

// kubectlApplyManifest writes a rendered manifest to an owner-only temp file and applies it. Hard
// error on failure — the namespace path is fail-closed at every step.
func kubectlApplyManifest(manifest, label string, stdout, stderr io.Writer) error {
	dir, err := os.MkdirTemp("", "alethia-ns-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "manifest.yaml")
	// The rendered manifests carry no secrets, but owner-only keeps the workdir uniform.
	if err := os.WriteFile(path, []byte(manifest), 0o600); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Applying %s...\n", label)
	return executeCommand("kubectl apply -f "+path, ".", nil, stdout, stderr)
}

// applyNamespaceGuardrailBundle applies the namespace-agnostic guardrail bundle
// (infra/templates/argocd/preview-guardrails/) INTO the tenant namespace with `kubectl -n <ns>`,
// which injects the namespace into each namespaced doc: default-deny NetworkPolicy + DNS/intra-ns
// allow, ResourceQuota, LimitRange, and least-priv default-SA RBAC (token automount off). Re-applied
// every deploy (idempotent); the tenant holds no write access to mutate it between deploys. The
// bundle's `alethia.io/preview` labels are cosmetic here (v1 reuses the exact, tested bundle) — a
// namespace-vs-preview label split is a follow-up.
func applyNamespaceGuardrailBundle(ns string, stdout, stderr io.Writer) error {
	argoDir := resolveArgoTemplatesDir()
	if argoDir == "" {
		return fmt.Errorf("ArgoCD templates not found — the runner image is missing its baked templates")
	}
	bundleDir := filepath.Join(argoDir, "preview-guardrails")
	if info, statErr := os.Stat(bundleDir); statErr != nil || !info.IsDir() {
		return fmt.Errorf("namespace guardrail bundle not found at %s: %w", bundleDir, statErr)
	}
	fmt.Fprintf(stdout, "Applying namespace guardrail bundle into %q...\n", ns)
	return executeCommand(fmt.Sprintf("kubectl apply -n %s -f %s", ns, bundleDir), ".", nil, stdout, stderr)
}

// dns1123LabelRe matches a strict Kubernetes DNS-1123 label (lowercase alnum + hyphens, not
// hyphen-bounded). Used to fail-closed a namespace that isn't shell-safe / YAML-safe.
var dns1123LabelRe = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// isDNS1123Label reports whether s is a valid (≤63-char) DNS-1123 label — the k8s namespace grammar,
// which by construction contains no shell metacharacters or YAML-breaking runes.
func isDNS1123Label(s string) bool {
	return len(s) > 0 && len(s) <= 63 && dns1123LabelRe.MatchString(s)
}

// clusterNameRe matches the EKS cluster-name grammar (alnum start, then alnum/hyphen/underscore) —
// shell-safe. Used to fail-closed a serving-cluster name from the snapshot before it reaches a shell.
var clusterNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`)

// isValidClusterName reports whether s is a shell-safe cluster name.
func isValidClusterName(s string) bool { return clusterNameRe.MatchString(s) }
