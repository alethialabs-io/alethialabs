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
	}
	for _, tc := range cases {
		t.Run(tc.provider, func(t *testing.T) {
			if got := resolveAccountID(tc.id); got != tc.want {
				t.Fatalf("resolveAccountID = %q, want %q", got, tc.want)
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
