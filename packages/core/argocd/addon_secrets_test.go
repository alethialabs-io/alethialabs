// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const secretSentinel = "SENTINEL-ADDON-SECRET-3f9d2c-DO-NOT-RENDER"

// TestAddonSecretManifest locks the seeded Secret's shape: namespace pair (must exist
// before CreateNamespace=true), deterministic name, marketplace + addon-id labels for
// prune, base64 data, sorted keys — and NO ArgoCD tracking metadata (nothing may adopt
// and prune this Secret).
func TestAddonSecretManifest(t *testing.T) {
	ref := types.AddOnSecretRef{
		SecretName: "alethia-addon-external-dns",
		Namespace:  "external-dns",
		Keys:       []string{"apiToken"},
	}
	m := addonSecretManifest(ref, "external-dns", map[string]string{"apiToken": secretSentinel})

	for _, want := range []string{
		"kind: Namespace",
		"name: external-dns",
		"kind: Secret",
		"name: alethia-addon-external-dns",
		"namespace: external-dns",
		"alethia.io/managed-by: addon-marketplace",
		"alethia.io/addon-secret: external-dns",
		"apiToken: " + base64.StdEncoding.EncodeToString([]byte(secretSentinel)),
	} {
		if !strings.Contains(m, want) {
			t.Errorf("manifest missing %q:\n%s", want, m)
		}
	}
	// The value crosses ONLY base64-encoded inside the Secret — never plaintext.
	if strings.Contains(m, secretSentinel) {
		t.Errorf("plaintext secret leaked into the manifest:\n%s", m)
	}
	// No ArgoCD tracking metadata — an Application must never own this Secret.
	for _, forbid := range []string{"argocd.argoproj.io", "app.kubernetes.io/instance"} {
		if strings.Contains(m, forbid) {
			t.Errorf("manifest carries ArgoCD tracking metadata %q — a sync could prune the Secret", forbid)
		}
	}
}

// TestAddonSecretManifestDeterministic asserts multi-key data renders in sorted key
// order (diff-stable across deploys).
func TestAddonSecretManifestDeterministic(t *testing.T) {
	ref := types.AddOnSecretRef{SecretName: "alethia-addon-x", Namespace: "x", Keys: []string{"b", "a"}}
	m1 := addonSecretManifest(ref, "x", map[string]string{"b": "2", "a": "1"})
	m2 := addonSecretManifest(ref, "x", map[string]string{"a": "1", "b": "2"})
	if m1 != m2 {
		t.Fatalf("manifest render is not deterministic:\n%s\n---\n%s", m1, m2)
	}
	if strings.Index(m1, "  a: ") > strings.Index(m1, "  b: ") {
		t.Errorf("data keys not sorted:\n%s", m1)
	}
}

// TestRenderAddOnApplication_SecretRefNeverRendered locks the wire contract with the
// console (W4.5): an add-on whose values carry SecretKeyRef WIRING renders an
// Application that references the Secret — and the SecretRef metadata itself (or any
// value) never appears in the Application manifest.
func TestRenderAddOnApplication_SecretRefNeverRendered(t *testing.T) {
	app := types.AddOnInstall{
		ID: "external-dns", Mode: "managed",
		ChartRepo: "https://kubernetes-sigs.github.io/external-dns/",
		Chart:     "external-dns", Version: "1.15.0", Namespace: "external-dns",
		Values: map[string]interface{}{
			"provider": map[string]interface{}{"name": "cloudflare"},
			"env": []interface{}{map[string]interface{}{
				"name": "CF_API_TOKEN",
				"valueFrom": map[string]interface{}{
					"secretKeyRef": map[string]interface{}{
						"name": "alethia-addon-external-dns", "key": "apiToken",
					},
				},
			}},
		},
		SyncWave: 2,
		SecretRef: &types.AddOnSecretRef{
			SecretName: "alethia-addon-external-dns", Namespace: "external-dns", Keys: []string{"apiToken"},
		},
	}
	manifest, err := RenderAddOnApplication(app)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(manifest, "secretKeyRef") ||
		!strings.Contains(manifest, "alethia-addon-external-dns") {
		t.Errorf("Application values must carry the secretKeyRef wiring:\n%s", manifest)
	}
	// The renderer must not serialize the SecretRef struct into the Application.
	if strings.Contains(manifest, "secretRef:") || strings.Contains(manifest, "keys:") {
		t.Errorf("SecretRef metadata leaked into the Application manifest:\n%s", manifest)
	}
}

// TestValidSecretRef fail-closes YAML/shell injection through a tampered config
// snapshot: a newline (a second YAML document), a shell metachar, or an uppercase
// non-DNS name must all be refused before rendering.
func TestValidSecretRef(t *testing.T) {
	good := types.AddOnSecretRef{SecretName: "alethia-addon-x", Namespace: "x-ns", Keys: []string{"api_Token.1"}}
	if !validSecretRef(good, "external-dns") {
		t.Fatal("a well-formed ref must validate")
	}
	bad := []types.AddOnSecretRef{
		{SecretName: "a\nkind: Pod", Namespace: "x", Keys: []string{"k"}},
		{SecretName: "a", Namespace: "x; rm -rf /", Keys: []string{"k"}},
		{SecretName: "a", Namespace: "x", Keys: []string{"k\n  evil: dmFs"}},
		{SecretName: "UPPER", Namespace: "x", Keys: []string{"k"}},
	}
	for i, ref := range bad {
		if validSecretRef(ref, "id") {
			t.Errorf("bad ref %d validated: %+v", i, ref)
		}
	}
	if validSecretRef(good, "id with spaces") {
		t.Error("a non-DNS addon id must be refused (it lands in a label value)")
	}
}

// TestAddOnInstallSecretRefRoundTrip locks the console↔runner JSON contract, including
// the version-skew direction: JSON without secretRef (an old console) parses to nil.
func TestAddOnInstallSecretRefRoundTrip(t *testing.T) {
	in := `{"id":"external-dns","mode":"managed","chartRepo":"r","chart":"c","version":"1",
		"namespace":"external-dns","values":{},"syncWave":2,
		"secretRef":{"secretName":"alethia-addon-external-dns","namespace":"external-dns","keys":["apiToken"]}}`
	var a types.AddOnInstall
	if err := json.Unmarshal([]byte(in), &a); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if a.SecretRef == nil || a.SecretRef.SecretName != "alethia-addon-external-dns" ||
		len(a.SecretRef.Keys) != 1 || a.SecretRef.Keys[0] != "apiToken" {
		t.Errorf("secretRef did not round-trip: %+v", a.SecretRef)
	}

	var old types.AddOnInstall
	if err := json.Unmarshal([]byte(`{"id":"x","mode":"managed","chartRepo":"r","chart":"c","version":"1","namespace":"n","values":{},"syncWave":0}`), &old); err != nil {
		t.Fatalf("unmarshal old shape: %v", err)
	}
	if old.SecretRef != nil {
		t.Errorf("pre-W4.5 JSON must parse with a nil SecretRef, got %+v", old.SecretRef)
	}
}
