// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// hetznerProvider provisions a self-managed Talos Linux Kubernetes cluster on
// Hetzner Cloud. Unlike the managed-K8s clouds (EKS/GKE/AKS), the cluster's PKI
// and kubeconfig are produced by the OpenTofu run itself (the siderolabs/talos
// provider), so ConfigureKubeconfig just reads the `kubeconfig` output rather than
// calling a cloud API. The Hetzner API token is read from the HCLOUD_TOKEN env var
// (activated by the runner from the cloud identity), never passed through tfvars/state.
type hetznerProvider struct{}

func (p *hetznerProvider) Name() string { return "hetzner" }

// RequiredCLIs is empty: the talos Terraform provider handles machine-config,
// bootstrap and kubeconfig retrieval in-apply, and the runner writes the emitted
// kubeconfig directly — no talosctl/kubectl are needed to bring the cluster up.
func (p *hetznerProvider) RequiredCLIs() []string { return []string{} }

// hetznerServerArch returns the Talos image architecture for a Hetzner server type:
// CAX* are Ampere ARM (arm64); everything else (CX*, CPX*, CCX*) is x86 (amd64).
func hetznerServerArch(serverType string) string {
	if strings.HasPrefix(strings.ToLower(serverType), "cax") {
		return "arm64"
	}
	return "amd64"
}

func (p *hetznerProvider) ProviderTfvars(config *types.ProjectConfig) map[string]interface{} {
	// Node sizing: prefer an explicit/ resolved instance type, else a cheap ARM default.
	workerType := "cax11"
	if inst := resolveInstanceTypes("hetzner", config.Cluster); len(inst) > 0 {
		workerType = inst[0]
	}

	// Worker count from the cloud-indifferent node sizing (desired, then min), default 1.
	workerCount := 1
	if config.Cluster.NodeDesiredSize > 0 {
		workerCount = config.Cluster.NodeDesiredSize
	} else if config.Cluster.NodeMinSize > 0 {
		workerCount = config.Cluster.NodeMinSize
	}

	// Control-plane: single node by default (minimal/cheapest). A floating-IP API
	// endpoint keeps kubeconfig stable if this later grows to a 3-node HA quorum.
	controlPlaneType := "cax11"
	controlPlaneCount := 1

	// Non-overlapping CIDRs (private network vs pod vs service) — CCM route creation
	// fails if the pod/service CIDRs overlap the Hetzner network CIDR.
	networkCIDR := orDefault(config.Network.CIDRBlock, "10.0.0.0/16")

	tfvars := map[string]interface{}{
		"project_name": config.ProjectName,
		"environment":  config.EnvironmentStage,
		"region":       orDefault(resolveRegion("hetzner", config.Region), "fsn1"),

		// Talos / Kubernetes versions (pin via provider_config to override).
		"talos_version":      orDefault(providerString(config.Cluster.ProviderConfig, "talos_version"), "v1.9.5"),
		"kubernetes_version": config.Cluster.ClusterVersion,

		// Control plane (single-node, cheapest).
		"control_plane_count":       controlPlaneCount,
		"control_plane_server_type": controlPlaneType,

		// Workers.
		"worker_count":       workerCount,
		"worker_server_type": workerType,
		"worker_arch":        hetznerServerArch(workerType),
		"control_plane_arch": hetznerServerArch(controlPlaneType),

		// Networking (non-overlapping ranges).
		"network_cidr": networkCIDR,
		"pod_cidr":     "10.244.0.0/16",
		"service_cidr": "10.96.0.0/12",
	}

	// The hcloud provider authenticates from HCLOUD_TOKEN in the runner env (activated
	// from the cloud identity), but the in-cluster hcloud-CCM + CSI driver need the token
	// as a Kubernetes Secret, which the template materializes from this tfvar. State lives
	// in the encrypted S3 backend (same as RDS passwords / custom secrets on the big clouds).
	if tok := os.Getenv("HCLOUD_TOKEN"); tok != "" {
		tfvars["hcloud_token"] = tok
	}

	// Generic passthrough: any provider_config key that names a template variable
	// flows through verbatim (talos_version consumed above under the same name is
	// merge-if-absent, so it isn't duplicated).
	mergeProviderConfig(tfvars, config.Cluster.ProviderConfig)

	return tfvars
}

// ConfigureKubeconfig writes the kubeconfig emitted by the Talos OpenTofu run to a
// per-worker HOME path and points KUBECONFIG at it. There is no cloud API call: the
// talos provider already produced a working kubeconfig as a (sensitive) output.
func (p *hetznerProvider) ConfigureKubeconfig(ctx context.Context, config *types.ProjectConfig, outputs map[string]interface{}, stdout io.Writer) error {
	kubeconfig := outputString(outputs, "kubeconfig")
	if kubeconfig == "" {
		return fmt.Errorf("no kubeconfig in Talos outputs")
	}
	fmt.Fprintf(stdout, "Writing Talos kubeconfig for cluster %s...\n", ExtractClusterName(outputs))

	// Absolute, HOME-based path (not cwd-relative) so concurrent worker subprocesses —
	// which share a cwd but each have a private HOME — never read each other's kubeconfig.
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = os.TempDir()
	}
	kubeDir := filepath.Join(home, ".alethia")
	kubeconfigPath := filepath.Join(kubeDir, "kubeconfig")
	if err := os.MkdirAll(kubeDir, 0700); err != nil {
		return err
	}
	if err := os.WriteFile(kubeconfigPath, []byte(kubeconfig), 0600); err != nil {
		return err
	}
	os.Setenv("KUBECONFIG", kubeconfigPath)
	fmt.Fprintf(stdout, "Kubeconfig written to %s\n", kubeconfigPath)
	return nil
}

// providerString reads a string from a provider_config JSONB map. Returns "" when
// absent or non-string.
func providerString(cfg map[string]any, key string) string {
	if cfg == nil {
		return ""
	}
	if v, ok := cfg[key].(string); ok {
		return v
	}
	return ""
}

// outputString reads a string OpenTofu output value, tolerating both the raw
// `{"value": ...}` wrapper (from `tofu output -json`) and a bare string.
func outputString(outputs map[string]interface{}, key string) string {
	val, ok := outputs[key]
	if !ok {
		return ""
	}
	if m, ok := val.(map[string]interface{}); ok {
		if s, ok := m["value"].(string); ok {
			return s
		}
		return ""
	}
	if s, ok := val.(string); ok {
		return s
	}
	return ""
}

var _ CloudProvider = (*hetznerProvider)(nil)
