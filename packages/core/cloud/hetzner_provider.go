// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
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

// cidrSubnet carves a sub-CIDR out of base, mirroring Terraform's cidrsubnet(): it
// extends base's prefix by newBits and selects the netNum-th block within it (e.g.
// cidrSubnet("10.0.0.0/16", 1, 1) => "10.0.128.0/17"). IPv4 only (the Hetzner template
// is IPv4). Returns "" for an unparseable/oversized input so callers fall back to a
// safe literal default.
func cidrSubnet(base string, newBits, netNum int) string {
	_, ipnet, err := net.ParseCIDR(base)
	if err != nil {
		return ""
	}
	ip := ipnet.IP.To4()
	if ip == nil {
		return ""
	}
	ones, _ := ipnet.Mask.Size()
	newPrefix := ones + newBits
	if newPrefix < 0 || newPrefix > 32 {
		return ""
	}
	shift := uint(32 - newPrefix)
	// netNum must fit within the newly added bits.
	if newBits < 0 || (newBits < 32 && netNum >= (1<<uint(newBits))) || netNum < 0 {
		return ""
	}
	sub := binary.BigEndian.Uint32(ip) | (uint32(netNum) << shift)
	var out [4]byte
	binary.BigEndian.PutUint32(out[:], sub)
	return fmt.Sprintf("%d.%d.%d.%d/%d", out[0], out[1], out[2], out[3], newPrefix)
}

