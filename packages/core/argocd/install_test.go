// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/base64"
	"io"
	"strings"
	"testing"
)

func TestIsCRDNotReady(t *testing.T) {
	cases := []struct {
		name   string
		output string
		want   bool
	}{
		{"clustersecretstore race", `error: resource mapping not found for name: "secretstore-azure": no matches for kind "ClusterSecretStore" in version "external-secrets.io/v1beta1"`, true},
		{"no matches for kind", `unable to recognize "x.yaml": no matches for kind "SecretStore"`, true},
		{"real auth failure not retried", `error: unable to apply: forbidden: user cannot patch`, false},
		{"validation error not retried", `error validating data: unknown field "spec.bogus"`, false},
		{"empty output", "", false},
	}
	for _, c := range cases {
		if got := isCRDNotReady(c.output); got != c.want {
			t.Errorf("%s: isCRDNotReady=%v, want %v", c.name, got, c.want)
		}
	}
}

func TestExternalDNSSecretManifest(t *testing.T) {
	m := externalDNSSecretManifest("external-dns-cloudflare", "apiToken", "s3cret")
	if !strings.Contains(m, "kind: Namespace") || !strings.Contains(m, "name: external-dns") {
		t.Errorf("manifest must create the external-dns namespace first:\n%s", m)
	}
	if !strings.Contains(m, "name: external-dns-cloudflare") {
		t.Errorf("manifest must name the secret:\n%s", m)
	}
	want := "apiToken: " + base64.StdEncoding.EncodeToString([]byte("s3cret"))
	if !strings.Contains(m, want) {
		t.Errorf("manifest must carry the base64 token under the given key:\n%s", m)
	}
	if strings.Contains(m, "s3cret") {
		t.Errorf("raw token must not appear unencoded:\n%s", m)
	}
}

func TestEnsureExternalDNSSecretRefusesEmptyToken(t *testing.T) {
	// Fail-closed: an empty token means the render gate should have skipped the app —
	// writing an empty secret would just move the failure into the cluster.
	if err := EnsureExternalDNSSecret("external-dns-hetzner", "token", "", io.Discard, io.Discard); err == nil {
		t.Fatalf("expected an error for an empty token")
	}
}
