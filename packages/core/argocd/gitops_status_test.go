// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// appsAppJSON is a trimmed real-shape `kubectl get application apps -o json` payload:
// two workload resources (one degraded, one synced), a non-workload Service that must
// NOT become a service row, and a synced revision.
const appsAppJSON = `{
  "metadata": {"name": "apps"},
  "status": {
    "health": {"status": "Degraded"},
    "sync": {"status": "OutOfSync", "revision": "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432"},
    "resources": [
      {"kind": "Deployment", "name": "api-gateway", "namespace": "default", "status": "Synced", "health": {"status": "Healthy"}},
      {"kind": "Deployment", "name": "checkout-web", "namespace": "default", "status": "Synced", "health": {"status": "Degraded", "message": "Deployment exceeded its progress deadline"}},
      {"kind": "StatefulSet", "name": "orders-worker", "namespace": "default", "status": "OutOfSync", "health": {"status": "Healthy"}},
      {"kind": "Service", "name": "api-gateway", "namespace": "default", "status": "Synced", "health": {"status": "Healthy"}},
      {"kind": "ConfigMap", "name": "app-config", "namespace": "default", "status": "Synced"}
    ]
  }
}`

// TestParseAppsStatus asserts the workload filter, per-resource health/sync mapping,
// aggregate status, and revision extraction.
func TestParseAppsStatus(t *testing.T) {
	agg, revision, services, err := parseAppsStatus([]byte(appsAppJSON))
	if err != nil {
		t.Fatalf("parseAppsStatus: %v", err)
	}
	if agg.Health != "Degraded" || agg.Sync != "OutOfSync" {
		t.Errorf("aggregate = %+v, want Degraded/OutOfSync", agg)
	}
	if revision != "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432" {
		t.Errorf("revision = %q", revision)
	}
	if len(services) != 3 {
		t.Fatalf("services = %v, want 3 workload rows (Service/ConfigMap filtered)", services)
	}
	if got := services["checkout-web"]; got.Health != "Degraded" || got.Sync != "Synced" {
		t.Errorf("checkout-web = %+v, want Degraded/Synced", got)
	}
	if got := services["checkout-web"]; got.Message != "Deployment exceeded its progress deadline" {
		t.Errorf("checkout-web message = %q", got.Message)
	}
	if got := services["api-gateway"]; got.Message != "" {
		t.Errorf("healthy row must carry no message, got %q", got.Message)
	}
	if got := services["orders-worker"]; got.Health != "Healthy" || got.Sync != "OutOfSync" {
		t.Errorf("orders-worker = %+v, want Healthy/OutOfSync", got)
	}
}

// TestParseAppsStatusEmptyResources asserts the honest-unknown fallback: an Application
// with no resources list yields an EMPTY services map (unreadable ≠ zero services) and
// normalises blank statuses to Unknown.
func TestParseAppsStatusEmptyResources(t *testing.T) {
	agg, revision, services, err := parseAppsStatus([]byte(`{"status": {"health": {}, "sync": {}}}`))
	if err != nil {
		t.Fatalf("parseAppsStatus: %v", err)
	}
	if agg.Health != "Unknown" || agg.Sync != "Unknown" {
		t.Errorf("aggregate = %+v, want Unknown/Unknown", agg)
	}
	if revision != "" || len(services) != 0 {
		t.Errorf("revision=%q services=%v, want empty", revision, services)
	}
}

// TestParseAppsStatusInvalidJSON asserts a parse failure returns an error (the caller
// downgrades to a warning + Unknown), never a fabricated status.
func TestParseAppsStatusInvalidJSON(t *testing.T) {
	_, _, _, err := parseAppsStatus([]byte("not-json"))
	if err == nil {
		t.Fatal("want error on invalid JSON")
	}
}

// TestSanitizeGitopsError asserts a git token embedded in an error VALUE is redacted —
// the runner's metadata scrub is key-based and cannot catch it.
func TestSanitizeGitopsError(t *testing.T) {
	token := "ghp_supersecrettoken123"
	err := errors.New("git clone https://x-access-token:" + token + "@github.com/acme/apps failed: exit 128")
	got := SanitizeGitopsError(err, token)
	if strings.Contains(got, token) {
		t.Fatalf("token survived sanitization: %q", got)
	}
	if !strings.Contains(got, "[REDACTED]") {
		t.Errorf("want [REDACTED] marker, got %q", got)
	}
	if SanitizeGitopsError(nil, token) != "" {
		t.Error("nil error must sanitize to empty string")
	}
	// Empty token must be a no-op, not a corruption.
	if got := SanitizeGitopsError(errors.New("plain failure"), ""); got != "plain failure" {
		t.Errorf("empty-token sanitize = %q", got)
	}
}

// TestGitopsStatusJSONShape locks the wire shape the console's zod schema
// (gitopsStatusReportSchema) parses — a rename here breaks the TS contract.
func TestGitopsStatusJSONShape(t *testing.T) {
	gs := GitopsStatus{
		Mode:       "gitops",
		AppsRepo:   "https://github.com/acme/apps",
		ArgocdApp:  UserAppsApplicationName,
		Revision:   "abc123",
		FailedStep: GitopsStepGitToken,
		Error:      "no git access token",
		AppHealth:  &AddOnHealth{Health: "Unknown", Sync: "Unknown"},
		Services:   map[string]ServiceHealth{"web": {Health: "Healthy", Sync: "Synced"}},
	}
	b, err := json.Marshal(gs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{
		`"mode":"gitops"`, `"apps_repo"`, `"argocd_app":"apps"`, `"revision"`,
		`"failed_step":"git_token"`, `"error"`, `"app_health"`, `"services"`,
		`"health":"Healthy"`, `"sync":"Synced"`,
	} {
		if !strings.Contains(string(b), key) {
			t.Errorf("wire shape missing %s in %s", key, b)
		}
	}
	// Direct mode must omit every optional field.
	b, _ = json.Marshal(GitopsStatus{Mode: "direct"})
	if string(b) != `{"mode":"direct"}` {
		t.Errorf("direct-mode wire shape = %s, want only mode", b)
	}
}