func (p *hetznerProvider) ProviderTfvars(config *types.ProjectConfig) map[string]interface{} {
	// Node sizing: prefer an explicit/ resolved instance type, else a cheap, orderable
	// amd64 default (cpx22 = 2 vCPU / 4 GB). cax11 (ARM) is capacity-unreliable and
	// cpx11 is retired, so an amd64 shared-vCPU type is the reliably-provisionable default.
	workerType := "cpx22"
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
	// The CP server type follows the resolved worker type so a single instance_types
	// override moves BOTH pools together — otherwise a pinned amd64 worker still forces
	// an arm64 Talos image build for a hard-coded arm64 CP, making the cluster
	// unprovisionable during a Hetzner ARM (cax) capacity shortage.
	controlPlaneType := workerType
	controlPlaneCount := 1

	// Pod + service CIDRs MUST be non-overlapping SUBNETS of network_cidr: the template
	// runs Cilium in native-routing mode with ipv4NativeRoutingCIDR = network_cidr, and
	// the node's `network_cidr via <gw> dev eth1` route + the private-network firewall
	// only cover pods/services that live inside network_cidr. Disjoint CIDRs (the old
	// hard-coded 10.244.0.0/16 / 10.96.0.0/12) break cross-node pod->apiserver routing —
	// a real hel1 provision came up Ready then failed the datapath gate (a pod could not
	// reach the API ClusterIP cross-node). Derive them from network_cidr with the same
	// split checks.tf documents (pod = upper /17, service = /19), disjoint from the node
	// subnet (first /24), so the invariant holds for ANY network_cidr override.
	networkCIDR := orDefault(config.Network.CIDRBlock, "10.0.0.0/16")
	podCIDR := orDefault(cidrSubnet(networkCIDR, 1, 1), "10.0.128.0/17")
	serviceCIDR := orDefault(cidrSubnet(networkCIDR, 3, 3), "10.0.96.0/19")

	tfvars := map[string]interface{}{
		"project_name": config.ProjectName,
		"environment":  config.EnvironmentStage,
		"region":       orDefault(resolveRegion("hetzner", config.Region), "fsn1"),

		// Talos / Kubernetes versions (pin via provider_config to override).
		// Cloud-parity note (#879 lifts the #775 exclusion): the catalog SSOT default is now 1.35 for
		// Hetzner too, but its k8s version is coupled to the pinned Talos release and — unlike the
		// managed clouds, which accept a bare minor — Talos installs the version VERBATIM as the
		// component image tag (registry.k8s.io/kube-apiserver:v<ver>), which only exists per-patch.
		// So we pin a concrete PATCH in lockstep with talos_version (Talos v1.13.6 → k8s 1.35.6) rather
		// than passing the SSOT minor through; override either via provider_config. config.Cluster.
		// ClusterVersion (a bare minor from the console) is deliberately NOT forwarded here — it would
		// resolve to an unpullable image tag.
		"talos_version":      orDefault(providerString(config.Cluster.ProviderConfig, "talos_version"), "v1.13.6"),
		"kubernetes_version": orDefault(providerString(config.Cluster.ProviderConfig, "kubernetes_version"), "1.35.6"),

		// Control plane (single-node, cheapest).
		"control_plane_count":       controlPlaneCount,
		"control_plane_server_type": controlPlaneType,

		// Workers.
		"worker_count":       workerCount,
		"worker_server_type": workerType,
		"worker_arch":        hetznerServerArch(workerType),
		"control_plane_arch": hetznerServerArch(controlPlaneType),

		// Networking (pod/service are non-overlapping subnets of network_cidr).
		"network_cidr": networkCIDR,
		"pod_cidr":     podCIDR,
		"service_cidr": serviceCIDR,
	}

	// The hcloud provider authenticates from HCLOUD_TOKEN in the runner env (activated
	// from the cloud identity), but the in-cluster hcloud-CCM + CSI driver need the token
	// as a Kubernetes Secret, which the template materializes from this tfvar. State lives
	// in the encrypted S3 backend (same as RDS passwords / custom secrets on the big clouds).
	if tok := os.Getenv("HCLOUD_TOKEN"); tok != "" {
		tfvars["hcloud_token"] = tok
	}

	// Object Storage (S3-compatible) buckets via the aminueza/minio provider against Hetzner's
	// S3 endpoint. Buckets are periphery: always emit the list (empty => the minio provider is
	// declared but never exercised, so a bucket-free cluster still plans clean with empty S3
	// creds). The S3 endpoint host derives from the region; Object Storage lives only in
	// fsn1/nbg1/hel1, so compute-only regions fall back to fsn1. The S3 keys are DISTINCT from
	// the Cloud API token (Hetzner has no API to mint them — the customer generates them by
	// hand); the runner exports them as HETZNER_S3_ACCESS_KEY / HETZNER_S3_SECRET_KEY at claim.
	tfvars["buckets"] = buildHetznerBuckets(config.StorageBuckets)
	s3Region := hetznerS3Region(orDefault(resolveRegion("hetzner", config.Region), "fsn1"))
	tfvars["hetzner_s3_region"] = s3Region
	tfvars["hetzner_s3_endpoint"] = s3Region + ".your-objectstorage.com"
	if ak := os.Getenv("HETZNER_S3_ACCESS_KEY"); ak != "" {
		tfvars["hetzner_s3_access_key"] = ak
	}
	if sk := os.Getenv("HETZNER_S3_SECRET_KEY"); sk != "" {
		tfvars["hetzner_s3_secret_key"] = sk
	}

	// Generic passthrough: any provider_config key that names a template variable
	// flows through verbatim (talos_version consumed above under the same name is
	// merge-if-absent, so it isn't duplicated).
	// B1.2: classification → node labels (+ the always-on project-id/environment-id sweep
	// handles), Hetzner/K8s-styled (`alethia_...`, ≤63, alnum boundaries). Set before
	// mergeProviderConfig so a user's provider_config can't shadow it. Consumed by the
	// classification_tags var (B1.3).
	tfvars["classification_tags"] = classificationTags(config, hetznerTagStyle)

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

// hetznerS3Locations are the Hetzner Object Storage locations (a strict subset of the
// hcloud compute regions — Object Storage is not offered in ash/hil/sin).
var hetznerS3Locations = map[string]bool{"fsn1": true, "nbg1": true, "hel1": true}

// hetznerS3Region maps a cluster region to a valid Object Storage location. Compute-only
// regions (ash/hil/sin) have no Object Storage, so they fall back to fsn1.
func hetznerS3Region(region string) string {
	if hetznerS3Locations[region] {
		return region
	}
	return "fsn1"
}

// buildHetznerBuckets maps the cloud-indifferent bucket configs to the shape the hetzner
// template's `buckets` tfvar (and the minio provider) consumes. CORS is intentionally
// carried through but the aminueza/minio provider does NOT apply it against Hetzner
// (s3_compat_mode skips CORS) — it is ignored, never a failure. `encryption_enabled` is
// likewise informational: Hetzner Object Storage encrypts at rest automatically and the
// provider exposes no per-bucket toggle.
func buildHetznerBuckets(buckets []types.ProjectStorageBucketConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(buckets))
	for _, b := range buckets {
		result = append(result, map[string]interface{}{
			"name":               b.Name,
			"versioning":         b.Versioning,
			"encryption_enabled": b.EncryptionEnabled,
			"public_access":      b.PublicAccess,
			"cors_origins":       ensureStringSlice(b.CorsOrigins),
		})
	}
	return result
}

// ensureStringSlice returns a non-nil slice so the emitted tfvar is a JSON [] rather than
// null (the minio template's optional(list(string), []) default only kicks in when the
// key is absent, not when it is JSON null).
func ensureStringSlice(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

var _ CloudProvider = (*hetznerProvider)(nil)
