// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package kubeaccess

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

const testClusterID = "0b8a3c2e-4f1d-4c6a-9e7b-2d5f8a1c3e9b"

// testTarget is a pinned cluster used by the golden tests.
var testTarget = Target{Project: "Web Shop", Env: "prod", Server: "https://api.web-shop.example.com:6443", CAData: testCAData}

// The goldens are the exact bytes a user's ~/.kube/config receives. The CA is testCAPEM's.
const goldenStaticToken = `apiVersion: v1
kind: Config
clusters:
    - name: alethia-web-shop-prod
      cluster:
        server: https://api.web-shop.example.com:6443
        certificate-authority-data: {{CA}}
contexts:
    - name: alethia-web-shop-prod
      context:
        cluster: alethia-web-shop-prod
        user: alethia-web-shop-prod
current-context: alethia-web-shop-prod
users:
    - name: alethia-web-shop-prod
      user:
        token: eyJhbGciOiJSUzI1NiJ9.fixture.sig
`

const goldenStaticCert = `apiVersion: v1
kind: Config
clusters:
    - name: alethia-web-shop-prod
      cluster:
        server: https://api.web-shop.example.com:6443
        certificate-authority-data: {{CA}}
contexts:
    - name: alethia-web-shop-prod
      context:
        cluster: alethia-web-shop-prod
        user: alethia-web-shop-prod
current-context: alethia-web-shop-prod
users:
    - name: alethia-web-shop-prod
      user:
        client-certificate-data: {{CERT}}
        client-key-data: {{KEY}}
`

const goldenExec = `apiVersion: v1
kind: Config
clusters:
    - name: alethia-web-shop-prod
      cluster:
        server: https://api.web-shop.example.com:6443
        certificate-authority-data: {{CA}}
contexts:
    - name: alethia-web-shop-prod
      context:
        cluster: alethia-web-shop-prod
        user: alethia-web-shop-prod
current-context: alethia-web-shop-prod
users:
    - name: alethia-web-shop-prod
      user:
        exec:
            apiVersion: client.authentication.k8s.io/v1
            command: alethia
            args:
                - cluster
                - token
                - 0b8a3c2e-4f1d-4c6a-9e7b-2d5f8a1c3e9b
            installHint: This kubeconfig gets its credentials from the Alethia CLI. Install ` + "`alethia`" + ` and sign in with ` + "`alethia login`" + `.
            interactiveMode: Never
            provideClusterInfo: false
`

const goldenExecCredential = `{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"expirationTimestamp":"2026-10-01T13:00:00Z","token":"eyJhbGciOiJSUzI1NiJ9.fixture.sig"}}
`

// golden substitutes the CA into a golden and compares.
func checkGolden(t *testing.T, name string, got []byte, golden string, subst map[string]string) {
	t.Helper()
	want := strings.ReplaceAll(golden, "{{CA}}", testCAData)
	for k, v := range subst {
		want = strings.ReplaceAll(want, k, v)
	}
	if string(got) != want {
		t.Errorf("%s differs from its golden.\n--- got ---\n%s\n--- want ---\n%s", name, got, want)
	}
}

// TestRenderStaticKubeconfig_Golden pins both static shapes byte for byte.
func TestRenderStaticKubeconfig_Golden(t *testing.T) {
	out, err := RenderStaticKubeconfig(testTarget, StaticCredential{Token: "eyJhbGciOiJSUzI1NiJ9.fixture.sig"})
	if err != nil {
		t.Fatal(err)
	}
	checkGolden(t, "static token", out, goldenStaticToken, nil)

	certB64, keyB64, _ := genClientPair(t)
	out, err = RenderStaticKubeconfig(testTarget, StaticCredential{ClientCertData: certB64, ClientKeyData: keyB64})
	if err != nil {
		t.Fatal(err)
	}
	checkGolden(t, "static cert", out, goldenStaticCert, map[string]string{"{{CERT}}": certB64, "{{KEY}}": keyB64})
}

// TestRenderExecKubeconfig_Golden pins the exec shape and checks it carries no credential.
func TestRenderExecKubeconfig_Golden(t *testing.T) {
	out, err := RenderExecKubeconfig(testTarget, testClusterID, "")
	if err != nil {
		t.Fatal(err)
	}
	checkGolden(t, "exec", out, goldenExec, nil)
	for _, field := range []string{"token:", "client-key-data", "client-certificate-data", "insecure-skip-tls-verify"} {
		if strings.Contains(string(out), field) {
			t.Errorf("the exec kubeconfig contains %q", field)
		}
	}
	custom, err := RenderExecKubeconfig(testTarget, testClusterID, "/usr/local/bin/alethia")
	if err != nil || !strings.Contains(string(custom), "command: /usr/local/bin/alethia\n") {
		t.Fatalf("custom command: %v\n%s", err, custom)
	}
}

