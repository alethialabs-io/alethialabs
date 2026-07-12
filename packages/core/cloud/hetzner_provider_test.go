// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
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
