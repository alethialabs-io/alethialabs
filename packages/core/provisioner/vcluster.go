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
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// versionTokenRe matches a bare k8s version token (digits + dots, e.g. "1.31" / "1.31.2") — shell-/YAML-
// safe. Used to fail-closed a KubernetesVersion before it interpolates into the rendered image tag.
var versionTokenRe = regexp.MustCompile(`^[0-9]+(\.[0-9]+){0,2}$`)

// isVersionToken reports whether s is a bare, shell-safe version token.
func isVersionToken(s string) bool { return versionTokenRe.MatchString(s) }

// vcluster (loft-sh) virtual-cluster provisioning SEAM — the `vcluster` placement middle tier (W-i6,
// #960). A virtual cluster is a dedicated tenant control plane (its own API server + CRDs + RBAC) running
// as ONE StatefulSet pod on the shared Fabric host, whose workloads the syncer schedules onto the host's
// nodes — cheap to create/drop and dense-per-host, unlike `dedicated` (real nodes). We ship the pure
// Apache-2.0 OSS core ONLY: helm-create the vcluster + `exportKubeConfig` (service-account-token mode,
// NOT the admin cert) + OUR OWN ArgoCD cluster Secret. The phone-home Free-tier/Platform features
// (auto-ArgoCD connector, embedded etcd, vNode/Private-Nodes node isolation, CR syncing) are deliberately
// NOT load-bearing.
//
// This file is the SEAM: the VClusterProvisioner lifecycle interface + a helm-based implementation
// (create → expose API server → exportKubeConfig → deregister) driven by the SAME keyless host access the
// namespace path mints (deploy_namespace.go: provider.ConfigureKubeconfig sets the process KUBECONFIG, so
// every helm/kubectl here targets the host Fabric with no extra wiring). The DOWNSTREAM lanes — reading
// the exported kubeconfig into an ArgoCD cluster Secret, the `selectPlacementPath` dispatch, the vcluster
// data-model record + migration — are blocked-by this seam and land separately.
//
// SECURITY — the isolation ladder (honest, per the security-review gate):
//   - A vcluster on SHARED host nodes is a CONTROL-PLANE isolation boundary (separate API server / RBAC /
//     CRDs), NOT a hard workload/kernel boundary: a tenant with full control of vcluster.yaml can loosen
//     the syncer and reach host resources. Untrusted-workload isolation needs vNode / Private Nodes,
//     which sit behind the vCluster Free tier / Platform phone-home — out of the OSS core by design. So
//     `vcluster` sits ABOVE `namespace` (soft) and BELOW `dedicated` (hard) on the isolation ladder, and
//     must be positioned as such — never sold as a hard boundary for hostile tenants.
//   - `exportKubeConfig` writes a STANDING in-cluster credential (a service-account-token kubeconfig) into
//     the host, unlike the paid Platform connector's scoped no-long-lived-kubeconfig proxy. We mitigate by
//     (a) SA-token auth mode with a scoped ClusterRole (not the embedded admin cert), (b) writing the
//     Secret ONLY into the ArgoCD namespace, and (c) short TTL + rotation (a lifecycle follow-up — the
//     token is a credential to rotate). The bearer token / kubeconfig is NEVER returned in a deploy result
//     or execution_metadata — it lives only in the in-cluster Secret the ArgoCD-registration lane reads.
//   - Orphan-on-failed-teardown: a leaked ArgoCD cluster Secret or an undeleted vcluster release wedges the
//     env (matches the orphan-on-failed-apply hazard). Deregister tears down BOTH the helm release and the
//     exported Secret; the create→register→deregister lifecycle must be reconciled by orphan-reclaim.

const (
	// vclusterHelmRepoName is the local helm repo alias we add for the loft-sh charts.
	vclusterHelmRepoName = "loft-sh"
	// vclusterChartRef is the chart reference installed (repo alias / chart name).
	vclusterChartRef = vclusterHelmRepoName + "/vcluster"
	// defaultVClusterChartRepo is the loft-sh OSS helm repo (Apache-2.0 core; no phone-home).
	defaultVClusterChartRepo = "https://charts.loft.sh"
	// defaultVClusterClusterRole is the ClusterRole the exported service-account token is bound to inside
	// the vcluster. cluster-admin is the pragmatic default for GitOps delivery; a scoped least-priv role
	// is a hardening follow-up (documented, not silent).
	defaultVClusterClusterRole = "cluster-admin"
)

