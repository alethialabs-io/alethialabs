// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/base64"
	"io"
	"strings"
	"testing"
)

// TestRegistryPullSecretManifest locks the seeded Secret's shape: a dockerconfigjson-typed Secret
// carrying the prune label, its namespace pre-created (the app namespace may not exist yet), and
// the payload base64'd verbatim under .dockerconfigjson.
func TestRegistryPullSecretManifest(t *testing.T) {
	payload := `{"auths":{"https://index.docker.io/v1/":{"username":"alice","password":"s3cr3t"}}}`
	m := registryPullSecretManifest("dockerhub-pull", "default", payload)

	for _, want := range []string{
		"kind: Namespace",
		"name: default",
		"name: dockerhub-pull",
		"namespace: default",
		"type: kubernetes.io/dockerconfigjson",
		"alethia.io/registry-pull: \"true\"",
		".dockerconfigjson: ",
	} {
		if !strings.Contains(m, want) {
			t.Errorf("manifest missing %q:\n%s", want, m)
		}
	}

	// The payload must round-trip through the base64 in the data block — never inlined in plaintext.
	if strings.Contains(m, "s3cr3t") {
		t.Errorf("secret payload leaked in plaintext:\n%s", m)
	}
	enc := base64.StdEncoding.EncodeToString([]byte(payload))
	if !strings.Contains(m, ".dockerconfigjson: "+enc) {
		t.Errorf("manifest missing base64 payload %q:\n%s", enc, m)
	}
}

// TestEnsureRegistryPullSecretGuards covers the fail-closed branches that return BEFORE shelling to
// kubectl (an empty payload, or a name/namespace that isn't a DNS label). The happy path applies via
// kubectl and is exercised end-to-end, not in a unit test.
func TestEnsureRegistryPullSecretGuards(t *testing.T) {
	if err := EnsureRegistryPullSecret("dockerhub-pull", "default", "", io.Discard, io.Discard); err == nil {
		t.Error("expected an error for an empty dockerconfigjson payload")
	}
	if err := EnsureRegistryPullSecret("Bad_Name", "default", `{"auths":{}}`, io.Discard, io.Discard); err == nil {
		t.Error("expected an error for an invalid secret name")
	}
	if err := EnsureRegistryPullSecret("dockerhub-pull", "Bad NS", `{"auths":{}}`, io.Discard, io.Discard); err == nil {
		t.Error("expected an error for an invalid namespace")
	}
}
