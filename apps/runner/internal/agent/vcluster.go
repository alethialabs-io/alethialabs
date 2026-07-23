// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// Runner-side wiring for the vcluster placement SEAM (W-i6, #960). The vcluster lifecycle itself lives in
// packages/core/provisioner (VClusterProvisioner — helm/kubectl over the minted host KUBECONFIG); this
// file is the runner's translation layer: derive a provisioner.VClusterSpec from the job's config
// snapshot, preflight the runner image's tooling, and drive create → wait-ready → (deregister on
// teardown). It is deliberately NOT yet invoked from the deploy stage — the placement dispatch
// (selectPlacementPath → a vcluster branch) and the ArgoCD-cluster-Secret registration are the downstream
// lanes blocked-by this seam. Kept runner-side (not in core) because it maps the runner's job/snapshot
// shape onto the provider-agnostic core spec, exactly like stage.go maps a job onto DeployParams.

const (
	// defaultArgoNamespace is where ArgoCD runs on the Fabric — the host namespace the exported vcluster
	// kubeconfig Secret is written into so ArgoCD can register the destination.
	defaultArgoNamespace = "argocd"
	// vclusterHostNamespacePrefix / vclusterKubeconfigSecretPrefix / vclusterServiceAccountPrefix derive the
	// per-env resource names from the env's namespace. Distinct prefixes keep the control-plane host
	// namespace, the exported Secret, and the SA from colliding.
	vclusterHostNamespacePrefix    = "vcluster-"
	vclusterKubeconfigSecretPrefix = "vcluster-kubeconfig-"
	vclusterServiceAccountPrefix   = "vcluster-argocd-"
)

// BuildVClusterSpec derives the vcluster provisioning spec for a `vcluster`-placement env from its config
// snapshot. The env's Namespace is the ArgoCD destination.name (the registered virtual cluster's name);
// the control plane, exported Secret, and SA get deterministic per-env names off it. Fail-closed: returns
// an error (never a half-built spec) if the snapshot is missing the namespace or a derived name isn't a
// valid k8s identifier. Canonical naming + persistence is the vcluster data-model lane; this is the seam's
// working default.
func BuildVClusterSpec(vc *types.ProjectConfig, argoNamespace string) (provisioner.VClusterSpec, error) {
	if vc == nil {
		return provisioner.VClusterSpec{}, fmt.Errorf("vcluster: nil project config")
	}
	name := strings.TrimSpace(vc.Namespace)
	if name == "" {
		return provisioner.VClusterSpec{}, fmt.Errorf("vcluster: no destination namespace on the config snapshot — a vcluster env needs a resolved namespace (its ArgoCD destination name)")
	}
	if strings.TrimSpace(argoNamespace) == "" {
		argoNamespace = defaultArgoNamespace
	}
	spec := provisioner.VClusterSpec{
		Name:                name,
		HostNamespace:       vclusterHostNamespacePrefix + name,
		ServiceAccount:      vclusterServiceAccountPrefix + name,
		KubeconfigSecret:    vclusterKubeconfigSecretPrefix + name,
		KubeconfigNamespace: argoNamespace,
		// APIServerURL "" + Expose false ⇒ the in-cluster ClusterIP Service address (on-host ArgoCD reach).
	}
	if err := spec.Validate(); err != nil {
		return provisioner.VClusterSpec{}, err
	}
	return spec, nil
}

// VClusterPreflight checks the runner image carries the tooling the vcluster path shells out to.
func VClusterPreflight() error {
	if err := utils.CheckDependencies("helm", "kubectl"); err != nil {
		return fmt.Errorf("vcluster preflight failed (runner image missing tooling): %w", err)
	}
	return nil
}

// ProvisionVCluster drives the create→wait-ready half of the lifecycle against the already-minted host
// KUBECONFIG: preflight, create the vcluster (helm + exportKubeConfig), and wait for its control plane.
// The ArgoCD-cluster-Secret registration that consumes the exported kubeconfig is the downstream lane.
// Best-effort teardown (Deregister) is exposed separately so the deploy/destroy paths can own it.
func ProvisionVCluster(
	ctx context.Context,
	prov provisioner.VClusterProvisioner,
	spec provisioner.VClusterSpec,
	readyTimeout time.Duration,
	stdout, stderr io.Writer,
) error {
	if err := VClusterPreflight(); err != nil {
		return err
	}
	if err := prov.Create(ctx, spec, stdout, stderr); err != nil {
		return err
	}
	if err := prov.WaitReady(ctx, spec, readyTimeout, stdout, stderr); err != nil {
		return err
	}
	return nil
}
