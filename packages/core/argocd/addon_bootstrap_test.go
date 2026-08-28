// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// vaultBootstrapInstall is a marketplace vault install spec with a bootstrap, as the console emits
// it. Built here rather than read from the fixture so the RENDERER's tests can vary one field at a
// time; the cross-language agreement is pinned separately, below.
func vaultBootstrapInstall() types.AddOnInstall {
	return types.AddOnInstall{
		ID:        "vault",
		Mode:      "managed",
		Namespace: "vault",
		Bootstrap: &types.AddOnBootstrap{
			Kind:        types.AddOnBootstrapVaultInit,
			APIBase:     "http://addon-vault.vault.svc.cluster.local:8200",
			StateSecret: "alethia-vault-addon-state",
		},
	}
}

// TestAddOnBootstrapManifestRendersTheJob pins what the Job must actually contain — not that it
// renders, which any string would.
func TestAddOnBootstrapManifestRendersTheJob(t *testing.T) {
	got, err := AddOnBootstrapManifest(vaultBootstrapInstall(), "ghcr.io/alethialabs/runner:abc123")
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{
		"kind: Job",
		// The namespace must be CREATED by this manifest: ArgoCD makes it on the Application's first
		// sync, which has not happened when this is applied. Without it the whole apply fails with
		// `namespaces "vault" not found` and the bootstrap is skipped.
		"kind: Namespace",
		"name: alethia-bootstrap-vault",
		"namespace: vault",
		"image: ghcr.io/alethialabs/runner:abc123",
		"- vault-bootstrap",
		"- --init-only",
		"- --api-base=http://addon-vault.vault.svc.cluster.local:8200",
		"- --state-secret=alethia-vault-addon-state",
		"- --state-namespace=vault",
		// The RBAC has to travel with the Job: without it the Job's ServiceAccount cannot write the
		// state Secret, Vault is initialised, the unseal key is lost, and nobody can ever open it.
		"kind: ServiceAccount",
		"kind: Role",
		"kind: RoleBinding",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("rendered Job does not contain %q:\n%s", want, got)
		}
	}
	// Cluster-scoped authority would be a real widening — the Job only ever writes one Secret in
	// one namespace.
	for _, forbidden := range []string{"kind: ClusterRole\n", "kind: ClusterRoleBinding"} {
		if strings.Contains(got, forbidden) {
			t.Errorf("rendered Job carries %q; the bootstrap is namespace-scoped by design:\n%s", forbidden, got)
		}
	}
}

// TestAddOnBootstrapManifestRefusesUnsafeInputs varies the axis that decides the verdict — the
// FIELD that is bad — rather than re-asserting one rejection.
//
// Every value here interpolates into a manifest and then into a kubectl command line. A YAML-
// breaking API base is the sharp one: it lands in an unquoted scalar inside the args list, so a
// value carrying `#`, a newline or a stray key would not fail to render, it would render a
// DIFFERENT Job.
func TestAddOnBootstrapManifestRefusesUnsafeInputs(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*types.AddOnInstall)
		image   string
		wantErr string
	}{
		{"no runner image", func(*types.AddOnInstall) {}, "", "no runner image"},
		{"unsafe add-on id", func(a *types.AddOnInstall) { a.ID = "vault/../kube-system" }, "img", "unsafe add-on id"},
		{"unsafe namespace", func(a *types.AddOnInstall) { a.Namespace = "vault; rm -rf /" }, "img", "unsafe namespace"},
		{"unsafe state secret", func(a *types.AddOnInstall) { a.Bootstrap.StateSecret = "a b" }, "img", "unsafe state secret"},
		{"empty api base", func(a *types.AddOnInstall) { a.Bootstrap.APIBase = "" }, "img", "API base"},
		{"api base with a newline", func(a *types.AddOnInstall) {
			a.Bootstrap.APIBase = "http://vault:8200\n            - --state-namespace=kube-system"
		}, "img", "API base"},
		{"api base with userinfo", func(a *types.AddOnInstall) {
			a.Bootstrap.APIBase = "http://user:token@vault:8200"
		}, "img", "API base"},
		{"api base with a path", func(a *types.AddOnInstall) {
			a.Bootstrap.APIBase = "http://vault:8200/v1/sys"
		}, "img", "API base"},
		{"non-http scheme", func(a *types.AddOnInstall) { a.Bootstrap.APIBase = "file:///etc/passwd" }, "img", "API base"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := vaultBootstrapInstall()
			tc.mutate(&a)
			got, err := AddOnBootstrapManifest(a, tc.image)
			if err == nil {
				t.Fatalf("rendered a Job from %s:\n%s", tc.name, got)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error %q does not mention %q — a refusal nobody can act on is barely better than none",
					err, tc.wantErr)
			}
		})
	}
}

