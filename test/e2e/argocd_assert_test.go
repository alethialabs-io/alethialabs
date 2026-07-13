// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Negative-path proof for the ArgoCD health assertion (BYOC A0.2): the parsing +
// decision logic is exercised against synthetic `applications.argoproj.io` JSON and
// metadata shapes WITHOUT a cluster — healthy, degraded, out-of-sync, missing app,
// and (crucially) the empty-expected-set vacuity guard, so the assertion itself is
// proven able to fail before any tier relies on it. UNTAGGED: runs under a bare
// `go test ./...` in test/e2e (no docker/kind/postgres needed).
package e2e

import (
	"context"
	"strings"
	"testing"
	"time"
)

// argoAppsJSON builds a minimal `kubectl get applications -o json` document from
// (name, health, sync) triples, in the exact shape parseArgoApps consumes.
func argoAppsJSON(items ...[3]string) []byte {
	var b strings.Builder
	b.WriteString(`{"items":[`)
	for i, it := range items {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"metadata":{"name":"` + it[0] + `"},"status":{"health":{"status":"` + it[1] + `"},"sync":{"status":"` + it[2] + `"}}}`)
	}
	b.WriteString(`]}`)
	return []byte(b.String())
}

func TestParseArgoApps(t *testing.T) {
	raw := []byte(`{"items":[
		{"metadata":{"name":"addon-reloader"},
		 "status":{"health":{"status":"Healthy"},"sync":{"status":"Synced"}}},
		{"metadata":{"name":"metrics-server"},
		 "status":{"health":{"status":"Degraded"},"sync":{"status":"OutOfSync"},
		           "conditions":[{"type":"SyncError","message":"one or more objects failed to apply"}]}},
		{"metadata":{"name":"just-created"},"status":{}}
	]}`)
	observed, err := parseArgoApps(raw)
	if err != nil {
		t.Fatalf("parseArgoApps: %v", err)
	}
	if got := observed["addon-reloader"]; got.Health != "Healthy" || got.Sync != "Synced" {
		t.Fatalf("addon-reloader = %+v, want Healthy/Synced", got)
	}
	deg := observed["metrics-server"]
	if deg.Health != "Degraded" || deg.Sync != "OutOfSync" {
		t.Fatalf("metrics-server = %+v, want Degraded/OutOfSync", deg)
	}
	if len(deg.Conditions) != 1 || !strings.Contains(deg.Conditions[0], "SyncError") {
		t.Fatalf("metrics-server conditions = %v, want the SyncError condition", deg.Conditions)
	}
	// An app with no status yet must normalise to Unknown (mirrors health.go), so it
	// FAILS the assertion rather than being skipped or misread.
	if got := observed["just-created"]; got.Health != "Unknown" || got.Sync != "Unknown" {
		t.Fatalf("just-created = %+v, want Unknown/Unknown", got)
	}
}

func TestParseArgoApps_BadJSON(t *testing.T) {
	if _, err := parseArgoApps([]byte("kubectl exploded")); err == nil {
		t.Fatal("expected an error for non-JSON input")
	}
}

func TestEvaluateArgoApps_AllHealthy(t *testing.T) {
	observed, err := parseArgoApps(argoAppsJSON(
		[3]string{"addon-reloader", "Healthy", "Synced"},
		[3]string{"addon-sealed-secrets", "Healthy", "Synced"},
		// An UNEXPECTED degraded app must not fail the assertion — only the derived
		// expected set is required (metrics-server is not part of the honest derivation).
		[3]string{"metrics-server", "Degraded", "Synced"},
	))
	if err != nil {
		t.Fatal(err)
	}
	losers, everr := evaluateArgoApps(observed, []string{"addon-reloader", "addon-sealed-secrets"})
	if everr != nil || len(losers) != 0 {
		t.Fatalf("want pass, got losers=%v err=%v", losers, everr)
	}
}

func TestEvaluateArgoApps_DegradedFails(t *testing.T) {
	observed, _ := parseArgoApps(argoAppsJSON(
		[3]string{"addon-reloader", "Degraded", "Synced"},
		[3]string{"addon-sealed-secrets", "Healthy", "Synced"},
	))
	losers, err := evaluateArgoApps(observed, []string{"addon-reloader", "addon-sealed-secrets"})
	if err == nil {
		t.Fatal("a Degraded expected app must fail the evaluation")
	}
	if len(losers) != 1 || losers[0] != "addon-reloader" {
		t.Fatalf("losers = %v, want [addon-reloader]", losers)
	}
	if !strings.Contains(err.Error(), "health=Degraded") {
		t.Fatalf("error must report the failing health, got: %v", err)
	}
}

func TestEvaluateArgoApps_OutOfSyncFails(t *testing.T) {
	// Healthy but OutOfSync is still a failure — sync must be asserted, not just health
	// (a self-heal that never converges shows exactly this shape).
	observed, _ := parseArgoApps(argoAppsJSON([3]string{"external-dns", "Healthy", "OutOfSync"}))
	losers, err := evaluateArgoApps(observed, []string{"external-dns"})
	if err == nil || len(losers) != 1 {
		t.Fatalf("Healthy+OutOfSync must fail, got losers=%v err=%v", losers, err)
	}
}

func TestEvaluateArgoApps_MissingAppFails(t *testing.T) {
	observed, _ := parseArgoApps(argoAppsJSON([3]string{"addon-reloader", "Healthy", "Synced"}))
	losers, err := evaluateArgoApps(observed, []string{"addon-reloader", "addon-vanished"})
	if err == nil {
		t.Fatal("a missing expected app must fail the evaluation")
	}
	if len(losers) != 1 || losers[0] != "addon-vanished" {
		t.Fatalf("losers = %v, want [addon-vanished]", losers)
	}
	if !strings.Contains(err.Error(), "MISSING") {
		t.Fatalf("error must call out the missing app, got: %v", err)
	}
}

func TestEvaluateArgoApps_EmptyExpectedIsVacuous(t *testing.T) {
	observed, _ := parseArgoApps(argoAppsJSON([3]string{"addon-reloader", "Healthy", "Synced"}))
	if _, err := evaluateArgoApps(observed, nil); err == nil || !strings.Contains(err.Error(), "VACUOUS") {
		t.Fatalf("an empty expected set must be refused as vacuous, got: %v", err)
	}
}

func TestAssertArgoAppsHealthy_EmptyExpectedIsVacuous(t *testing.T) {
	// The poll wrapper must refuse an empty set BEFORE touching any cluster — this call
	// must fail immediately with no kubeconfig and no kubectl.
	err := AssertArgoAppsHealthy(context.Background(), "/nonexistent/kubeconfig", nil, time.Minute)
	if err == nil || !strings.Contains(err.Error(), "VACUOUS") {
		t.Fatalf("want an immediate vacuity error, got: %v", err)
	}
}

func TestDeriveExpectedArgoApps(t *testing.T) {
	// The T1/T2 hetzner shape: every app-shipping infra service skipped, storage-class
	// installed (no Application of its own), two seeded add-ons.
	meta := []byte(`{
		"cluster_name": "alethia-e2t1abc",
		"infra_services": [
			{"service":"external-dns","status":"skipped","reason":"DNS is disabled"},
			{"service":"external-secrets-store","status":"skipped","reason":"no cloud secret store"},
			{"service":"ingress","status":"skipped","reason":"install ingress-nginx"},
			{"service":"storage-class","status":"installed","reason":"hcloud-volumes default"},
			{"service":"argocd-url","status":"skipped","reason":"port-forward"}
		],
		"addon_status": {
			"addon-sealed-secrets": {"health":"Progressing","sync":"Synced"},
			"addon-reloader": {"health":"Unknown","sync":"Unknown"}
		}
	}`)
	got, err := DeriveExpectedArgoApps(meta)
	if err != nil {
		t.Fatalf("DeriveExpectedArgoApps: %v", err)
	}
	want := []string{"addon-reloader", "addon-sealed-secrets"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("derived = %v, want %v (sorted; storage-class must NOT map to an app)", got, want)
	}
}

func TestDeriveExpectedArgoApps_InstalledInfraServicesMap(t *testing.T) {
	// The AWS-flavoured shape: installed decisions map to their Application names.
	meta := []byte(`{
		"infra_services": [
			{"service":"external-dns","status":"installed","reason":"provider aws"},
			{"service":"external-secrets-store","status":"installed","reason":"AWS Secrets Manager"},
			{"service":"ingress","status":"installed","reason":"ALB controller"},
			{"service":"argocd-url","status":"installed","reason":"ALB ingress"}
		]
	}`)
	got, err := DeriveExpectedArgoApps(meta)
	if err != nil {
		t.Fatalf("DeriveExpectedArgoApps: %v", err)
	}
	want := []string{"aws-load-balancer-controller", "external-dns", "external-secrets-operator"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("derived = %v, want %v", got, want)
	}
}

func TestDeriveExpectedArgoApps_EmptySetFails(t *testing.T) {
	// All app-shipping services skipped + no add-ons ⇒ the derivation itself must fail
	// (vacuity defense), pointing at the add-on seeding fix.
	meta := []byte(`{
		"cluster_name": "x",
		"infra_services": [
			{"service":"external-dns","status":"skipped","reason":"r"},
			{"service":"storage-class","status":"installed","reason":"r"}
		]
	}`)
	if _, err := DeriveExpectedArgoApps(meta); err == nil || !strings.Contains(err.Error(), "vacuous") {
		t.Fatalf("want a vacuity error for an empty derived set, got: %v", err)
	}
}

func TestDeriveExpectedArgoApps_EmptyMetadataFails(t *testing.T) {
	if _, err := DeriveExpectedArgoApps(nil); err == nil {
		t.Fatal("want an error for empty execution_metadata")
	}
	if _, err := DeriveExpectedArgoApps([]byte("{not json")); err == nil {
		t.Fatal("want an error for malformed execution_metadata")
	}
}