// ResolvedVClusterChartRepo returns the loft-sh helm repo URL, overridable via ALETHIA_VCLUSTER_CHART_REPO
// (e.g. an internal mirror), defaulting to the public OSS repo.
func ResolvedVClusterChartRepo() string {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_VCLUSTER_CHART_REPO")); v != "" {
		return v
	}
	return defaultVClusterChartRepo
}

// ResolvedVClusterChartVersion returns the pinned vcluster chart version from ALETHIA_VCLUSTER_CHART_VERSION,
// or "" (helm resolves the latest). The version is pinned per environment and validated against the chart
// in the T2 e2e — kept env-driven (not a hardcoded constant) so a chart bump needs no code change.
func ResolvedVClusterChartVersion() string {
	return strings.TrimSpace(os.Getenv("ALETHIA_VCLUSTER_CHART_VERSION"))
}

// VClusterSpec fully describes one virtual cluster to provision on a host Fabric — a pure value object
// (no cloud/host coupling; the host KUBECONFIG is already minted upstream). Every string that reaches a
// `bash -c` helm/kubectl command is fail-closed validated by Validate() before use.
type VClusterSpec struct {
	// Name is the vcluster helm release name AND the ArgoCD destination.name the env resolves against.
	// Must be a shell-safe cluster name.
	Name string
	// HostNamespace is the host-cluster namespace the vcluster control-plane pod runs in.
	HostNamespace string
	// KubernetesVersion optionally pins the vcluster's k8s distro version (e.g. "1.31"); "" = chart default.
	// Independent of the host's version (the point of a virtual control plane).
	KubernetesVersion string
	// ChartVersion optionally pins the vcluster chart version; "" = ResolvedVClusterChartVersion().
	ChartVersion string
	// APIServerURL overrides the API address written into exportKubeConfig.server. Leave "" for the
	// primary flow: ArgoCD runs on the SAME host Fabric, so the vcluster is reachable in-cluster at
	// InClusterAPIServerURL() (a ClusterIP Service — no LoadBalancer, no Talos/Hetzner LB-controller
	// dependency). Set it (with Expose) only when an OFF-host ArgoCD must reach the vcluster.
	APIServerURL string
	// Expose requests a LoadBalancer Service for the vcluster API (external reach). Default false = the
	// in-cluster ClusterIP Service, which the host's ArgoCD reaches directly. When true the caller
	// resolves the assigned address via ResolveAPIServer and sets APIServerURL for the ArgoCD Secret.
	Expose bool
	// ServiceAccount is the SA the exported kubeconfig authenticates as (a scoped token, NOT the admin cert).
	ServiceAccount string
	// ClusterRole is the ClusterRole bound to ServiceAccount inside the vcluster; "" = defaultVClusterClusterRole.
	ClusterRole string
	// KubeconfigSecret is the Secret name exportKubeConfig writes the scoped kubeconfig into.
	KubeconfigSecret string
	// KubeconfigNamespace is the host namespace that Secret is written into (e.g. "argocd" — where ArgoCD lives).
	KubeconfigNamespace string
}

// InClusterAPIServerURL is the vcluster API address reachable from WITHIN the host Fabric — the ClusterIP
// Service the chart creates (named for the release, in the host namespace). This is what an on-host ArgoCD
// registers against; deterministic, so no post-create address resolution is needed for the primary flow.
func (s VClusterSpec) InClusterAPIServerURL() string {
	return fmt.Sprintf("https://%s.%s.svc", s.Name, s.HostNamespace)
}

// effectiveServer returns the API address to pin into exportKubeConfig.server: the explicit APIServerURL
// override, or the in-cluster Service URL for the on-host-ArgoCD primary flow.
func (s VClusterSpec) effectiveServer() string {
	if u := strings.TrimSpace(s.APIServerURL); u != "" {
		return u
	}
	return s.InClusterAPIServerURL()
}