// TestAddOnBootstrapDispatchIsTotal is the property the whole file's comment turns on: an
// unrecognised kind is an ERROR, never a skip.
//
// A skipped bootstrap is invisible — the deploy stays green, the add-on sits Progressing forever,
// and nothing says why. That is the exact failure this rail exists to remove, so the dispatcher
// must not reintroduce it. A console shipping a bootstrap kind ahead of the runner is the realistic
// way it happens.
func TestAddOnBootstrapDispatchIsTotal(t *testing.T) {
	a := vaultBootstrapInstall()
	a.Bootstrap.Kind = "harbor-robot"
	if _, err := AddOnBootstrapManifest(a, "img"); err == nil {
		t.Fatal("an unknown bootstrap kind rendered without error; it must be refused loudly")
	}
	b := vaultBootstrapInstall()
	b.Bootstrap = nil
	if _, err := AddOnBootstrapManifest(b, "img"); err == nil {
		t.Fatal("an add-on with no bootstrap rendered a bootstrap")
	}
}

// TestAddOnBootstrapCarriesNoCredential pins AddOnBootstrap's whole contract: it rides the DEPLOY
// job's config snapshot, which is persisted in Postgres, so nothing a credential could be derived
// from may travel in it.
//
// The struct is checked FIELD BY FIELD through JSON rather than by reading the three fields we know
// about, so a field added later is caught by this test rather than by an incident.
func TestAddOnBootstrapCarriesNoCredential(t *testing.T) {
	raw, err := json.Marshal(vaultBootstrapInstall().Bootstrap)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var fields map[string]string
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("AddOnBootstrap no longer serialises as a flat string map (%v) — a nested value could "+
			"carry a credential past this check; re-derive the assertion before relaxing it", err)
	}
	allowed := map[string]struct{}{"kind": {}, "apiBase": {}, "stateSecret": {}}
	for k := range fields {
		if _, ok := allowed[k]; !ok {
			t.Errorf("AddOnBootstrap gained field %q. This struct is PERSISTED in the config snapshot: "+
				"names, namespaces and addresses only. If the new field carries key material, it must be "+
				"minted inside the Job instead", k)
		}
	}
}

// TestVaultAddOnHostAgreesWithTheGeneratedFixture is the cross-language invariant, and it is the one
// that fails in TOTAL SILENCE.
//
// The chart names its Service after the Helm release; ArgoCD's release name is the Application name,
// which is `addon-` + the catalog id. So the console's `apiBase` is not a string anyone gets to
// choose — it is a CONSEQUENCE of the id and namespace it emitted. Get it wrong and nothing errors:
// the Job's requests resolve nowhere, it retries until its backoff is spent, and the only symptom is
// a Vault that stays sealed.
//
// Read back out of the fixture the REAL exporter produced, exactly as the platform Vault's host is
// (vault_test.go), rather than from a string retyped here.
func TestVaultAddOnHostAgreesWithTheGeneratedFixture(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate this file")
	}
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "test", "e2e", "fixtures", "addon_catalog.hetzner.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("generated fixture not present (%v)", err)
	}
	var specs []types.AddOnInstall
	if err := json.Unmarshal(raw, &specs); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	found := 0
	for _, a := range specs {
		if a.ID != "vault" {
			continue
		}
		found++
		if a.Bootstrap == nil {
			t.Fatalf("the generated catalog fixture's vault spec carries NO bootstrap. At catalog " +
				"defaults `initialize` is on, so this means either the knob's default moved or the " +
				"exporter stopped carrying the field — and the add-on now installs a Vault that stays " +
				"sealed forever with nothing saying why")
		}
		want := "http://" + AddOnAppName(a.ID) + "." + a.Namespace + ".svc.cluster.local:8200"
		if a.Bootstrap.APIBase != want {
			t.Errorf("bootstrap apiBase = %q, but the console renders install spec %q into namespace %q, "+
				"which ArgoCD syncs as Helm release %q — so the Service is at %q. A mismatch does not "+
				"error: it resolves nowhere, and the only symptom is a Vault that never unseals",
				a.Bootstrap.APIBase, a.ID, a.Namespace, AddOnAppName(a.ID), want)
		}
		if a.Bootstrap.Kind != types.AddOnBootstrapVaultInit {
			t.Errorf("bootstrap kind = %q, want %q", a.Bootstrap.Kind, types.AddOnBootstrapVaultInit)
		}
		// And it must actually render — the fixture is the only place the two languages meet.
		if _, err := AddOnBootstrapManifest(a, "img"); err != nil {
			t.Errorf("the generated vault spec does not render a bootstrap Job: %v", err)
		}
	}
	if found != 1 {
		t.Fatalf("found %d vault specs in the generated fixture, want exactly 1 — this test asserted nothing", found)
	}
}

