// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

// validVClusterKubeconfig is a realistic vcluster-exported SA-token kubeconfig: an in-cluster server, a
// base64 CA (certificate-authority-data), and a bearer token (no client cert).
const validVClusterKubeconfig = `apiVersion: v1
kind: Config
clusters:
  - name: my-vcluster
    cluster:
      server: https://web.vcluster-web.svc
      certificate-authority-data: Y2EtcGVtLWRhdGE=
users:
  - name: my-vcluster
    user:
      token: sa-token-abc123
contexts:
  - name: my-vcluster
    context:
      cluster: my-vcluster
      user: my-vcluster
current-context: my-vcluster
`

// TestParseKubeconfigForCluster locks the happy path: server, CA data (verbatim base64), and token.
func TestParseKubeconfigForCluster(t *testing.T) {
	server, caData, token, err := parseKubeconfigForCluster([]byte(validVClusterKubeconfig))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if server != "https://web.vcluster-web.svc" {
		t.Errorf("server = %q, want the in-cluster service URL", server)
	}
	if caData != "Y2EtcGVtLWRhdGE=" {
		t.Errorf("caData = %q, want the verbatim base64 certificate-authority-data", caData)
	}
	if token != "sa-token-abc123" {
		t.Errorf("token = %q, want the SA token", token)
	}
}

// TestParseKubeconfigForClusterFailClosed covers the half-written / malformed cases — each must error so a
// broken cluster registration is never produced.
func TestParseKubeconfigForClusterFailClosed(t *testing.T) {
	cases := map[string]string{
		"no clusters": "users:\n  - user:\n      token: t\n",
		"no users":    "clusters:\n  - cluster:\n      server: https://x\n      certificate-authority-data: Y2E=\n",
		"no server":   "clusters:\n  - cluster:\n      certificate-authority-data: Y2E=\nusers:\n  - user:\n      token: t\n",
		"no token":    "clusters:\n  - cluster:\n      server: https://x\n      certificate-authority-data: Y2E=\nusers:\n  - user:\n      token: \"\"\n",
		"no ca":       "clusters:\n  - cluster:\n      server: https://x\nusers:\n  - user:\n      token: t\n",
		"malformed":   "clusters: [this is: not valid yaml",
	}
	for name, kubeconfig := range cases {
		t.Run(name, func(t *testing.T) {
			if _, _, _, err := parseKubeconfigForCluster([]byte(kubeconfig)); err == nil {
				t.Errorf("expected an error for the %q case", name)
			}
		})
	}
}

// TestVClusterClusterSecretManifest locks the ArgoCD cluster Secret: the cluster secret-type, the prune
// label, base64 name/server, and that the base64 config decodes to the expected bearerToken/caData JSON.
func TestVClusterClusterSecretManifest(t *testing.T) {
	configJSON, err := vclusterClusterConfigJSON("Y2EtcGVtLWRhdGE=", "sa-token-abc123")
	if err != nil {
		t.Fatalf("config json: %v", err)
	}
	m := vclusterClusterSecretManifest("web", "https://web.vcluster-web.svc", configJSON)

	for _, want := range []string{
		"kind: Secret",
		"name: web",
		"namespace: argocd",
		"argocd.argoproj.io/secret-type: cluster",
		"alethia.io/vcluster-cluster: \"true\"",
		"type: Opaque",
		"name: " + base64.StdEncoding.EncodeToString([]byte("web")),
		"server: " + base64.StdEncoding.EncodeToString([]byte("https://web.vcluster-web.svc")),
		"config: " + base64.StdEncoding.EncodeToString([]byte(configJSON)),
	} {
		if !strings.Contains(m, want) {
			t.Errorf("manifest missing %q:\n%s", want, m)
		}
	}

	// The token must never appear in plaintext in the manifest.
	if strings.Contains(m, "sa-token-abc123") {
		t.Errorf("token leaked in plaintext:\n%s", m)
	}

	// The base64 config must decode to the ArgoCD cluster config shape.
	var decoded struct {
		BearerToken     string `json:"bearerToken"`
		TLSClientConfig struct {
			CAData string `json:"caData"`
		} `json:"tlsClientConfig"`
	}
	if err := json.Unmarshal([]byte(configJSON), &decoded); err != nil {
		t.Fatalf("config JSON did not parse: %v", err)
	}
	if decoded.BearerToken != "sa-token-abc123" {
		t.Errorf("bearerToken = %q, want the SA token", decoded.BearerToken)
	}
	if decoded.TLSClientConfig.CAData != "Y2EtcGVtLWRhdGE=" {
		t.Errorf("caData = %q, want the verbatim base64 CA", decoded.TLSClientConfig.CAData)
	}
}

// TestEnsureVClusterClusterSecretGuards covers the fail-closed branches that return BEFORE shelling to
// kubectl: a hostile cluster name or exported-Secret ref that would interpolate into a command. The happy
// path reads/applies via kubectl and is exercised end-to-end (main-gated), not in a unit test.
func TestEnsureVClusterClusterSecretGuards(t *testing.T) {
	if err := EnsureVClusterClusterSecret("a;rm -rf /", "vcluster-kubeconfig-web", "argocd", io.Discard, io.Discard); err == nil {
		t.Error("expected an error for a hostile cluster name")
	}
	if err := EnsureVClusterClusterSecret("web", "bad name", "argocd", io.Discard, io.Discard); err == nil {
		t.Error("expected an error for an invalid kubeconfig Secret name")
	}
	if err := EnsureVClusterClusterSecret("web", "vcluster-kubeconfig-web", "Bad_NS", io.Discard, io.Discard); err == nil {
		t.Error("expected an error for an invalid kubeconfig namespace")
	}
}

// TestDeregisterVClusterClusterSecretGuard rejects a hostile name before any kubectl exec.
func TestDeregisterVClusterClusterSecretGuard(t *testing.T) {
	if err := DeregisterVClusterClusterSecret("web;reboot", io.Discard, io.Discard); err == nil {
		t.Error("expected an error for a hostile cluster name")
	}
}
