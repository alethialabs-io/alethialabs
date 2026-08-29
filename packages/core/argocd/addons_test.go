// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

func sampleAddOn() types.AddOnInstall {
	return types.AddOnInstall{
		ID:        "kube-prometheus-stack",
		Mode:      "managed",
		ChartRepo: "https://prometheus-community.github.io/helm-charts",
		Chart:     "kube-prometheus-stack",
		Version:   "61.9.0",
		Namespace: "monitoring",
		Values: map[string]interface{}{
			"grafana": map[string]interface{}{"enabled": true},
			"prometheus": map[string]interface{}{
				"prometheusSpec": map[string]interface{}{"retention": "15d"},
			},
		},
		SyncWave: 2,
	}
}

func TestRenderAddOnApplication(t *testing.T) {
	manifest, err := RenderAddOnApplication(sampleAddOn())
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	// The manifest must be a well-formed ArgoCD Helm Application with the chart coords.
	for _, want := range []string{
		"kind: Application",
		"name: addon-kube-prometheus-stack",
		"repoURL: https://prometheus-community.github.io/helm-charts",
		"chart: kube-prometheus-stack",
		// NOT asserted as a spelling. yaml.v3 quotes a scalar exactly when the round trip needs it,
		// so "61.9.0" (not a valid number) comes back unquoted and "5.2" would be quoted. The
		// SEMANTICS are asserted in TestRenderAddOnTargetRevisionStaysAString, which is the property
		// the old `targetRevision: "61.9.0"` literal was really reaching for.
		"targetRevision: 61.9.0",
		"namespace: monitoring",
		`sync-wave: "2"`,
		"alethia.io/addon-id: kube-prometheus-stack",
		"alethia.io/addon-mode: managed",
		"retention: 15d", // the merged values, indented under helm.values
		// ServerSideApply so large-CRD charts (kube-prometheus-stack) don't hit ArgoCD's
		// 262144-byte client-side annotation limit on first apply.
		"- ServerSideApply=true",
		"- CreateNamespace=true",
	} {
		if !strings.Contains(manifest, want) {
			t.Errorf("manifest missing %q\n---\n%s", want, manifest)
		}
	}
}

// TestRenderAddOnServerSideApply asserts every rendered add-on Application carries
// ServerSideApply=true — for BOTH the marketplace (Helm-registry) shape and the git-source
// (BYO) shape — so large-CRD charts don't exceed the client-side annotation-size limit.
func TestRenderAddOnServerSideApply(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(a *types.AddOnInstall)
	}{
		{
			name:   "marketplace",
			mutate: func(a *types.AddOnInstall) { a.Source = "" }, // default Helm-registry shape
		},
		{
			name: "git-source",
			mutate: func(a *types.AddOnInstall) {
				a.Source = "git"
				a.Path = "charts/kube-prometheus-stack"
				a.ChartRepo = "https://github.com/acme/apps"
				a.Project = "byo-kube-prometheus-stack"
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := sampleAddOn()
			tc.mutate(&a)
			manifest, err := RenderAddOnApplication(a)
			if err != nil {
				t.Fatalf("render failed: %v", err)
			}
			if !strings.Contains(manifest, "- ServerSideApply=true") {
				t.Errorf("%s manifest missing ServerSideApply=true\n---\n%s", tc.name, manifest)
			}
			if !strings.Contains(manifest, "- CreateNamespace=true") {
				t.Errorf("%s manifest missing CreateNamespace=true\n---\n%s", tc.name, manifest)
			}
			// Under SSA the K8s 1.33+ Deployment .status.terminatingReplicas leaks into the diff and
			// pins the app OutOfSync; ignore it (and RespectIgnoreDifferences so sync honors it).
			if !strings.Contains(manifest, "/status/terminatingReplicas") {
				t.Errorf("%s manifest missing the terminatingReplicas ignoreDifferences\n---\n%s", tc.name, manifest)
			}
			if !strings.Contains(manifest, ".spec.template.spec.containers[]?.env[]?.valueFrom.resourceFieldRef.divisor") {
				t.Errorf("%s manifest missing the resourceFieldRef divisor ignoreDifferences\n---\n%s", tc.name, manifest)
			}
			if !strings.Contains(manifest, "- RespectIgnoreDifferences=true") {
				t.Errorf("%s manifest missing RespectIgnoreDifferences=true\n---\n%s", tc.name, manifest)
			}
			// ServerSideApply=true ALSO selects the diff strategy, and the one it selects
			// (structured-merge) cannot reproduce the API-server defaults inside a StatefulSet's
			// volumeClaimTemplates — which pinned harbor/tempo/vault OutOfSync forever. This
			// annotation overrides the COMPARISON only. It must travel with ServerSideApply on both
			// shapes, so the two are asserted in the same test rather than in separate ones.
			if !strings.Contains(manifest, "argocd.argoproj.io/compare-options: ServerSideDiff=true") {
				t.Errorf("%s manifest missing the ServerSideDiff compare-option\n---\n%s", tc.name, manifest)
			}
		})
	}
}

