// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"net"
	"reflect"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// baseHetznerConfig returns a minimal, valid Hetzner project config for tfvars tests.
func baseHetznerConfig() *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName:      "acme",
		EnvironmentStage: "dev",
		Region:           "fsn1",
		Cluster:          types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
		Network:          types.ProjectNetworkConfig{CIDRBlock: "10.0.0.0/16"},
	}
}

// TestHetznerProvider_ProviderTfvars_Buckets verifies buckets are mapped to the minio
// shape and the S3 endpoint/region/keys are emitted when the keys are present in the env.
func TestHetznerProvider_ProviderTfvars_Buckets(t *testing.T) {
	t.Setenv("HETZNER_S3_ACCESS_KEY", "AK123")
	t.Setenv("HETZNER_S3_SECRET_KEY", "SK456")

	cfg := baseHetznerConfig()
	cfg.StorageBuckets = []types.ProjectStorageBucketConfig{
		{Name: "assets", Versioning: true, EncryptionEnabled: true, PublicAccess: true, CorsOrigins: []string{"https://a"}},
		{Name: "logs", Versioning: false, EncryptionEnabled: true, PublicAccess: false},
	}

	p := &hetznerProvider{}
	tfvars := p.ProviderTfvars(cfg)

	buckets, ok := tfvars["buckets"].([]map[string]interface{})
	if !ok {
		t.Fatalf("buckets tfvar has wrong type: %T", tfvars["buckets"])
	}
	if len(buckets) != 2 {
		t.Fatalf("expected 2 buckets, got %d", len(buckets))
	}
	if buckets[0]["name"] != "assets" || buckets[0]["versioning"] != true || buckets[0]["public_access"] != true {
		t.Errorf("assets bucket = %v", buckets[0])
	}
	if !reflect.DeepEqual(buckets[0]["cors_origins"], []string{"https://a"}) {
		t.Errorf("assets cors_origins = %v", buckets[0]["cors_origins"])
	}
	// nil CorsOrigins must serialize as [] not nil.
	if got := buckets[1]["cors_origins"]; !reflect.DeepEqual(got, []string{}) {
		t.Errorf("logs cors_origins = %#v, want []string{}", got)
	}

	if tfvars["hetzner_s3_endpoint"] != "fsn1.your-objectstorage.com" {
		t.Errorf("hetzner_s3_endpoint = %v", tfvars["hetzner_s3_endpoint"])
	}
	if tfvars["hetzner_s3_region"] != "fsn1" {
		t.Errorf("hetzner_s3_region = %v", tfvars["hetzner_s3_region"])
	}
	if tfvars["hetzner_s3_access_key"] != "AK123" {
		t.Errorf("hetzner_s3_access_key = %v", tfvars["hetzner_s3_access_key"])
	}
	if tfvars["hetzner_s3_secret_key"] != "SK456" {
		t.Errorf("hetzner_s3_secret_key = %v", tfvars["hetzner_s3_secret_key"])
	}
}

// TestHetznerProvider_ProviderTfvars_NoBuckets checks a bucket-free Hetzner cluster still
// emits an empty buckets list and does NOT require S3 keys (none in env => keys unset).
func TestHetznerProvider_ProviderTfvars_NoBuckets(t *testing.T) {
	// Ensure no S3 keys leak in from the ambient environment.
	t.Setenv("HETZNER_S3_ACCESS_KEY", "")
	t.Setenv("HETZNER_S3_SECRET_KEY", "")

	cfg := baseHetznerConfig()
	p := &hetznerProvider{}
	tfvars := p.ProviderTfvars(cfg)

	buckets, ok := tfvars["buckets"].([]map[string]interface{})
	if !ok || len(buckets) != 0 {
		t.Fatalf("expected empty buckets slice, got %#v", tfvars["buckets"])
	}
	if _, present := tfvars["hetzner_s3_access_key"]; present {
		t.Errorf("hetzner_s3_access_key must be absent when unset in env")
	}
	if _, present := tfvars["hetzner_s3_secret_key"]; present {
		t.Errorf("hetzner_s3_secret_key must be absent when unset in env")
	}
	// The endpoint/region are always emitted (they carry safe defaults).
	if tfvars["hetzner_s3_endpoint"] == nil || tfvars["hetzner_s3_region"] == nil {
		t.Errorf("endpoint/region should still be emitted")
	}
}

