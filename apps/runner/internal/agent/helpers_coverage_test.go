// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAuditKindLabel(t *testing.T) {
	if got := auditKindLabel("manifests"); got != "Kubernetes manifests" {
		t.Fatalf("manifests → %q", got)
	}
	if got := auditKindLabel("plan"); got != "OpenTofu/Terraform plan" {
		t.Fatalf("plan → %q", got)
	}
}

func TestToCoreConnectorCreds(t *testing.T) {
	if got := toCoreConnectorCreds(nil); got != nil {
		t.Fatalf("nil input → %#v, want nil", got)
	}
	if got := toCoreConnectorCreds([]ConnectorCredential{}); got != nil {
		t.Fatalf("empty input → %#v, want nil", got)
	}
	in := []ConnectorCredential{{
		Category:    "observability",
		Slug:        "datadog",
		Credentials: map[string]string{"api_key": "k"},
	}}
	got := toCoreConnectorCreds(in)
	if len(got) != 1 || got[0].Category != "observability" || got[0].Slug != "datadog" || got[0].Credentials["api_key"] != "k" {
		t.Fatalf("mapped = %#v", got)
	}
}

func TestResolveAccountID(t *testing.T) {
	cases := []struct {
		provider string
		id       *CloudIdentity
		want     string
	}{
		{"gcp", &CloudIdentity{Provider: "gcp", ProjectID: "proj-1", AccountID: "acct"}, "proj-1"},
		{"azure", &CloudIdentity{Provider: "azure", SubscriptionID: "sub-1", AccountID: "acct"}, "sub-1"},
		{"aws (default)", &CloudIdentity{Provider: "aws", AccountID: "1234567890"}, "1234567890"},
		{"unknown (default)", &CloudIdentity{Provider: "nimbus", AccountID: "acct-x"}, "acct-x"},
		{"nil identity", nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.provider, func(t *testing.T) {
			if got := resolveAccountID(tc.id); got != tc.want {
				t.Fatalf("resolveAccountID = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestResolveAmbientAccountID covers the self-operator (nil-identity) fallback that reads the account
// identifier from the ambient environment: AWS_ACCOUNT_ID, the GOOGLE_*/GCLOUD_*/CLOUDSDK_* project
// chain (first non-empty wins), ARM_SUBSCRIPTION_ID, and "" for account-less providers.
func TestResolveAmbientAccountID(t *testing.T) {
	// Clear every input first so inherited env can't leak into a case.
	for _, k := range []string{"AWS_ACCOUNT_ID", "GOOGLE_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT", "ARM_SUBSCRIPTION_ID"} {
		t.Setenv(k, "")
	}
	cases := []struct {
		name     string
		provider string
		env      map[string]string
		want     string
	}{
		{"aws", "aws", map[string]string{"AWS_ACCOUNT_ID": "270587882865"}, "270587882865"},
		{"gcp GOOGLE_PROJECT", "gcp", map[string]string{"GOOGLE_PROJECT": "itgix-adp"}, "itgix-adp"},
		{"gcp fallback to CLOUDSDK", "gcp", map[string]string{"CLOUDSDK_CORE_PROJECT": "proj-x"}, "proj-x"},
		{"gcp precedence GOOGLE_PROJECT wins", "gcp", map[string]string{"GOOGLE_PROJECT": "first", "GOOGLE_CLOUD_PROJECT": "second"}, "first"},
		{"azure", "azure", map[string]string{"ARM_SUBSCRIPTION_ID": "sub-1"}, "sub-1"},
		{"hetzner is account-less", "hetzner", nil, ""},
		{"aws unset yields empty", "aws", nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			if got := resolveAmbientAccountID(tc.provider); got != tc.want {
				t.Fatalf("resolveAmbientAccountID(%q) = %q, want %q", tc.provider, got, tc.want)
			}
		})
	}
}

func TestCopyDir(t *testing.T) {
	src := t.TempDir()
	dst := filepath.Join(t.TempDir(), "out")

	if err := os.MkdirAll(filepath.Join(src, "nested"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "nested", "file.txt"), []byte("hello"), 0640); err != nil {
		t.Fatal(err)
	}

	if err := copyDir(src, dst); err != nil {
		t.Fatalf("copyDir: %v", err)
	}

	copied := filepath.Join(dst, "nested", "file.txt")
	data, err := os.ReadFile(copied)
	if err != nil || string(data) != "hello" {
		t.Fatalf("copied file: data=%q err=%v", data, err)
	}
	info, err := os.Stat(copied)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0640 {
		t.Fatalf("copied mode = %o, want 640 (preserved)", info.Mode().Perm())
	}
}

func TestCopyDir_MissingSourceErrors(t *testing.T) {
	if err := copyDir(filepath.Join(t.TempDir(), "does-not-exist"), t.TempDir()); err == nil {
		t.Fatal("expected an error walking a missing source directory")
	}
}
