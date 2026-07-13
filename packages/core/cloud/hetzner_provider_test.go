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
