// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
)

// TestConfigureRepoCredentialsNamed_WritesTheUsernameItIsGiven checks the ArgoCD repository Secret
// carries the username the caller passes. ArgoCD clones with exactly this username, so a Bitbucket
// repo registered under `x-access-token` could never sync (#6599).
func TestConfigureRepoCredentialsNamed_WritesTheUsernameItIsGiven(t *testing.T) {
	for _, username := range []string{"x-access-token", "oauth2", "x-token-auth"} {
		t.Run(username, func(t *testing.T) {
			stub := newKubectlStub(t, 0)
			var stdout, stderr bytes.Buffer
			if err := ConfigureRepoCredentialsNamed("https://bitbucket.org/acme/chart", "tok", username, "repo-byo-x", &stdout, &stderr); err != nil {
				t.Fatalf("ConfigureRepoCredentialsNamed() error = %v", err)
			}
			want := "username: " + base64.StdEncoding.EncodeToString([]byte(username)) + "\n"
			if got := stub.appliedManifests(); !strings.Contains(got, want) {
				t.Errorf("applied Secret does not carry username %q:\n%s", username, got)
			}
		})
	}
}
