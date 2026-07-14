// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// A config with two classification dimensions (one multi-valued) plus the id handles.
func classifiedConfig() *types.ProjectConfig {
	return &types.ProjectConfig{
		ID:            "proj-123",
		EnvironmentID: "env-456",
		Classification: map[string][]string{
			"data-class": {"pii", "internal"}, // multi-valued, deliberately unsorted
			"tier":       {"prod"},
		},
	}
}

func TestClassificationTags_AlwaysEmitsSweepHandles(t *testing.T) {
	// Even with no classification, project-id + environment-id must be present.
	cfg := &types.ProjectConfig{ID: "proj-1", EnvironmentID: "env-1"}
	tags := classificationTags(cfg, awsTagStyle)
	if tags["alethia:project-id"] != "proj-1" {
		t.Errorf("project-id handle missing/wrong: %v", tags)
	}
	if tags["alethia:environment-id"] != "env-1" {
		t.Errorf("environment-id handle missing/wrong: %v", tags)
	}
	if len(tags) != 2 {
		t.Errorf("expected exactly the 2 handles, got %v", tags)
	}
}

func TestClassificationTags_OmitsEmptyEnvironmentID(t *testing.T) {
	cfg := &types.ProjectConfig{ID: "proj-1"} // no EnvironmentID
	tags := classificationTags(cfg, awsTagStyle)
	if _, ok := tags["alethia:environment-id"]; ok {
		t.Errorf("environment-id should be absent when empty: %v", tags)
	}
	if tags["alethia:project-id"] != "proj-1" {
		t.Errorf("project-id still required: %v", tags)
	}
}

func TestClassificationTags_MultiValueSortedAndJoined(t *testing.T) {
	tags := classificationTags(classifiedConfig(), awsTagStyle)
	// values sorted (internal < pii) then joined with "_".
	if got := tags["alethia:data-class"]; got != "internal_pii" {
		t.Errorf("data-class = %q, want internal_pii", got)
	}
	if got := tags["alethia:tier"]; got != "prod" {
		t.Errorf("tier = %q, want prod", got)
	}
}

func TestClassificationTags_AWSAzureAlibabaUseColonKeys(t *testing.T) {
	for name, st := range map[string]tagStyle{"aws": awsTagStyle, "azure": azureTagStyle, "alibaba": alibabaTagStyle} {
		tags := classificationTags(classifiedConfig(), st)
		if _, ok := tags["alethia:project-id"]; !ok {
			t.Errorf("%s: expected colon-namespaced key alethia:project-id, got %v", name, tags)
		}
	}
}

func TestClassificationTags_GCPLabelsAreLowercaseColonFree(t *testing.T) {
	cfg := &types.ProjectConfig{
		ID:             "Proj-UPPER",
		EnvironmentID:  "Env-Mixed",
		Classification: map[string][]string{"Data-Class": {"PII"}},
	}
	tags := classificationTags(cfg, gcpTagStyle)
	for k, v := range tags {
		if strings.Contains(k, ":") {
			t.Errorf("GCP label key must not contain a colon: %q", k)
		}
		if k != strings.ToLower(k) || v != strings.ToLower(v) {
			t.Errorf("GCP label must be lowercase: %q=%q", k, v)
		}
	}
	// underscore-namespaced + lowercased.
	if tags["alethia_project-id"] != "proj-upper" {
		t.Errorf("GCP project-id label = %v, want alethia_project-id=proj-upper", tags)
	}
	if _, ok := tags["alethia_data-class"]; !ok {
		t.Errorf("GCP dimension label alethia_data-class missing: %v", tags)
	}
}

func TestClassificationTags_HetznerLabelsK8sSafe(t *testing.T) {
	tags := classificationTags(classifiedConfig(), hetznerTagStyle)
	// underscore-namespaced (K8s label keys can't hold a colon).
	if _, ok := tags["alethia_project-id"]; !ok {
		t.Errorf("hetzner project-id label alethia_project-id missing: %v", tags)
	}
	for k, v := range tags {
		if strings.Contains(k, ":") {
			t.Errorf("hetzner (K8s) label key must not contain a colon: %q", k)
		}
		// must begin/end alphanumeric
		if v != "" && (strings.HasPrefix(v, "-") || strings.HasSuffix(v, "-") ||
			strings.HasPrefix(v, "_") || strings.HasSuffix(v, "_") ||
			strings.HasPrefix(v, ".") || strings.HasSuffix(v, ".")) {
			t.Errorf("hetzner label value must start/end alphanumeric: %q", v)
		}
	}
}

