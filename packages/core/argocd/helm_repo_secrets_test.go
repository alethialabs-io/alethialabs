// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/base64"
	"io"
	"strings"
	"testing"
)

// TestHelmRepoCredManifestOCI locks the OCI variant: a repo-creds secret-type (URL-prefix match),
// enableOCI:"true", type:helm, and the prune label — with url/password base64'd, never in plaintext.
func TestHelmRepoCredManifestOCI(t *testing.T) {
	m := helmRepoCredManifest("repo-helm-abc123", "oci://ghcr.io", "carol", "pat", true)

	for _, want := range []string{
		"kind: Secret",
		"name: repo-helm-abc123",
		"namespace: argocd",
		"argocd.argoproj.io/secret-type: repo-creds",
		"alethia.io/helm-repo-cred: \"true\"",
		"type: Opaque",
		"type: " + base64.StdEncoding.EncodeToString([]byte("helm")),
		"url: " + base64.StdEncoding.EncodeToString([]byte("oci://ghcr.io")),
		"username: " + base64.StdEncoding.EncodeToString([]byte("carol")),
		"password: " + base64.StdEncoding.EncodeToString([]byte("pat")),
		"enableOCI: " + base64.StdEncoding.EncodeToString([]byte("true")),
	} {
		if !strings.Contains(m, want) {
			t.Errorf("manifest missing %q:\n%s", want, m)
		}
	}
	// The password must never appear in plaintext.
	if strings.Contains(m, "pat\n") || strings.Contains(m, ": pat") {
		t.Errorf("password leaked in plaintext:\n%s", m)
	}
}

// TestHelmRepoCredManifestHTTPS locks the HTTPS variant: a `repository` secret-type (exact url match)
// and NO enableOCI key.
func TestHelmRepoCredManifestHTTPS(t *testing.T) {
	m := helmRepoCredManifest("repo-helm-def456", "https://charts.example.com", "alice", "pw", false)
	if !strings.Contains(m, "argocd.argoproj.io/secret-type: repository") {
		t.Errorf("HTTPS repo should use the repository secret-type:\n%s", m)
	}
	if strings.Contains(m, "enableOCI") {
		t.Errorf("HTTPS repo must NOT set enableOCI:\n%s", m)
	}
}

// TestEnsureHelmRepoCredentialGuards covers the fail-closed branches that return BEFORE shelling to
// kubectl: an empty url/password, or a name that isn't a DNS label (it interpolates into kubectl).
// The happy path applies via kubectl and is exercised end-to-end, not in a unit test.
func TestEnsureHelmRepoCredentialGuards(t *testing.T) {
	if err := EnsureHelmRepoCredential("repo-helm-abc123", "", "u", "p", true, io.Discard, io.Discard); err == nil {
		t.Error("expected an error for an empty url")
	}
	if err := EnsureHelmRepoCredential("repo-helm-abc123", "oci://ghcr.io", "u", "", true, io.Discard, io.Discard); err == nil {
		t.Error("expected an error for an empty password")
	}
	if err := EnsureHelmRepoCredential("Bad_Name", "oci://ghcr.io", "u", "p", true, io.Discard, io.Discard); err == nil {
		t.Error("expected an error for an invalid secret name")
	}
}