// TestHetznerProvider_ProviderTfvars_NodeTypes verifies the default node types are the
// currently-orderable amd64 cpx22 for BOTH pools (cax11 ARM is capacity-unreliable, cpx11
// is retired), that the control-plane type FOLLOWS the resolved worker type so a single
// instance_types override moves both pools together, and that arch is derived per type.
func TestHetznerProvider_ProviderTfvars_NodeTypes(t *testing.T) {
	p := &hetznerProvider{}

	// Default: both pools cpx22 (amd64). An amd64 default keeps need_arm64=false in the
	// template (no arm64 Talos image built).
	def := p.ProviderTfvars(baseHetznerConfig())
	if def["worker_server_type"] != "cpx22" || def["control_plane_server_type"] != "cpx22" {
		t.Errorf("default node types = worker %v / cp %v, want cpx22 / cpx22",
			def["worker_server_type"], def["control_plane_server_type"])
	}
	if def["worker_arch"] != "amd64" || def["control_plane_arch"] != "amd64" {
		t.Errorf("default arch = worker %v / cp %v, want amd64 / amd64",
			def["worker_arch"], def["control_plane_arch"])
	}

	// Override amd64: a single instance_types pin moves the control plane too (no forced
	// arm64 image build for a hard-coded arm CP).
	amd := baseHetznerConfig()
	amd.Cluster.InstanceTypes = []string{"cpx32"}
	ov := p.ProviderTfvars(amd)
	if ov["worker_server_type"] != "cpx32" || ov["control_plane_server_type"] != "cpx32" {
		t.Errorf("amd64 override = worker %v / cp %v, want cpx32 / cpx32",
			ov["worker_server_type"], ov["control_plane_server_type"])
	}
	if ov["worker_arch"] != "amd64" || ov["control_plane_arch"] != "amd64" {
		t.Errorf("amd64 override arch = worker %v / cp %v, want amd64 / amd64",
			ov["worker_arch"], ov["control_plane_arch"])
	}

	// Override ARM: the override still works both ways — cax11 puts BOTH pools on arm64.
	arm := baseHetznerConfig()
	arm.Cluster.InstanceTypes = []string{"cax11"}
	av := p.ProviderTfvars(arm)
	if av["worker_server_type"] != "cax11" || av["control_plane_server_type"] != "cax11" {
		t.Errorf("arm override = worker %v / cp %v, want cax11 / cax11",
			av["worker_server_type"], av["control_plane_server_type"])
	}
	if av["worker_arch"] != "arm64" || av["control_plane_arch"] != "arm64" {
		t.Errorf("arm override arch = worker %v / cp %v, want arm64 / arm64",
			av["worker_arch"], av["control_plane_arch"])
	}
}

// TestHetznerProvider_ProviderTfvars_TalosK8sVersions verifies the coupled Talos/Kubernetes
// pins (#879): the default is Talos v1.13.6 + a CONCRETE k8s patch 1.35.6 (Talos uses the value
// verbatim as the component image tag, so a bare minor would be unpullable), and both are
// overridable via provider_config. A bare-minor ClusterVersion from the console is deliberately
// NOT forwarded — Hetzner's k8s is Talos-coupled, not resolved from the catalog SSOT minor.
func TestHetznerProvider_ProviderTfvars_TalosK8sVersions(t *testing.T) {
	p := &hetznerProvider{}

	def := p.ProviderTfvars(baseHetznerConfig())
	if def["talos_version"] != "v1.13.6" {
		t.Errorf("default talos_version = %v, want v1.13.6", def["talos_version"])
	}
	if def["kubernetes_version"] != "1.35.6" {
		t.Errorf("default kubernetes_version = %v, want 1.35.6 (concrete patch)", def["kubernetes_version"])
	}

	// A bare-minor cluster version (as the console emits) must NOT leak through as an unpullable
	// image tag — the coupled patch default wins.
	minor := baseHetznerConfig()
	minor.Cluster.ClusterVersion = "1.35"
	if got := p.ProviderTfvars(minor)["kubernetes_version"]; got != "1.35.6" {
		t.Errorf("bare-minor ClusterVersion forwarded: kubernetes_version = %v, want 1.35.6", got)
	}

	// provider_config overrides both pins (e.g. an advanced pin to another supported patch).
	over := baseHetznerConfig()
	over.Cluster.ProviderConfig = map[string]any{"talos_version": "v1.13.5", "kubernetes_version": "1.34.10"}
	ov := p.ProviderTfvars(over)
	if ov["talos_version"] != "v1.13.5" || ov["kubernetes_version"] != "1.34.10" {
		t.Errorf("provider_config override = talos %v / k8s %v, want v1.13.5 / 1.34.10",
			ov["talos_version"], ov["kubernetes_version"])
	}
}