// resolvedClusterRole returns the spec's ClusterRole or the default.
func (s VClusterSpec) resolvedClusterRole() string {
	if strings.TrimSpace(s.ClusterRole) != "" {
		return s.ClusterRole
	}
	return defaultVClusterClusterRole
}

// resolvedChartVersion returns the spec's ChartVersion or the env-resolved default ("" ⇒ helm latest).
func (s VClusterSpec) resolvedChartVersion() string {
	if strings.TrimSpace(s.ChartVersion) != "" {
		return s.ChartVersion
	}
	return ResolvedVClusterChartVersion()
}

// Validate fail-closes any spec whose shell-/YAML-bound fields aren't strict k8s identifiers, so a
// project-data-derived value can never inject a command into the `bash -c` helm/kubectl calls (which run
// with the runner's ambient host access). Mirrors deploy_namespace.go's namespace/cluster-name guards.
func (s VClusterSpec) Validate() error {
	if !isValidClusterName(s.Name) {
		return fmt.Errorf("vcluster: name %q is not a valid cluster name", s.Name)
	}
	for label, val := range map[string]string{
		"host_namespace":       s.HostNamespace,
		"service_account":      s.ServiceAccount,
		"kubeconfig_secret":    s.KubeconfigSecret,
		"kubeconfig_namespace": s.KubeconfigNamespace,
	} {
		if !isDNS1123Label(val) {
			return fmt.Errorf("vcluster: %s %q is not a valid DNS-1123 label", label, val)
		}
	}
	// KubernetesVersion, when set, must be a bare version token (digits/dots) — it interpolates into the
	// rendered vcluster.yaml image tag.
	if v := strings.TrimSpace(s.KubernetesVersion); v != "" && !isVersionToken(v) {
		return fmt.Errorf("vcluster: kubernetes_version %q is not a valid version token", v)
	}
	return nil
}

// renderVClusterValues builds the OSS vcluster.yaml (helm values) for the spec: expose the API server via
// a LoadBalancer Service, optionally pin the k8s distro version, and configure `exportKubeConfig` in
// service-account-token mode writing a scoped kubeconfig Secret into the ArgoCD namespace. Pure (no IO) so
// it is unit-testable. The exact vcluster.yaml keys track the pinned chart version and are validated
// against it in the T2 e2e; each block is commented with its purpose.
func renderVClusterValues(spec VClusterSpec) string {
	var b strings.Builder
	version := strings.TrimSpace(spec.KubernetesVersion)
	// Only emit controlPlane when it has content (an empty mapping is pointless).
	if spec.Expose || version != "" {
		b.WriteString("controlPlane:\n")
		if spec.Expose {
			// Optional: expose the vcluster API off-host (LoadBalancer; on Talos/Hetzner this needs an LB
			// controller — a Fabric-provisioning concern). The default (ClusterIP) is reached in-cluster.
			b.WriteString("  service:\n")
			b.WriteString("    spec:\n")
			b.WriteString("      type: LoadBalancer\n")
		}
		if version != "" {
			// Pin the k8s distro version independently of the host (validated as a version token).
			b.WriteString("  distro:\n")
			b.WriteString("    k8s:\n")
			b.WriteString("      image:\n")
			fmt.Fprintf(&b, "        tag: v%s\n", version)
		}
	}
	// exportKubeConfig: emit a SCOPED service-account-token kubeconfig (not the admin cert) into the
	// ArgoCD namespace on the host, with the API endpoint pinned to the address ArgoCD reaches it at
	// (in-cluster Service by default; the explicit override when exposed off-host).
	b.WriteString("exportKubeConfig:\n")
	fmt.Fprintf(&b, "  server: %s\n", spec.effectiveServer())
	b.WriteString("  serviceAccount:\n")
	fmt.Fprintf(&b, "    name: %s\n", spec.ServiceAccount)
	fmt.Fprintf(&b, "    clusterRole: %s\n", spec.resolvedClusterRole())
	b.WriteString("  additionalSecrets:\n")
	fmt.Fprintf(&b, "    - name: %s\n", spec.KubeconfigSecret)
	fmt.Fprintf(&b, "      namespace: %s\n", spec.KubeconfigNamespace)
	return b.String()
}

