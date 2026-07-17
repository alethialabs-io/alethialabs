// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestRenderExternalSecret_WithMarkerLabel(t *testing.T) {
	yaml, skipped, err := RenderExternalSecret(ExternalSecretParams{
		ServiceName: "web",
		Namespace:   "ns",
		Target:      types.ServiceBindingTarget{Kind: "database", Name: "orders"},
		Provider:    "aws",
		RemoteKey:   "arn:secret",
		Facets:      []string{"password"},
		Labels:      map[string]string{"alethia.io/byo-binding": "true"},
	})
	if err != nil || len(skipped) != 0 {
		t.Fatalf("render err=%v skipped=%v", err, skipped)
	}
	// The marker (for PruneChartBindingSecrets) AND the always-present labels are both there.
	if !strings.Contains(yaml, "alethia.io/byo-binding: true") {
		t.Fatalf("marker label not rendered:\n%s", yaml)
	}
	if !strings.Contains(yaml, "app.kubernetes.io/managed-by: alethia") {
		t.Fatalf("fixed labels dropped when adding an extra one:\n%s", yaml)
	}
}

func chartDBBinding(facets ...[2]string) types.ServiceBinding {
	b := types.ServiceBinding{Target: types.ServiceBindingTarget{Kind: "database", Name: "orders"}}
	for _, f := range facets {
		b.Inject = append(b.Inject, types.ServiceBindingInjection{Env: f[0], From: types.ServiceBindingFacet(f[1])})
	}
	return b
}

func TestResolveChartWorkloadBindings_Satisfiable(t *testing.T) {
	binding := chartDBBinding(
		[2]string{"DB_HOST", "endpoint"},
		[2]string{"DB_PORT", "port"},
		[2]string{"DB_PASS", "password"},
	)
	valuePaths := map[string]string{
		ChartBindingKnob("database", "orders", "endpoint"): "externalDatabase.host",
		ChartBindingKnob("database", "orders", "port"):     "externalDatabase.port",
		ChartBindingKnob("database", "orders", "password"): "auth.existingSecret",
	}
	outputs := map[string]string{
		"rds_cluster_endpoint":               "db.internal:5432",
		"rds_master_credentials_secret_name": "arn:aws:secretsmanager:...:db-master",
	}

	res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding}, valuePaths, outputs, "aws", "web-ns")

	wantPatches := map[string]any{
		"externalDatabase.host": "db.internal:5432",
		"externalDatabase.port": "5432",
		"auth.existingSecret":   BindingSecretName("web", binding.Target), // web-database-orders
	}
	if !reflect.DeepEqual(res.Patches, wantPatches) {
		t.Fatalf("patches = %#v, want %#v", res.Patches, wantPatches)
	}
	if len(res.Unsatisfied) != 0 {
		t.Fatalf("unsatisfied = %v, want none", res.Unsatisfied)
	}
	if len(res.ExternalSecrets) != 1 {
		t.Fatalf("want 1 ExternalSecret, got %d", len(res.ExternalSecrets))
	}
	es := res.ExternalSecrets[0]
	if es.ServiceName != "web" || es.Namespace != "web-ns" || es.Provider != "aws" ||
		es.RemoteKey != "arn:aws:secretsmanager:...:db-master" ||
		!reflect.DeepEqual(es.Facets, []string{"password"}) {
		t.Fatalf("ExternalSecret params = %#v", es)
	}
	// The value the chart reads must be the SAME name the ExternalSecret materializes.
	if res.Patches["auth.existingSecret"] != BindingSecretName("web", es.Target) {
		t.Fatalf("existingSecret patch != BindingSecretName")
	}
	// No plaintext credential anywhere in the patches.
	for _, v := range res.Patches {
		if s, ok := v.(string); ok && s == "DB_PASS" {
			t.Fatal("a credential facet leaked a literal into the patches")
		}
	}
}

func TestResolveChartWorkloadBindings_UnsatisfiableCredential(t *testing.T) {
	binding := chartDBBinding([2]string{"DB_PASS", "password"})
	valuePaths := map[string]string{
		ChartBindingKnob("database", "orders", "password"): "auth.existingSecret",
	}

	// (a) No ESO store for the cloud (hetzner) → unsatisfied, no patch, no ExternalSecret.
	res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding}, valuePaths,
		map[string]string{"rds_master_credentials_secret_name": "arn:secret"}, "hetzner", "ns")
	if len(res.Patches) != 0 || len(res.ExternalSecrets) != 0 {
		t.Fatalf("hetzner should reference nothing: patches=%v es=%v", res.Patches, res.ExternalSecrets)
	}
	if len(res.Unsatisfied) != 1 {
		t.Fatalf("want the credential facet reported unsatisfied, got %v", res.Unsatisfied)
	}

	// (b) Store exists but the resource exported no master secret → unsatisfied, no dangling ref.
	res = ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding}, valuePaths,
		map[string]string{}, "aws", "ns")
	if _, referenced := res.Patches["auth.existingSecret"]; referenced {
		t.Fatal("must not reference an existingSecret that will not be materialized")
	}
	if len(res.Unsatisfied) != 1 {
		t.Fatalf("want unsatisfied, got %v", res.Unsatisfied)
	}
}

func TestResolveChartWorkloadBindings_MissingPath(t *testing.T) {
	binding := chartDBBinding([2]string{"DB_HOST", "endpoint"})
	res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding},
		map[string]string{}, map[string]string{"rds_cluster_endpoint": "x"}, "aws", "ns")
	if len(res.Patches) != 0 {
		t.Fatalf("no value-path → no patch, got %v", res.Patches)
	}
	if len(res.Unsatisfied) != 1 || res.Unsatisfied[0] != ChartBindingKnob("database", "orders", "endpoint") {
		t.Fatalf("want the knob reported unsatisfied, got %v", res.Unsatisfied)
	}
}

func TestSetByPath(t *testing.T) {
	m := map[string]any{"keep": 1}
	SetByPath(m, "a.b.c", "v")
	got, _ := m["a"].(map[string]any)
	inner, _ := got["b"].(map[string]any)
	if inner["c"] != "v" || m["keep"] != 1 {
		t.Fatalf("nested set failed: %#v", m)
	}
	// Empty path is a no-op.
	before := map[string]any{"x": 1}
	SetByPath(before, "", "y")
	if len(before) != 1 || before["x"] != 1 {
		t.Fatalf("empty path should no-op: %#v", before)
	}
	// A non-map intermediate is replaced with a map so the leaf lands.
	over := map[string]any{"a": 5}
	SetByPath(over, "a.b", 2)
	inner2, _ := over["a"].(map[string]any)
	if inner2["b"] != 2 {
		t.Fatalf("non-map intermediate not replaced: %#v", over)
	}
}
