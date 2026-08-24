// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func hetznerRegistryProject(names ...string) *types.ProjectConfig {
	pc := &types.ProjectConfig{Provider: "hetzner"}
	for _, n := range names {
		pc.ContainerRegistries = append(pc.ContainerRegistries, types.ProjectContainerRegistryConfig{Name: n})
	}
	return pc
}

// THE invariant that fails silently. The dockerconfigjson is keyed on a host; if that host is not
// the one the kubelet pulls from, the entry is simply never matched — no error anywhere, and the
// pull fails looking exactly like a wrong password. Three places must agree: the chart's externalURL
// (console), this Host, and the Talos containerd mirror.
func TestHetznerRegistryHostMatchesTheConsoleContract(t *testing.T) {
	regs := HetznerRegistries(hetznerRegistryProject("app-images"))
	if len(regs) != 1 {
		t.Fatalf("derived %d registries, want 1", len(regs))
	}
	const want = "registry-app-images.registries.svc.cluster.local"
	if regs[0].Host != want {
		t.Fatalf("Host = %q, want %q — this must equal hetznerRegistryHost() in "+
			"apps/console/lib/cloud-providers/hetzner-services.ts, which also produced the chart's externalURL", regs[0].Host, want)
	}
}

// The generated fixture is produced by the REAL console mapper, so reading the host back out of it
// is a check against the actual TS contract rather than against a string retyped in Go.
func TestHetznerRegistryHostAgreesWithTheGeneratedFixture(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate this file")
	}
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "test", "e2e", "fixtures", "hetzner_data_services.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("generated fixture not present (%v)", err)
	}
	var fx struct {
		ChartedNotOffered []struct {
			ID     string         `json:"id"`
			Values map[string]any `json:"values"`
		} `json:"chartedNotOffered"`
		AddOns []struct {
			ID     string         `json:"id"`
			Values map[string]any `json:"values"`
		} `json:"addons"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	specs := append(fx.ChartedNotOffered, fx.AddOns...)
	var externalURL, adminSecret, adminKey string
	for _, s := range specs {
		if !strings.HasPrefix(s.ID, "registry-") {
			continue
		}
		if v, ok := s.Values["externalURL"].(string); ok {
			externalURL = v
		}
		if v, ok := s.Values["existingSecretAdminPassword"].(string); ok {
			adminSecret = v
		}
		if v, ok := s.Values["existingSecretAdminPasswordKey"].(string); ok {
			adminKey = v
		}
	}
	if externalURL == "" {
		t.Fatal("the fixture carries no registry spec with an externalURL")
	}
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	if externalURL != "http://"+reg.Host {
		t.Errorf("chart externalURL %q disagrees with the pull host %q — Harbor bakes externalURL into "+
			"the tokens it issues, so a mismatch authenticates and then 401s on every pull", externalURL, reg.Host)
	}

	// The chart must read the admin password from the Secret the runner seeds. Without these the
	// chart falls back to its published default — which is exactly what #2430 shipped.
	if adminSecret != reg.AdminSecretName() {
		t.Errorf("chart existingSecretAdminPassword = %q, runner seeds %q", adminSecret, reg.AdminSecretName())
	}
	if adminKey != harborAdminSecretKey {
		t.Errorf("chart existingSecretAdminPasswordKey = %q, runner writes key %q", adminKey, harborAdminSecretKey)
	}
}

func TestHetznerRegistriesOnlyOnHetzner(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba"} {
		pc := hetznerRegistryProject("app-images")
		pc.Provider = types.CloudProvider(provider)
		if got := HetznerRegistries(pc); len(got) != 0 {
			t.Errorf("%s derived %d in-cluster registries — every other cloud provisions a real one "+
				"whose nodes authenticate with their own identity", provider, len(got))
		}
	}
	if got := HetznerRegistries(nil); got != nil {
		t.Errorf("a nil project derived %v", got)
	}
}

func TestHetznerRegistriesSkipsAnUnsafeName(t *testing.T) {
	pc := hetznerRegistryProject("app-images", "Bad Name", "", "ok")
	got := HetznerRegistries(pc)
	names := make([]string, 0, len(got))
	for _, r := range got {
		names = append(names, r.Name)
	}
	// These names interpolate into a kubectl command line and a rendered manifest, so anything that
	// is not an RFC-1123 label is dropped rather than escaped.
	if len(got) != 2 || names[0] != "app-images" || names[1] != "ok" {
		t.Fatalf("derived %v, want only the two safe names", names)
	}
}

func TestHarborBootstrapJobIsLeastPrivilege(t *testing.T) {
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	y, err := HarborBootstrapJobManifest(reg, "ghcr.io/alethialabs/runner:abc123")
	if err != nil {
		t.Fatalf("render: %v", err)
	}

	// `get` + `patch` on exactly one named Secret. `list`/`watch` cannot be name-scoped, so granting
	// either would expose every Secret in the namespace; `create` cannot be name-scoped either, which
	// is why the Secret is pre-seeded by the runner instead.
	if !strings.Contains(y, `resourceNames: ["registry-app-images-pull"]`) {
		t.Error("the Role is not scoped to a single resourceName")
	}
	if !strings.Contains(y, `verbs: ["get", "patch"]`) {
		t.Error("the Role's verbs are not exactly get+patch")
	}
	for _, forbidden := range []string{`"list"`, `"watch"`, `"create"`, `"delete"`, `"*"`} {
		if strings.Contains(y, "verbs: [") && strings.Contains(strings.SplitN(y, "verbs: [", 2)[1][:40], forbidden) {
			t.Errorf("the Role grants %s", forbidden)
		}
	}
	if strings.Contains(y, "ClusterRole") {
		t.Error("the bootstrap Job binds a ClusterRole — it must be namespace-scoped")
	}
}

// The admin password must reach the Job as a mounted FILE. argv is world-readable through /proc and
// env is visible in `kubectl describe pod`; a credential in either is a credential in the job log of
// whoever debugs the pod next.
func TestHarborBootstrapJobTakesTheAdminPasswordAsAFile(t *testing.T) {
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	y, err := HarborBootstrapJobManifest(reg, "runner:v1")
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(y, "--admin-password-file=/harbor-admin/"+harborAdminSecretKey) {
		t.Error("the admin password is not passed as a mounted file")
	}
	if !strings.Contains(y, "secretName: "+reg.AdminSecretName()) {
		t.Errorf("the Job does not mount %s", reg.AdminSecretName())
	}
	// No env-sourced credential anywhere.
	if strings.Contains(y, "secretKeyRef") || strings.Contains(y, "HARBOR_ADMIN_PASSWORD=") {
		t.Error("a credential reaches the container through env rather than a file")
	}
}

func TestHarborBootstrapJobPassesTheSameHostTwice(t *testing.T) {
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	y, err := HarborBootstrapJobManifest(reg, "runner:v1")
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	// The API base and the dockerconfigjson host are the same string on purpose: Harbor bakes
	// externalURL into its tokens, so an API reached by one name and a credential keyed on another
	// authenticates and then fails at pull.
	if !strings.Contains(y, "--api-base=http://"+reg.Host) || !strings.Contains(y, "--registry-host="+reg.Host) {
		t.Errorf("the Job does not pass %q as both the API base and the registry host", reg.Host)
	}
}

func TestHarborBootstrapJobRefusesInvalidInput(t *testing.T) {
	good := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	if _, err := HarborBootstrapJobManifest(good, ""); err == nil {
		t.Error("rendered a Job with no runner image")
	}
	bad := good
	bad.Host = "registry-app-images.registries.svc.cluster.local\nfoo: bar"
	if _, err := HarborBootstrapJobManifest(bad, "runner:v1"); err == nil {
		t.Error("rendered a Job with a host that would inject YAML")
	}
}

func TestHarborAdminSecretManifestCarriesTheChartsKey(t *testing.T) {
	y := harborAdminSecretManifest("registries", "harbor-app-images-admin", "hunter2")
	if !strings.Contains(y, "  "+harborAdminSecretKey+": ") {
		t.Errorf("the Secret does not carry the key the chart reads (%s)", harborAdminSecretKey)
	}
	// Never a plaintext password in the rendered manifest.
	if strings.Contains(y, "hunter2") {
		t.Error("the password appears in plaintext in the manifest")
	}
}

func TestHarborAdminPasswordSatisfiesHarborsComplexityRule(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		pw, err := harborAdminPassword()
		if err != nil {
			t.Fatalf("generate: %v", err)
		}
		if len(pw) < 8 || len(pw) > 128 {
			t.Fatalf("password length %d is outside Harbor's 8-128 rule", len(pw))
		}
		var upper, lower, digit bool
		for _, r := range pw {
			switch {
			case r >= 'A' && r <= 'Z':
				upper = true
			case r >= 'a' && r <= 'z':
				lower = true
			case r >= '0' && r <= '9':
				digit = true
			}
		}
		if !upper || !lower || !digit {
			t.Fatalf("password %q misses a required class (upper=%v lower=%v digit=%v) — Harbor would refuse to start", pw, upper, lower, digit)
		}
		if seen[pw] {
			t.Fatal("generated a duplicate password")
		}
		seen[pw] = true
	}
}

// ── the runner-side orchestration, against a stubbed kubectl ───────────────────────────────────

// The admin password is created ONCE and then read, never rewritten. Rotating it on every deploy
// would change the password Alethia authenticates with while Harbor's own database still holds the
// previous one — an immediate lockout that looks like a Harbor bug.
func TestEnsureHarborAdminSecretLeavesAnExistingPasswordAlone(t *testing.T) {
	// `kubectl get secret` succeeds ⇒ the Secret exists.
	stub := newKubectlStub(t, 0)
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]

	var out strings.Builder
	if err := EnsureHarborAdminSecret(reg, &out, io.Discard); err != nil {
		t.Fatalf("EnsureHarborAdminSecret: %v", err)
	}
	for _, c := range stub.calls() {
		if strings.Contains(c, "apply") {
			t.Fatalf("re-applied the admin secret over an existing one: %q", c)
		}
	}
	if !strings.Contains(out.String(), "already exists") {
		t.Errorf("did not report the existing secret: %q", out.String())
	}
}

func TestEnsureHarborAdminSecretSeedsWhenAbsent(t *testing.T) {
	// `kubectl get secret` fails ⇒ absent; the apply must follow.
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Exit: 1})
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]

	if err := EnsureHarborAdminSecret(reg, io.Discard, io.Discard); err != nil {
		t.Fatalf("EnsureHarborAdminSecret: %v", err)
	}
	applied := false
	for _, c := range stub.calls() {
		if strings.Contains(c, "apply") {
			applied = true
		}
		// The password must never reach a command line.
		if strings.Contains(c, "HARBOR_ADMIN_PASSWORD=") {
			t.Errorf("a password reached argv: %q", c)
		}
	}
	if !applied {
		t.Fatalf("never applied the admin secret; calls = %v", stub.calls())
	}
}

func TestEnsureHarborAdminSecretRefusesAnUnsafeRegistry(t *testing.T) {
	newKubectlStub(t, 0)
	bad := HarborRegistry{Name: "Bad Name", Namespace: "registries", Host: "h", PullSecretName: "p", PullSecretNamespace: "default"}
	if err := EnsureHarborAdminSecret(bad, io.Discard, io.Discard); err == nil {
		t.Error("seeded a secret for a registry whose name is not an RFC-1123 label")
	}
}

// The pull Secret is pre-created by the RUNNER so the Job's Role can be scoped to a single
// resourceName: RBAC cannot name-scope `create`, so a Job that created its own Secret would need
// namespace-wide create authority.
func TestEnsureHarborPullCredentialsSeedsTheSecretBeforeTheJob(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Exit: 1})
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]

	if err := EnsureHarborPullCredentials(context.Background(), reg, "runner:v1", io.Discard, io.Discard); err != nil {
		t.Fatalf("EnsureHarborPullCredentials: %v", err)
	}
	calls := stub.calls()
	deleteAt, applyCount := -1, 0
	for i, c := range calls {
		if strings.Contains(c, "delete job") {
			deleteAt = i
		}
		if strings.Contains(c, "apply") {
			applyCount++
		}
	}
	// admin secret + pull secret + the Job.
	if applyCount < 3 {
		t.Errorf("applied %d manifests, want at least 3 (admin secret, pull secret, Job); calls = %v", applyCount, calls)
	}
	// The stale Job is removed first: re-applying a completed Job fails on immutable fields, so
	// without this a re-deploy silently never re-runs the verify step.
	if deleteAt == -1 {
		t.Error("never deleted the previous bootstrap Job — a re-deploy would not re-run it")
	}
}

func TestEnsureHarborPullCredentialsRefusesWithNoRunnerImage(t *testing.T) {
	newKubectlStub(t, 0, stubRule{Match: "get secret", Exit: 1})
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	if err := EnsureHarborPullCredentials(context.Background(), reg, "", io.Discard, io.Discard); err == nil {
		t.Error("rendered and applied a Job with no runner image")
	}
}

func TestEnsureHarborAdminSecretReportsAnApplyFailure(t *testing.T) {
	// absent, then `kubectl apply` fails — the caller must see it rather than proceed to a Job that
	// would authenticate with nothing.
	newKubectlStub(t, 0, stubRule{Match: "get secret", Exit: 1}, stubRule{Match: "apply", Exit: 1})
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	if err := EnsureHarborAdminSecret(reg, io.Discard, io.Discard); err == nil {
		t.Error("a failed apply was reported as success")
	}
}

func TestEnsureHarborPullCredentialsStopsIfTheAdminSecretFails(t *testing.T) {
	newKubectlStub(t, 0, stubRule{Match: "get secret", Exit: 1}, stubRule{Match: "apply", Exit: 1})
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	if err := EnsureHarborPullCredentials(context.Background(), reg, "runner:v1", io.Discard, io.Discard); err == nil {
		t.Error("continued to the Job after the admin secret failed")
	}
}

func TestEnsureHarborPullCredentialsRefusesAnUnsafeRegistry(t *testing.T) {
	newKubectlStub(t, 0)
	bad := HarborRegistry{Name: "app images", Namespace: "registries", Host: "h", PullSecretName: "p", PullSecretNamespace: "default"}
	if err := EnsureHarborPullCredentials(context.Background(), bad, "runner:v1", io.Discard, io.Discard); err == nil {
		t.Error("accepted a registry whose name is not an RFC-1123 label")
	}
}

// A password generated from a failed entropy source must never be emitted. Falling back to
// something weaker is how a "random" credential becomes guessable, and nothing downstream notices.
func TestHarborAdminPasswordFailsRatherThanWeakensOnEntropyFailure(t *testing.T) {
	prev := harborRandReader
	t.Cleanup(func() { harborRandReader = prev })
	harborRandReader = failingReader{}

	if _, err := harborAdminPassword(); err == nil {
		t.Fatal("generated a password from a failed entropy source")
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("no entropy") }

func TestEnsureHarborAdminSecretSurfacesAnEntropyFailure(t *testing.T) {
	newKubectlStub(t, 0, stubRule{Match: "get secret", Exit: 1})
	prev := harborRandReader
	t.Cleanup(func() { harborRandReader = prev })
	harborRandReader = failingReader{}

	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	err := EnsureHarborAdminSecret(reg, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "generate Harbor admin password") {
		t.Fatalf("error = %v, want a generation failure", err)
	}
}