// vclusterRepoAddCommand builds the `helm repo add … && helm repo update` command for the loft-sh repo.
func vclusterRepoAddCommand() string {
	return fmt.Sprintf(
		"helm repo add %s %s && helm repo update %s",
		utils.ShellQuote(vclusterHelmRepoName),
		utils.ShellQuote(ResolvedVClusterChartRepo()),
		utils.ShellQuote(vclusterHelmRepoName),
	)
}

// vclusterInstallCommand builds the idempotent `helm upgrade --install` for the vcluster release, reading
// values from valuesPath. Every interpolated value is shell-quoted. Pure — the caller writes valuesPath
// and runs the command.
func vclusterInstallCommand(spec VClusterSpec, valuesPath string, timeout time.Duration) string {
	cmd := fmt.Sprintf(
		"helm upgrade --install %s %s --namespace %s --create-namespace --values %s --wait --timeout %s",
		utils.ShellQuote(spec.Name),
		utils.ShellQuote(vclusterChartRef),
		utils.ShellQuote(spec.HostNamespace),
		utils.ShellQuote(valuesPath),
		utils.ShellQuote(fmtDuration(timeout)),
	)
	if v := spec.resolvedChartVersion(); v != "" {
		cmd += " --version " + utils.ShellQuote(v)
	}
	return cmd
}

// vclusterUninstallCommand builds the `helm uninstall` for the release (teardown of the control plane).
func vclusterUninstallCommand(spec VClusterSpec) string {
	return fmt.Sprintf(
		"helm uninstall %s --namespace %s --ignore-not-found",
		utils.ShellQuote(spec.Name),
		utils.ShellQuote(spec.HostNamespace),
	)
}

// vclusterDeleteSecretCommand builds the kubectl delete for the exported ArgoCD kubeconfig Secret (owned
// teardown — a leaked Secret would keep a dead cluster registered / hold a standing credential).
func vclusterDeleteSecretCommand(spec VClusterSpec) string {
	return fmt.Sprintf(
		"kubectl delete secret %s --namespace %s --ignore-not-found",
		utils.ShellQuote(spec.KubeconfigSecret),
		utils.ShellQuote(spec.KubeconfigNamespace),
	)
}

// VClusterProvisioner is the vcluster lifecycle seam: create the control plane, wait for it, resolve its
// exposed API address, and deregister it. Implemented over helm/kubectl against the already-minted host
// KUBECONFIG. loft-sh OSS only.
type VClusterProvisioner interface {
	// Create helm-installs the vcluster on the host Fabric with exportKubeConfig configured (idempotent).
	Create(ctx context.Context, spec VClusterSpec, stdout, stderr io.Writer) error
	// WaitReady blocks until the vcluster control-plane StatefulSet is rolled out (or the timeout elapses).
	WaitReady(ctx context.Context, spec VClusterSpec, timeout time.Duration, stdout, stderr io.Writer) error
	// ResolveAPIServer reads the exposed (LoadBalancer) API address for the vcluster, or "" if not yet
	// assigned. Feeds exportKubeConfig.server for the ArgoCD registration.
	ResolveAPIServer(ctx context.Context, spec VClusterSpec, stdout, stderr io.Writer) (string, error)
	// Deregister tears the vcluster down: helm uninstall + delete the exported ArgoCD kubeconfig Secret.
	// Best-effort across both so a partial failure still attempts the rest (orphan-reclaim safety).
	Deregister(ctx context.Context, spec VClusterSpec, stdout, stderr io.Writer) error
}

// helmVClusterProvisioner is the OSS helm/kubectl implementation of VClusterProvisioner.
type helmVClusterProvisioner struct{}

// NewVClusterProvisioner returns the default (loft-sh OSS, helm-based) vcluster provisioner.
func NewVClusterProvisioner() VClusterProvisioner { return &helmVClusterProvisioner{} }