// TestEnsureAddOnBootstrapsAppliesOnlyWhatAsks drives the whole apply path against a recording
// kubectl, which is the only way to see the ORDER — and the order is the part that can be quietly
// wrong.
//
// The DELETE must come first and must name the Job this add-on renders. A completed Job cannot be
// re-applied (its fields are immutable), so without the delete a re-deploy silently never re-runs
// the bootstrap and a Vault whose pod restarted stays sealed. And a delete naming the WRONG Job
// would fail in exactly the same silent way, which is why the name is derived from the add-on id.
func TestEnsureAddOnBootstrapsAppliesOnlyWhatAsks(t *testing.T) {
	stub := newKubectlStub(t, 0)
	var stdout, stderr strings.Builder

	addons := []types.AddOnInstall{
		{ID: "velero", Mode: "managed", Namespace: "velero"}, // no bootstrap — must be untouched
		vaultBootstrapInstall(),
	}
	EnsureAddOnBootstraps(addons, "ghcr.io/alethialabs/runner:abc123", &stdout, &stderr)

	calls := stub.calls()
	if len(calls) != 2 {
		t.Fatalf("kubectl was called %d time(s), want exactly 2 (one delete, one apply): %v", len(calls), calls)
	}
	if !strings.Contains(calls[0], "delete job alethia-bootstrap-vault -n vault") {
		t.Errorf("first call = %q, want the delete of this add-on's own Job", calls[0])
	}
	if !strings.Contains(calls[1], "apply") {
		t.Errorf("second call = %q, want the apply", calls[1])
	}
	// An add-on with no bootstrap must produce NO kubectl at all — the count above is what proves
	// velero was skipped rather than merely rendering nothing.
	if strings.Contains(strings.Join(calls, " "), "velero") {
		t.Errorf("an add-on with no bootstrap reached kubectl: %v", calls)
	}
	if stderr.Len() != 0 {
		t.Errorf("a clean run wrote to stderr: %s", stderr.String())
	}
}

// A bootstrap that cannot be RENDERED must be reported and skipped, not panic and not silently
// vanish — and the rest of the list must still run. A deploy whose cluster is otherwise up must not
// fail on one add-on's bad spec, but nobody may have to guess that it did not run.
func TestEnsureAddOnBootstrapsReportsAnUnrenderableSpec(t *testing.T) {
	stub := newKubectlStub(t, 0)
	var stdout, stderr strings.Builder

	broken := vaultBootstrapInstall()
	broken.ID = "vault-two"
	broken.Bootstrap.Kind = "not-a-kind"
	EnsureAddOnBootstraps([]types.AddOnInstall{broken, vaultBootstrapInstall()},
		"img", &stdout, &stderr)

	if !strings.Contains(stderr.String(), "vault-two") {
		t.Errorf("stderr does not name the add-on whose bootstrap was skipped: %q", stderr.String())
	}
	// The GOOD one still ran. A loop that abandoned the rest on the first bad entry would leave
	// every later add-on unbootstrapped with only one warning to show for it.
	if got := strings.Join(stub.calls(), " "); !strings.Contains(got, "alethia-bootstrap-vault ") {
		t.Errorf("the well-formed bootstrap did not run after a broken one: %v", stub.calls())
	}
}

// An apply that FAILS is reported and does not stop the deploy. The cluster is up; the add-on's own
// health is what reports the consequence, and it reports it honestly.
func TestEnsureAddOnBootstrapsSurvivesAFailedApply(t *testing.T) {
	newKubectlStub(t, 0, stubRule{Match: "apply", Exit: 1})
	var stdout, stderr strings.Builder

	EnsureAddOnBootstraps([]types.AddOnInstall{vaultBootstrapInstall()}, "img", &stdout, &stderr)

	if !strings.Contains(stderr.String(), "bootstrap apply failed") {
		t.Errorf("a failed apply was not reported: %q", stderr.String())
	}
}

// Nothing to do must do nothing — no kubectl, no output. Every add-on surface but the marketplace
// Vault is this case, so a loop that shelled out unconditionally would run a delete per add-on on
// every deploy in the product.
func TestEnsureAddOnBootstrapsIsSilentWithNothingToDo(t *testing.T) {
	stub := newKubectlStub(t, 0)
	var stdout, stderr strings.Builder

	EnsureAddOnBootstraps(nil, "img", &stdout, &stderr)
	EnsureAddOnBootstraps([]types.AddOnInstall{{ID: "loki", Mode: "managed", Namespace: "monitoring"}},
		"img", &stdout, &stderr)

	if got := stub.calls(); len(got) != 0 {
		t.Errorf("kubectl ran with no bootstrap to perform: %v", got)
	}
	if stdout.Len() != 0 || stderr.Len() != 0 {
		t.Errorf("output with nothing to do: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}
