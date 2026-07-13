// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"regexp"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// k8sLabelSegment matches a valid Kubernetes label name/value segment (RFC1123): ≤63 chars,
// starts and ends alphanumeric, interior may include '-', '_', '.'.
var k8sLabelSegment = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$`)

// assertValidLabelKey fails the test unless key is a valid Kubernetes label key: the mandatory
// "alethia.io" DNS-subdomain prefix, a "/", then a ≤63 name segment.
func assertValidLabelKey(t *testing.T, key string) {
	t.Helper()
	prefix, name, ok := strings.Cut(key, "/")
	if !ok {
		t.Fatalf("label key %q has no prefix/ segment", key)
	}
	if prefix != "alethia.io" {
		t.Errorf("label key %q: prefix = %q, want alethia.io", key, prefix)
	}
	if len(name) == 0 || len(name) > 63 || !k8sLabelSegment.MatchString(name) {
		t.Errorf("label key %q: name segment %q is not a valid ≤63 k8s label name", key, name)
	}
}

// assertValidLabelValue fails the test unless value is a valid Kubernetes label value.
func assertValidLabelValue(t *testing.T, value string) {
	t.Helper()
	if value == "" {
		return // empty values are valid k8s labels — but we never emit them (see the skip tests)
	}
	if len(value) > 63 || !k8sLabelSegment.MatchString(value) {
		t.Errorf("label value %q is not a valid ≤63 k8s label value", value)
	}
}

// assertAllValid checks every emitted (key, value) pair is a valid k8s label and never empty-valued.
func assertAllValid(t *testing.T, labels map[string]string) {
	t.Helper()
	for k, v := range labels {
		assertValidLabelKey(t, k)
		assertValidLabelValue(t, v)
		if v == "" {
			t.Errorf("label %q has an empty value — should have been skipped", k)
		}
	}
}

func TestClassificationLabels_AlwaysEmitsSweepHandles(t *testing.T) {
	cfg := &types.ProjectConfig{ID: "proj-1", EnvironmentID: "env-1"}
	got := ClassificationLabels(cfg)
	if got["alethia.io/project-id"] != "proj-1" {
		t.Errorf("project-id handle missing/wrong: %v", got)
	}
	if got["alethia.io/environment-id"] != "env-1" {
		t.Errorf("environment-id handle missing/wrong: %v", got)
	}
	if len(got) != 2 {
		t.Errorf("expected exactly the 2 handles, got %v", got)
	}
	assertAllValid(t, got)
}

func TestClassificationLabels_OmitsEmptyEnvironmentID(t *testing.T) {
	got := ClassificationLabels(&types.ProjectConfig{ID: "proj-1"})
	if _, ok := got["alethia.io/environment-id"]; ok {
		t.Errorf("environment-id should be absent when empty: %v", got)
	}
	if got["alethia.io/project-id"] != "proj-1" {
		t.Errorf("project-id still required: %v", got)
	}
}

func TestClassificationLabels_DimensionsFoldedAndPrefixed(t *testing.T) {
	got := ClassificationLabels(classifiedConfig())
	// Multi-value dimension: values sorted (internal < pii) then joined with "_".
	if got["alethia.io/data-class"] != "internal_pii" {
		t.Errorf("data-class = %q, want internal_pii (%v)", got["alethia.io/data-class"], got)
	}
	if got["alethia.io/tier"] != "prod" {
		t.Errorf("tier = %q, want prod", got["alethia.io/tier"])
	}
	assertAllValid(t, got)
}

// The mandatory handle must survive a classification dimension that folds to the same key — a
// guarded sweeper keys off alethia.io/project-id, so an attacker-controlled dimension named
// "project-id" must NOT be able to redirect it.
func TestClassificationLabels_HandleWinsOverCollidingDimension(t *testing.T) {
	cfg := &types.ProjectConfig{
		ID:             "real-project",
		EnvironmentID:  "real-env",
		Classification: map[string][]string{"project-id": {"attacker"}, "environment-id": {"spoof"}},
	}
	got := ClassificationLabels(cfg)
	if got["alethia.io/project-id"] != "real-project" {
		t.Errorf("project-id handle clobbered: %q (%v)", got["alethia.io/project-id"], got)
	}
	if got["alethia.io/environment-id"] != "real-env" {
		t.Errorf("environment-id handle clobbered: %q (%v)", got["alethia.io/environment-id"], got)
	}
}

// Pathological dimension names/values (uppercase, spaces, unicode, symbols, over-length) must all
// fold to valid k8s labels — never produce an invalid key/value that would make ArgoCD reject the
// Application at apply time.
func TestClassificationLabels_PathologicalInputsStayValid(t *testing.T) {
	cfg := &types.ProjectConfig{
		ID:            "proj-1",
		EnvironmentID: "env-1",
		Classification: map[string][]string{
			"Data Sensitivity":       {"Highly Confidential"},
			"owner/team!":            {"café ☕ crew"},
			strings.Repeat("d", 200): {strings.Repeat("v", 200)},
			"team.name":              {"a.b.c"},
			"-leading-trailing-":     {"-x-"},
		},
	}
	got := ClassificationLabels(cfg)
	assertAllValid(t, got) // the core guarantee — every emitted label is apply-safe
	// The handles still survive amid the noise.
	if got["alethia.io/project-id"] != "proj-1" || got["alethia.io/environment-id"] != "env-1" {
		t.Errorf("handles missing under pathological input: %v", got)
	}
}

// A dimension name that folds away entirely (only invalid charset) is skipped, not emitted with an
// empty key.
func TestClassificationLabels_EmptyFoldedNameSkipped(t *testing.T) {
	cfg := &types.ProjectConfig{
		ID:             "proj-1",
		Classification: map[string][]string{"☕☕☕": {"value"}},
	}
	got := ClassificationLabels(cfg)
	for k := range got {
		if strings.HasSuffix(k, "/") || k == "alethia.io/" {
			t.Errorf("emitted an empty-name key: %q", k)
		}
	}
	// Only the project-id handle should remain.
	if len(got) != 1 || got["alethia.io/project-id"] != "proj-1" {
		t.Errorf("expected only the project-id handle, got %v", got)
	}
}

// Deterministic output — same config yields identical maps (stable label sets = stable ArgoCD diffs).
func TestClassificationLabels_Deterministic(t *testing.T) {
	a := ClassificationLabels(classifiedConfig())
	b := ClassificationLabels(classifiedConfig())
	if len(a) != len(b) {
		t.Fatalf("nondeterministic size: %d vs %d", len(a), len(b))
	}
	for k, v := range a {
		if b[k] != v {
			t.Errorf("key %q: %q vs %q", k, v, b[k])
		}
	}
}