// Create validates the spec, ensures helm/kubectl are present, adds the loft-sh repo, and helm-installs
// the vcluster with the rendered exportKubeConfig values (against the minted host KUBECONFIG).
func (p *helmVClusterProvisioner) Create(ctx context.Context, spec VClusterSpec, stdout, stderr io.Writer) error {
	if err := spec.Validate(); err != nil {
		return err
	}
	if err := utils.CheckDependencies("helm", "kubectl"); err != nil {
		return fmt.Errorf("vcluster preflight failed: %w", err)
	}
	if err := executeCommand(vclusterRepoAddCommand(), ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("vcluster: failed to add loft-sh helm repo: %w", err)
	}

	dir, err := os.MkdirTemp("", "alethia-vcluster-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	valuesPath := filepath.Join(dir, "vcluster.yaml")
	// Values carry no secrets, but owner-only keeps the workdir uniform with the other manifest writers.
	if err := os.WriteFile(valuesPath, []byte(renderVClusterValues(spec)), 0o600); err != nil {
		return err
	}

	fmt.Fprintf(stdout, "Creating vcluster %q in host namespace %q on the Fabric...\n", spec.Name, spec.HostNamespace)
	if err := executeCommand(vclusterInstallCommand(spec, valuesPath, clusterReadyTimeout()), ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("vcluster: helm install of %q failed: %w", spec.Name, err)
	}
	return nil
}

// WaitReady waits for the vcluster control-plane StatefulSet (named for the release) to finish rolling out.
func (p *helmVClusterProvisioner) WaitReady(ctx context.Context, spec VClusterSpec, timeout time.Duration, stdout, stderr io.Writer) error {
	if err := spec.Validate(); err != nil {
		return err
	}
	cmd := fmt.Sprintf(
		"kubectl rollout status statefulset/%s --namespace %s --timeout %s",
		utils.ShellQuote(spec.Name),
		utils.ShellQuote(spec.HostNamespace),
		utils.ShellQuote(fmtDuration(timeout)),
	)
	if err := executeCommand(cmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("vcluster %q did not become ready: %w", spec.Name, err)
	}
	return nil
}

// ResolveAPIServer reads the LoadBalancer ingress address of the vcluster's API Service, returning "" (no
// error) until the address is assigned — the caller retries or falls back.
func (p *helmVClusterProvisioner) ResolveAPIServer(ctx context.Context, spec VClusterSpec, stdout, stderr io.Writer) (string, error) {
	if err := spec.Validate(); err != nil {
		return "", err
	}
	// Prefer hostname, fall back to IP (LB providers populate one or the other).
	cmd := fmt.Sprintf(
		"kubectl get service %s --namespace %s -o jsonpath='{.status.loadBalancer.ingress[0].hostname}{.status.loadBalancer.ingress[0].ip}'",
		utils.ShellQuote(spec.Name),
		utils.ShellQuote(spec.HostNamespace),
	)
	out, err := executeCommandWithOutput(cmd, ".", nil)
	if err != nil {
		return "", fmt.Errorf("vcluster: failed to read API server address for %q: %w", spec.Name, err)
	}
	addr := strings.TrimSpace(out)
	if addr == "" {
		return "", nil
	}
	return fmt.Sprintf("https://%s", addr), nil
}

// Deregister tears the vcluster down — helm uninstall AND delete the exported ArgoCD kubeconfig Secret.
// Both run best-effort (a helm failure still attempts the Secret delete) so a partial teardown doesn't
// strand the standing credential; the first error is returned after attempting both.
func (p *helmVClusterProvisioner) Deregister(ctx context.Context, spec VClusterSpec, stdout, stderr io.Writer) error {
	if err := spec.Validate(); err != nil {
		return err
	}
	var firstErr error
	fmt.Fprintf(stdout, "Deregistering vcluster %q (helm uninstall + exported-Secret cleanup)...\n", spec.Name)
	if err := executeCommand(vclusterUninstallCommand(spec), ".", nil, stdout, stderr); err != nil {
		firstErr = fmt.Errorf("vcluster: helm uninstall of %q failed: %w", spec.Name, err)
	}
	if err := executeCommand(vclusterDeleteSecretCommand(spec), ".", nil, stdout, stderr); err != nil && firstErr == nil {
		firstErr = fmt.Errorf("vcluster: failed to delete exported kubeconfig secret for %q: %w", spec.Name, err)
	}
	return firstErr
}

// fmtDuration renders a Go duration as a helm/kubectl-friendly string (e.g. "15m0s" → helm accepts it).
func fmtDuration(d time.Duration) string {
	if d <= 0 {
		return "15m"
	}
	return d.String()
}