func TestRenderManagedAddOnsSkipsGitops(t *testing.T) {
	managed := sampleAddOn()
	gitops := sampleAddOn()
	gitops.ID = "loki"
	gitops.Mode = "gitops"

	dir, err := RenderManagedAddOns([]types.AddOnInstall{managed, gitops}, nil)
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	defer os.RemoveAll(dir)

	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("expected 1 managed manifest, got %d", len(entries))
	}
	if entries[0].Name() != "addon-kube-prometheus-stack.yaml" {
		t.Errorf("unexpected file %q", entries[0].Name())
	}
	// The gitops add-on must not have been written to the managed dir.
	if _, err := os.Stat(filepath.Join(dir, "addon-loki.yaml")); err == nil {
		t.Error("gitops add-on should not be rendered in managed mode")
	}
}

func TestManagedAddOnNames(t *testing.T) {
	names := ManagedAddOnNames([]types.AddOnInstall{
		{ID: "loki", Mode: "managed"},
		{ID: "vault", Mode: "gitops"},
		{ID: "kube-prometheus-stack", Mode: "managed"},
	})
	// Only managed add-ons, sorted, prefixed.
	if len(names) != 2 || names[0] != "addon-kube-prometheus-stack" || names[1] != "addon-loki" {
		t.Errorf("unexpected names: %v", names)
	}
}

func TestAllAddOnNames(t *testing.T) {
	names := AllAddOnNames([]types.AddOnInstall{
		{ID: "loki", Mode: "managed"},
		{ID: "vault", Mode: "gitops"},
	})
	// Every mode, sorted.
	if len(names) != 2 || names[0] != "addon-loki" || names[1] != "addon-vault" {
		t.Errorf("unexpected names: %v", names)
	}
}

func TestRenderGitopsModeLabel(t *testing.T) {
	a := sampleAddOn()
	a.Mode = "gitops"
	manifest, err := RenderAddOnApplication(a)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(manifest, "alethia.io/addon-mode: gitops") {
		t.Errorf("expected gitops mode label\n%s", manifest)
	}
}

func TestMarshalValuesEmpty(t *testing.T) {
	got, err := marshalValues(nil)
	if err != nil {
		t.Fatal(err)
	}
	if got != "{}" {
		t.Errorf("expected {} for empty values, got %q", got)
	}
}

func TestReadAddOnHealthUnknownFallback(t *testing.T) {
	// With no cluster reachable, every requested add-on falls back to Unknown (never errors).
	out := ReadAddOnHealth([]string{"addon-loki"}, os.Stdout, os.Stderr)
	h, ok := out["addon-loki"]
	if !ok {
		t.Fatal("expected addon-loki in the result")
	}
	if h.Health != "Unknown" || h.Sync != "Unknown" {
		t.Errorf("expected Unknown fallback, got %+v", h)
	}
}