// TestRenderExecCredential_Golden pins the plugin's stdout, and that it round-trips as JSON.
func TestRenderExecCredential_Golden(t *testing.T) {
	exp := time.Date(2026, 10, 1, 15, 0, 0, 0, time.FixedZone("CEST+2", 2*3600))
	out, err := RenderExecCredential("eyJhbGciOiJSUzI1NiJ9.fixture.sig", exp)
	if err != nil {
		t.Fatal(err)
	}
	checkGolden(t, "ExecCredential", out, goldenExecCredential, nil)
	var back map[string]any
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatal(err)
	}
	if _, err := RenderExecCredential("", exp); !errors.Is(err, ErrRender) {
		t.Errorf("empty token: %v", err)
	}
	if _, err := RenderExecCredential("t", time.Time{}); !errors.Is(err, ErrRender) {
		t.Errorf("zero expiry: %v", err)
	}
}

// TestRendered_IsAValidKubeconfig parses each shape back and checks the pins and the one context.
func TestRendered_IsAValidKubeconfig(t *testing.T) {
	static, _ := RenderStaticKubeconfig(testTarget, StaticCredential{Token: "tok"})
	exec, _ := RenderExecKubeconfig(testTarget, testClusterID, "")
	for name, out := range map[string][]byte{"static": static, "exec": exec} {
		var kc kubeconfig
		if err := yaml.Unmarshal(out, &kc); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(kc.Clusters) != 1 || len(kc.Contexts) != 1 || len(kc.Users) != 1 || kc.CurrentContext != "alethia-web-shop-prod" {
			t.Fatalf("%s: %+v", name, kc)
		}
		if kc.Clusters[0].Cluster.Server != testTarget.Server || kc.Clusters[0].Cluster.CertificateAuthorityData != testCAData {
			t.Fatalf("%s: the endpoint or CA is not pinned: %+v", name, kc.Clusters[0])
		}
	}
}

// TestContextName folds names and refuses empty ones.
func TestContextName(t *testing.T) {
	cases := map[[2]string]string{
		{"Web Shop", "prod"}:        "alethia-web-shop-prod",
		{"api", "staging-eu"}:       "alethia-api-staging-eu",
		{"  --My_App--  ", "Dev.1"}: "alethia-my-app-dev-1",
		{"Ünïcode", "prod"}:         "alethia-n-code-prod",
	}
	for in, want := range cases {
		got, err := Target{Project: in[0], Env: in[1]}.ContextName()
		if err != nil || got != want {
			t.Errorf("ContextName(%q, %q) = %q, %v; want %q", in[0], in[1], got, err, want)
		}
	}
	for _, in := range [][2]string{{"", "prod"}, {"web", ""}, {"---", "prod"}} {
		if _, err := (Target{Project: in[0], Env: in[1]}).ContextName(); !errors.Is(err, ErrRender) {
			t.Errorf("ContextName(%q, %q) accepted", in[0], in[1])
		}
	}
}

// TestRender_Refuses an unpinned target, a bad credential and a bad cluster id or command.
func TestRender_Refuses(t *testing.T) {
	certB64, keyB64, _ := genClientPair(t)
	otherCert, _, _ := genClientPair(t)
	noCA, http, unnamed := testTarget, testTarget, testTarget
	noCA.CAData = ""
	http.Server = "http://api.example.com"
	unnamed.Project = ""
	statics := map[string]struct {
		t Target
		c StaticCredential
	}{
		"no CA":            {noCA, StaticCredential{Token: "t"}},
		"http":             {http, StaticCredential{Token: "t"}},
		"no name":          {unnamed, StaticCredential{Token: "t"}},
		"no credential":    {testTarget, StaticCredential{}},
		"two credentials":  {testTarget, StaticCredential{Token: "t", ClientCertData: certB64, ClientKeyData: keyB64}},
		"token with space": {testTarget, StaticCredential{Token: "a b"}},
		"token newline":    {testTarget, StaticCredential{Token: "a\nusers: []"}},
		"mismatched pair":  {testTarget, StaticCredential{ClientCertData: otherCert, ClientKeyData: keyB64}},
	}
	for name, c := range statics {
		if _, err := RenderStaticKubeconfig(c.t, c.c); !errors.Is(err, ErrRender) {
			t.Errorf("static %s: err = %v", name, err)
		}
	}
	execs := map[string]struct {
		t       Target
		id, cmd string
	}{
		"no CA":          {noCA, testClusterID, ""},
		"http":           {http, testClusterID, ""},
		"uppercase id":   {testTarget, strings.ToUpper(testClusterID), ""},
		"not an id":      {testTarget, "my-cluster", ""},
		"command spaces": {testTarget, testClusterID, " alethia"},
		"command nl":     {testTarget, testClusterID, "alethia\nx"},
	}
	for name, c := range execs {
		if _, err := RenderExecKubeconfig(c.t, c.id, c.cmd); !errors.Is(err, ErrRender) {
			t.Errorf("exec %s: err = %v", name, err)
		}
	}
}