// TestHetznerProvider_ProviderTfvars_CIDRs verifies pod_cidr and service_cidr are
// non-overlapping SUBNETS of network_cidr (required by Cilium native-routing over the
// Hetzner private network — disjoint CIDRs break cross-node pod->apiserver routing).
// It checks the default network AND a custom network_cidr override, so the derivation
// tracks network_cidr rather than emitting the old hard-coded 10.244/10.96 constants.
func TestHetznerProvider_ProviderTfvars_CIDRs(t *testing.T) {
	p := &hetznerProvider{}

	for _, network := range []string{"10.0.0.0/16", "172.16.0.0/16", "10.10.0.0/16"} {
		cfg := baseHetznerConfig()
		cfg.Network.CIDRBlock = network
		tf := p.ProviderTfvars(cfg)

		if tf["network_cidr"] != network {
			t.Fatalf("network_cidr = %v, want %v", tf["network_cidr"], network)
		}
		pod, _ := tf["pod_cidr"].(string)
		svc, _ := tf["service_cidr"].(string)

		_, netNet, err := net.ParseCIDR(network)
		if err != nil {
			t.Fatalf("bad test network %q: %v", network, err)
		}
		for name, child := range map[string]string{"pod_cidr": pod, "service_cidr": svc} {
			ip, childNet, err := net.ParseCIDR(child)
			if err != nil {
				t.Fatalf("%s %q unparseable: %v", name, child, err)
			}
			// child ⊂ parent: child prefix >= parent prefix AND child network address ∈ parent.
			cOnes, _ := childNet.Mask.Size()
			pOnes, _ := netNet.Mask.Size()
			if cOnes < pOnes || !netNet.Contains(ip) {
				t.Errorf("network %s: %s %s is not a subnet of network_cidr", network, name, child)
			}
		}
		// pod and service must not overlap each other.
		_, podNet, _ := net.ParseCIDR(pod)
		_, svcNet, _ := net.ParseCIDR(svc)
		if podNet.Contains(svcNet.IP) || svcNet.Contains(podNet.IP) {
			t.Errorf("network %s: pod_cidr %s and service_cidr %s overlap", network, pod, svc)
		}
	}

	// Spot-check the canonical default split documented in checks.tf.
	def := p.ProviderTfvars(baseHetznerConfig())
	if def["pod_cidr"] != "10.0.128.0/17" {
		t.Errorf("default pod_cidr = %v, want 10.0.128.0/17", def["pod_cidr"])
	}
	if def["service_cidr"] != "10.0.96.0/19" {
		t.Errorf("default service_cidr = %v, want 10.0.96.0/19", def["service_cidr"])
	}
}