func TestArgoAppListParse(t *testing.T) {
	// Sanity-check the trimmed shape we unmarshal ArgoCD's list into.
	raw := `{"items":[{"metadata":{"name":"addon-loki"},"status":{"health":{"status":"Healthy"},"sync":{"status":"Synced"}}}]}`
	var list argoAppList
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 || list.Items[0].Status.Health.Status != "Healthy" {
		t.Errorf("parse mismatch: %+v", list)
	}
}

// TestRenderAddOnTargetRevisionStaysAString pins the property the old literal assertion was
// reaching for: a chart version must survive as a STRING, whatever it looks like.
//
// The template hard-quoted it. Marshalling quotes only when the round trip requires it — which is
// strictly more correct, and worth asserting in the case that actually needs it: "5.2" is a valid
// YAML float, so an unquoted emit would come back as 5.2 and ArgoCD would look for a chart version
// that does not exist.
func TestRenderAddOnTargetRevisionStaysAString(t *testing.T) {
	for _, version := range []string{"61.9.0", "5.2", "1.0", "2", "v1.2.3"} {
		t.Run(version, func(t *testing.T) {
			manifest, err := RenderAddOnApplication(types.AddOnInstall{
				ID: "x", Mode: "managed", ChartRepo: "https://example.com", Chart: "x",
				Version: version, Namespace: "x",
			})
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			var back struct {
				Spec struct {
					Source struct {
						TargetRevision string `yaml:"targetRevision"`
					} `yaml:"source"`
				} `yaml:"spec"`
			}
			if err := yaml.Unmarshal([]byte(manifest), &back); err != nil {
				t.Fatalf("rendered manifest does not parse: %v\n%s", err, manifest)
			}
			if got := back.Spec.Source.TargetRevision; got != version {
				t.Errorf("targetRevision round-tripped to %q, want %q\n%s", got, version, manifest)
			}
		})
	}
}

// TestRenderAddOnApplicationResistsYAMLInjection is the #2589 regression.
//
// Every one of these fields reached a text/template with no escaping. `.Namespace` is the readiest
// lever — it comes from the add-on install spec and there is no DNS-1123 validator on this path
// anywhere in packages/core — but the same payload works through `.Chart`, `.Path`, `.ChartRepo`,
// `.ID` and `.Project`, which is why the fix marshals rather than quoting a field at a time.
//
// The assertion is NOT "the payload is absent". A marshalled document legitimately contains the
// payload as DATA. What must not happen is a second DOCUMENT, or the injected key appearing as a
// key of the Application. Asserting absence would fail on a correct fix and pass on a clever one.
func TestRenderAddOnApplicationResistsYAMLInjection(t *testing.T) {
	// Closes a scalar, opens a second document, and declares a cluster-scoped object — the shape
	// the empty clusterResourceWhitelist on the sibling AppProject exists to deny.
	const payload = "x\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: pwn\n"

	for _, tc := range []struct {
		field string
		a     types.AddOnInstall
	}{
		{"namespace", types.AddOnInstall{ID: "a", Mode: "managed", ChartRepo: "https://e.com", Chart: "c", Version: "1", Namespace: payload}},
		{"chart", types.AddOnInstall{ID: "a", Mode: "managed", ChartRepo: "https://e.com", Chart: payload, Version: "1", Namespace: "n"}},
		{"chartRepo", types.AddOnInstall{ID: "a", Mode: "managed", ChartRepo: payload, Chart: "c", Version: "1", Namespace: "n"}},
		{"id", types.AddOnInstall{ID: payload, Mode: "managed", ChartRepo: "https://e.com", Chart: "c", Version: "1", Namespace: "n"}},
		{"project", types.AddOnInstall{ID: "a", Mode: "managed", Project: payload, ChartRepo: "https://e.com", Chart: "c", Version: "1", Namespace: "n"}},
		{"path", types.AddOnInstall{ID: "a", Mode: "managed", Source: "git", Path: payload, ChartRepo: "https://e.com", Version: "1", Namespace: "n"}},
	} {
		t.Run(tc.field, func(t *testing.T) {
			manifest, err := RenderAddOnApplication(tc.a)
			if err != nil {
				t.Fatalf("render: %v", err)
			}

			// ONE document. A `---` separator at the start of a line is the injection succeeding.
			var docs int
			dec := yaml.NewDecoder(strings.NewReader(manifest))
			for {
				var doc map[string]any
				derr := dec.Decode(&doc)
				if derr != nil {
					break
				}
				docs++
				if docs == 1 {
					if doc["kind"] != "Application" {
						t.Fatalf("first document is %v, not an Application:\n%s", doc["kind"], manifest)
					}
				}
			}
			if docs != 1 {
				t.Fatalf("%s injection produced %d documents, want 1:\n%s", tc.field, docs, manifest)
			}

			// And the payload must have survived as DATA — proving the test is not passing because
			// the value was silently dropped, which would be a different bug wearing this one's clothes.
			if !strings.Contains(manifest, "pwn") {
				t.Errorf("the payload vanished entirely; the field was dropped rather than escaped:\n%s", manifest)
			}
		})
	}
}