func TestClip_CollisionSafeTruncation(t *testing.T) {
	// Two distinct long strings sharing a long common prefix must NOT clip to the same value.
	a := strings.Repeat("x", 70) + "AAAA"
	b := strings.Repeat("x", 70) + "BBBB"
	ca, cb := clip(a, 63), clip(b, 63)
	if len(ca) > 63 || len(cb) > 63 {
		t.Fatalf("clip exceeded max: %d, %d", len(ca), len(cb))
	}
	if ca == cb {
		t.Errorf("distinct long inputs collided after clip: %q == %q", ca, cb)
	}
	// A short string is returned unchanged.
	if clip("short", 63) != "short" {
		t.Errorf("short string should be unchanged")
	}
}

func TestClassificationTags_LongDimensionTruncatedWithinLimit(t *testing.T) {
	cfg := &types.ProjectConfig{
		ID:             "p",
		Classification: map[string][]string{strings.Repeat("d", 200): {strings.Repeat("v", 200)}},
	}
	tags := classificationTags(cfg, gcpTagStyle) // tightest: 63/63
	for k, v := range tags {
		if len(k) > 63 {
			t.Errorf("GCP key over 63 chars: %d (%q)", len(k), k)
		}
		if len(v) > 63 {
			t.Errorf("GCP value over 63 chars: %d", len(v))
		}
	}
}

// Every provider's ProviderTfvars must emit the classification_tags map carrying the sweep handle.
func TestProviderTfvars_AllCloudsEmitClassificationTags(t *testing.T) {
	base := func(provider string) *types.ProjectConfig {
		return &types.ProjectConfig{
			ID:             "proj-abc",
			EnvironmentID:  "env-xyz",
			ProjectName:    "acme",
			Provider:       provider,
			Region:         "eu-central-1",
			Classification: map[string][]string{"tier": {"prod"}},
		}
	}
	cases := []struct {
		provider string
		colonKey bool // true → colon-style handle key; false → underscore
	}{
		{"aws", true}, {"azure", true}, {"alibaba", true},
		{"gcp", false}, {"hetzner", false},
	}
	for _, c := range cases {
		p, err := NewCloudProvider(c.provider)
		if err != nil {
			t.Fatalf("%s: NewCloudProvider: %v", c.provider, err)
		}
		tfvars := p.ProviderTfvars(base(c.provider))
		raw, ok := tfvars["classification_tags"]
		if !ok {
			t.Errorf("%s: classification_tags tfvar missing", c.provider)
			continue
		}
		tags, ok := raw.(map[string]string)
		if !ok {
			t.Errorf("%s: classification_tags is %T, want map[string]string", c.provider, raw)
			continue
		}
		wantKey := "alethia:project-id"
		if !c.colonKey {
			wantKey = "alethia_project-id"
		}
		if tags[wantKey] != "proj-abc" {
			t.Errorf("%s: %s = %q, want proj-abc (tags=%v)", c.provider, wantKey, tags[wantKey], tags)
		}
	}
}

// A classification dimension must never clobber the mandatory sweep handles — the platform
// base tags win conflicts (a wrong project-id/environment-id would misdirect a guarded sweeper).
func TestClassificationTags_DimensionCannotClobberSweepHandles(t *testing.T) {
	cfg := &types.ProjectConfig{
		ID:            "proj-real",
		EnvironmentID: "env-real",
		Classification: map[string][]string{
			"project-id":     {"attacker"}, // renders to alethia:project-id under AWS
			"environment-id": {"attacker"},
		},
	}
	tags := classificationTags(cfg, awsTagStyle)
	if tags["alethia:project-id"] != "proj-real" {
		t.Errorf("sweep handle clobbered by dimension: alethia:project-id = %q, want proj-real", tags["alethia:project-id"])
	}
	if tags["alethia:environment-id"] != "env-real" {
		t.Errorf("sweep handle clobbered by dimension: alethia:environment-id = %q, want env-real", tags["alethia:environment-id"])
	}
	// Same attack via GCP charset-folding: a "Project-Id" dimension lowercases into the handle key.
	gcfg := &types.ProjectConfig{
		ID:             "proj-gcp",
		Classification: map[string][]string{"Project-Id": {"attacker"}},
	}
	gtags := classificationTags(gcfg, gcpTagStyle)
	if gtags["alethia_project-id"] != "proj-gcp" {
		t.Errorf("GCP sweep handle clobbered by folded dimension: alethia_project-id = %q, want proj-gcp", gtags["alethia_project-id"])
	}
}