// TestHetznerS3Region verifies compute-only regions fall back to an Object Storage location.
func TestHetznerS3Region(t *testing.T) {
	cases := map[string]string{
		"fsn1": "fsn1",
		"nbg1": "nbg1",
		"hel1": "hel1",
		"ash":  "fsn1", // no Object Storage in ash -> fallback
		"sin":  "fsn1",
		"":     "fsn1",
	}
	for in, want := range cases {
		if got := hetznerS3Region(in); got != want {
			t.Errorf("hetznerS3Region(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestBuildHetznerBuckets verifies the field mapping and nil-safe CORS slice.
func TestBuildHetznerBuckets(t *testing.T) {
	if got := buildHetznerBuckets(nil); len(got) != 0 {
		t.Errorf("nil buckets => %v, want empty", got)
	}
	got := buildHetznerBuckets([]types.ProjectStorageBucketConfig{
		{Name: "b", Versioning: true, EncryptionEnabled: false, PublicAccess: false},
	})
	want := map[string]interface{}{
		"name":               "b",
		"versioning":         true,
		"encryption_enabled": false,
		"public_access":      false,
		"cors_origins":       []string{},
	}
	if !reflect.DeepEqual(got[0], want) {
		t.Errorf("bucket = %#v, want %#v", got[0], want)
	}
}

// ---------------------------------------------------------------------------
// #1816 — the two Hetzner cells the carrier probe found: dns:enabled and
// network:provision_network. Both switches used to reach NO tfvar at all.
// ---------------------------------------------------------------------------

// TestHetznerProvider_ProviderTfvars_DNS asserts the canvas's DNS switch reaches the plan in BOTH
// positions and carries the domain with it.
//
// The invariant: `cloud_dns_enabled` is true exactly when the user turned DNS on AND named no
// existing zone — the same rule aws applies — and it is false otherwise. Asserting only the ON
// case would pass for a provider that hardcoded the value, which is the exact defect the carrier
// probe exists to catch: a switch that travels and means nothing.
func TestHetznerProvider_ProviderTfvars_DNS(t *testing.T) {
	p := &hetznerProvider{}

	// OFF — the default for every Hetzner project today. Nothing must ask for a zone.
	off := p.ProviderTfvars(baseHetznerConfig())
	if off["cloud_dns_enabled"] != false {
		t.Errorf("cloud_dns_enabled = %v with DNS off, want false", off["cloud_dns_enabled"])
	}
	if off["dns_main_domain"] != "" {
		t.Errorf("dns_main_domain = %v with DNS off, want empty", off["dns_main_domain"])
	}
	if off["dns_hosted_zone"] != "" {
		t.Errorf("dns_hosted_zone = %v with DNS off, want empty", off["dns_hosted_zone"])
	}

	// ON, no existing zone — Alethia creates and owns the zone.
	on := baseHetznerConfig()
	on.DNS = types.ProjectDNSConfig{Enabled: true, DomainName: "acme.example"}
	got := p.ProviderTfvars(on)
	if got["cloud_dns_enabled"] != true {
		t.Errorf("cloud_dns_enabled = %v with DNS on and no zone id, want true", got["cloud_dns_enabled"])
	}
	if got["dns_main_domain"] != "acme.example" {
		t.Errorf("dns_main_domain = %v, want acme.example", got["dns_main_domain"])
	}

	// ON with an existing zone — the user already owns it, so the template must NOT create a
	// second one; the id is carried instead. This is the branch that makes the switch a decision
	// rather than a boolean, and it is the one a presence-only assertion cannot see.
	byo := baseHetznerConfig()
	byo.DNS = types.ProjectDNSConfig{Enabled: true, DomainName: "acme.example", ZoneID: "9911"}
	byoVars := p.ProviderTfvars(byo)
	if byoVars["cloud_dns_enabled"] != false {
		t.Errorf("cloud_dns_enabled = %v with an existing zone id, want false (do not create a second zone)", byoVars["cloud_dns_enabled"])
	}
	if byoVars["dns_hosted_zone"] != "9911" {
		t.Errorf("dns_hosted_zone = %v, want 9911", byoVars["dns_hosted_zone"])
	}
}

// TestHetznerProvider_ProviderTfvars_ProvisionNetwork asserts the network switch reaches the plan
// in BOTH positions, and that the "unset" case still provisions.
//
// The invariant matches aws/gcp: provision unless the user explicitly opted out AND named a
// network to attach to. A project that never touched the switch keeps creating its own network,
// so no existing Hetzner cluster changes shape when this lands.
func TestHetznerProvider_ProviderTfvars_ProvisionNetwork(t *testing.T) {
	p := &hetznerProvider{}

	// Explicitly on.
	on := baseHetznerConfig()
	on.Network = types.ProjectNetworkConfig{CIDRBlock: "10.0.0.0/16", ProvisionNetwork: true}
	if got := p.ProviderTfvars(on)["provision_network"]; got != true {
		t.Errorf("provision_network = %v with the switch on, want true", got)
	}

	// Unset and no network named — the pre-#1816 behaviour, which must be preserved.
	def := p.ProviderTfvars(baseHetznerConfig())
	if def["provision_network"] != true {
		t.Errorf("provision_network = %v with nothing set, want true (default is still greenfield)", def["provision_network"])
	}
	if def["network_id"] != "" {
		t.Errorf("network_id = %v with nothing set, want empty", def["network_id"])
	}

	// Off WITH a network named — the case the cell is about. This is the value that has to differ
	// from the default; if it did not, the switch would be inert whichever way a user set it.
	byo := baseHetznerConfig()
	byo.Network = types.ProjectNetworkConfig{CIDRBlock: "10.0.0.0/16", ProvisionNetwork: false, NetworkID: "4242"}
	byoVars := p.ProviderTfvars(byo)
	if byoVars["provision_network"] != false {
		t.Errorf("provision_network = %v with the switch off and a network named, want false", byoVars["provision_network"])
	}
	if byoVars["network_id"] != "4242" {
		t.Errorf("network_id = %v, want 4242", byoVars["network_id"])
	}

	// THE BROWNFIELD CIDR RULE. `network_cidr` is IGNORED when attaching an existing network — the
	// attached network's own ip_range is the supernet — so a pod/service split derived from it
	// describes a network the cluster is not on. The canvas hides the CIDR field on this path too,
	// so every such request would carry the same 10.0.0.0/16 default and trip the template's
	// fail-closed guard. Leaving them unset hands the derivation to the template, which is the only
	// place that knows what actually resolved.
	if byoVars["pod_cidr"] != nil {
		t.Errorf("pod_cidr = %v on the brownfield path, want nil (the template derives it from the resolved network)", byoVars["pod_cidr"])
	}
	if byoVars["service_cidr"] != nil {
		t.Errorf("service_cidr = %v on the brownfield path, want nil", byoVars["service_cidr"])
	}

	// The greenfield path still sends them: there we emit network_cidr, so we know the answer, and
	// these are the values every Hetzner cluster built so far already has.
	green := baseHetznerConfig()
	green.Network = types.ProjectNetworkConfig{CIDRBlock: "10.0.0.0/16", ProvisionNetwork: true}
	greenVars := p.ProviderTfvars(green)
	if greenVars["pod_cidr"] != "10.0.128.0/17" || greenVars["service_cidr"] != "10.0.96.0/19" {
		t.Errorf("greenfield pod/service = %v / %v, want 10.0.128.0/17 / 10.0.96.0/19", greenVars["pod_cidr"], greenVars["service_cidr"])
	}

	// Off with NOTHING named is not a request to attach — there is nothing to attach to. Falling
	// back to provisioning is what aws and gcp do, and the alternative is a plan that refuses.
	empty := baseHetznerConfig()
	empty.Network = types.ProjectNetworkConfig{CIDRBlock: "10.0.0.0/16", ProvisionNetwork: false}
	if got := p.ProviderTfvars(empty)["provision_network"]; got != true {
		t.Errorf("provision_network = %v with the switch off and no network named, want true", got)
	}
}

// The in-cluster registry hosts are what let talos.tf render a containerd mirror. Without a mirror
// entry the kubelet refuses a plain-HTTP cluster-local host outright, and the pull failure looks
// like a credential problem — so a dropped or misspelt host here is invisible until a real cluster.
func TestHetznerProvider_ProviderTfvars_InClusterRegistryHosts(t *testing.T) {
	p := &hetznerProvider{}
	cfg := baseHetznerConfig()

	// Always emitted, even empty: a registry-free cluster must still plan clean.
	tfvars := p.ProviderTfvars(cfg)
	hosts, ok := tfvars["incluster_registry_hosts"].([]string)
	if !ok {
		t.Fatalf("incluster_registry_hosts = %T, want []string", tfvars["incluster_registry_hosts"])
	}
	if len(hosts) != 0 {
		t.Errorf("a registry-free project emitted %v", hosts)
	}

	cfg.ContainerRegistries = []types.ProjectContainerRegistryConfig{
		{Name: "app-images"}, {Name: ""}, {Name: "base"},
	}
	hosts, _ = p.ProviderTfvars(cfg)["incluster_registry_hosts"].([]string)
	want := []string{
		"registry-app-images.registries.svc.cluster.local",
		"registry-base.registries.svc.cluster.local",
	}
	if len(hosts) != len(want) {
		t.Fatalf("emitted %v, want %v", hosts, want)
	}
	for i := range want {
		// This string must equal the chart's externalURL host and the dockerconfigjson key —
		// argocd.HetznerRegistries derives the same shape and a test there pins the agreement.
		if hosts[i] != want[i] {
			t.Errorf("host[%d] = %q, want %q", i, hosts[i], want[i])
		}
	}
}