// #2910: a git-source (BYO) Application was rendered with NO `syncPolicy.automated`, and nothing in
// production ever syncs one — so a customer's chart got a namespace, a repository credential and a
// hardened AppProject, then deployed nothing at all, silently. The only sync in the tree is the
// e2e's `triggerArgoSync`, which meant the harness proved a path a customer does not have.
//
// These pin BOTH halves of the fix, because the two failure modes are opposite: rendering no
// `automated` at all brings the silent no-op back, and rendering prune/selfHeal TRUE would start
// deleting resources a customer removed from their chart and reverting their live edits.
func TestRenderAddOnAutomatedSyncPolicy(t *testing.T) {
	byo := func(a *types.AddOnInstall) {
		a.Source = "git"
		a.Path = "charts/acme"
		a.ChartRepo = "https://github.com/acme/apps"
		a.Project = "byo-acme"
	}

	t.Run("a BYO chart auto-syncs, with prune and selfHeal OFF", func(t *testing.T) {
		a := sampleAddOn()
		byo(&a)
		manifest, err := RenderAddOnApplication(a)
		if err != nil {
			t.Fatalf("render failed: %v", err)
		}
		// The presence of `automated` is what enables auto-sync at all — this is the assertion that
		// fails if the nil ever comes back.
		if !strings.Contains(manifest, "automated:") {
			t.Fatalf("a BYO chart with no `automated` policy never syncs and deploys nothing\n---\n%s", manifest)
		}
		// `prune`/`selfHeal` have no omitempty, so they render explicitly rather than as a bare
		// `automated: {}` — which keeps the manifest self-documenting about the trade.
		if !strings.Contains(manifest, "prune: false") {
			t.Errorf("BYO prune must be false — we do not delete a customer's workload because their chart stopped mentioning it\n---\n%s", manifest)
		}
		if !strings.Contains(manifest, "selfHeal: false") {
			t.Errorf("BYO selfHeal must be false — ArgoCD must not fight an operator debugging their own chart\n---\n%s", manifest)
		}
	})

	t.Run("a marketplace chart keeps prune and selfHeal ON", func(t *testing.T) {
		// The catalog owns these, so the cluster should converge to what it declares. Asserted so
		// the BYO change cannot be applied to both branches by accident.
		a := sampleAddOn()
		a.Source = ""
		manifest, err := RenderAddOnApplication(a)
		if err != nil {
			t.Fatalf("render failed: %v", err)
		}
		if !strings.Contains(manifest, "prune: true") || !strings.Contains(manifest, "selfHeal: true") {
			t.Errorf("a marketplace add-on must keep prune+selfHeal on\n---\n%s", manifest)
		}
	})

	t.Run("the two shapes differ", func(t *testing.T) {
		// Guards the accident the sub-tests above cannot see individually: one branch edited to
		// match the other would pass whichever assertion it now satisfies.
		m := sampleAddOn()
		m.Source = ""
		marketplace, err := RenderAddOnApplication(m)
		if err != nil {
			t.Fatalf("render failed: %v", err)
		}
		b := sampleAddOn()
		byo(&b)
		chart, err := RenderAddOnApplication(b)
		if err != nil {
			t.Fatalf("render failed: %v", err)
		}
		if strings.Contains(chart, "prune: true") {
			t.Errorf("the BYO shape picked up the marketplace policy\n---\n%s", chart)
		}
		if strings.Contains(marketplace, "prune: false") {
			t.Errorf("the marketplace shape picked up the BYO policy\n---\n%s", marketplace)
		}
	})
}

// The CRD ignore that #2907/#2947 finally made it possible to measure. `spec.preserveUnknownFields`
// was REMOVED in apiextensions.k8s.io/v1 — the API server accepts `false` and does not persist it —
// so a chart still declaring it renders a field the cluster never reports back, and the Application
// sits OutOfSync forever on a value nobody can change. argo-rollouts declares it on all five of its
// CRDs, which is exactly the five ArgoCD's diff named on hetzner/addons run 33067969126.
func TestRenderAddOnIgnoresRemovedCRDField(t *testing.T) {
	a := sampleAddOn()
	manifest, err := RenderAddOnApplication(a)
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	for _, want := range []string{
		"group: apiextensions.k8s.io",
		"kind: CustomResourceDefinition",
		"/spec/preserveUnknownFields",
	} {
		if !strings.Contains(manifest, want) {
			t.Errorf("manifest missing %q\n---\n%s", want, manifest)
		}
	}

	// The Deployment entry must SURVIVE. Both are ignoreDifferences and it would be easy to replace
	// rather than append — that would silently reintroduce the terminatingReplicas diff #2778 fixed.
	for _, want := range []string{
		"kind: Deployment",
		"/status/terminatingReplicas",
		".spec.template.spec.containers[]?.env[]?.valueFrom.resourceFieldRef.divisor",
	} {
		if !strings.Contains(manifest, want) {
			t.Errorf("the pre-existing Deployment ignore was lost: missing %q\n---\n%s", want, manifest)
		}
	}

	// RespectIgnoreDifferences is what makes the SYNC honour them, not just the diff view. Without
	// it the entries above change the display and nothing else.
	if !strings.Contains(manifest, "RespectIgnoreDifferences=true") {
		t.Errorf("ignoreDifferences without RespectIgnoreDifferences only changes the view\n---\n%s", manifest)
	}
}

// The keda webhook entry, and the two properties that make it an EVIDENCED ignore rather than a
// guessed one: it names both fields a foreign writer owns, and it is SCOPED to the one object.
//
// Measured on azure/addons run 33249209041, by the ownership probe #3301 repaired:
//
//	owned by "admissionsenforcer": .webhooks[*].namespaceSelector
//	owned by "keda":               .webhooks[*].clientConfig.caBundle
//
// The cloud split is the tell. `keda` writes its own serving CA everywhere; `admissionsenforcer` is
// AKS's, and exists on AKS alone — which is why gcp and hetzner converged with byte-identical chart
// values while azure sat Healthy+OutOfSync across two paid runs.
func TestKedaWebhookIgnoreDifferencesIsScopedAndNamesBothOwners(t *testing.T) {
	a := sampleAddOn()
	a.ID = "keda"
	manifest, err := RenderAddOnApplication(a)
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	for _, want := range []string{
		"kind: ValidatingWebhookConfiguration",
		"name: keda-admission",
		".webhooks[]?.clientConfig.caBundle",
		".webhooks[]?.namespaceSelector",
	} {
		if !strings.Contains(manifest, want) {
			t.Errorf("the keda ignoreDifferences entry is missing %q\n---\n%s", want, manifest)
		}
	}
	// SCOPED. Without `name`, this would ignore a caBundle on every ValidatingWebhookConfiguration
	// the marketplace installs — including ones whose caBundle nobody writes, where a difference
	// WOULD be real drift. #2778 is explicit that a guessed entry masks it.
	if strings.Count(manifest, "name: keda-admission") != 1 {
		t.Errorf("the entry must name exactly one object\n---\n%s", manifest)
	}
}
