// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func hetznerQueueProject(names ...string) *types.ProjectConfig {
	pc := &types.ProjectConfig{Provider: types.CloudProviderHetzner}
	for _, n := range names {
		pc.Queues = append(pc.Queues, types.ProjectQueueConfig{Name: n})
	}
	return pc
}

// THE cross-language invariant. The chart reads its password and erlang cookie from whatever
// `auth.existingSecret` names, and the runner writes them into whatever this returns. The two are
// written in different languages and nothing at runtime compares them: a mismatch renders, applies,
// and surfaces only as a StatefulSet that never starts.
//
// So it is read back out of the GENERATED fixture — the product of the real console mapper — rather
// than compared against a string retyped here, which would only prove Go agrees with Go.
func TestQueueCredentialSecretNameAgreesWithTheGeneratedFixture(t *testing.T) {
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
		AddOns []struct {
			ID        string         `json:"id"`
			Namespace string         `json:"namespace"`
			Values    map[string]any `json:"values"`
		} `json:"addons"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	var found int
	for _, spec := range fx.AddOns {
		name, isQueue := strings.CutPrefix(spec.ID, "queue-")
		if !isQueue {
			continue
		}
		found++
		q := HetznerQueues(hetznerQueueProject(name))
		if len(q) != 1 {
			t.Fatalf("derived %d queues for %q, want 1", len(q), name)
		}
		if q[0].AddOnID != spec.ID {
			t.Errorf("AddOnID = %q, want %q — PruneAddOnSecrets matches this against the enabled set",
				q[0].AddOnID, spec.ID)
		}
		if q[0].Namespace != spec.Namespace {
			t.Errorf("Namespace = %q, but the console renders the release into %q", q[0].Namespace, spec.Namespace)
		}
		auth, _ := spec.Values["auth"].(map[string]any)
		if auth == nil {
			t.Fatalf("%s renders no auth block — the chart is minting its own credentials again (#3304)", spec.ID)
		}
		if got := auth["existingSecret"]; got != q[0].CredentialSecretName() {
			t.Errorf("auth.existingSecret = %v, but the runner seeds %q", got, q[0].CredentialSecretName())
		}
		if got := auth["existingPasswordKey"]; got != rabbitmqPasswordKey {
			t.Errorf("auth.existingPasswordKey = %v, but the runner writes the key %q", got, rabbitmqPasswordKey)
		}
		if got := auth["existingErlangCookieKey"]; got != rabbitmqErlangCookieKey {
			t.Errorf("auth.existingErlangCookieKey = %v, but the runner writes the key %q", got, rabbitmqErlangCookieKey)
		}
	}
	// A fixture that stopped carrying a queue would make every assertion above vacuous, and the
	// test would keep reporting success while checking nothing.
	if found == 0 {
		t.Fatal("the generated fixture carries no queue spec — this test proved nothing")
	}
}

// Hetzner only: every other cloud provisions a real queue service, so a derived queue there would
// write a Secret nothing reads.
func TestHetznerQueuesAreDerivedOnHetznerOnly(t *testing.T) {
	for _, p := range []types.CloudProvider{"aws", "gcp", "azure", "alibaba"} {
		pc := hetznerQueueProject("jobs")
		pc.Provider = p
		if got := HetznerQueues(pc); len(got) != 0 {
			t.Errorf("provider %s derived %d queue(s), want 0", p, len(got))
		}
	}
	if got := HetznerQueues(nil); got != nil {
		t.Errorf("HetznerQueues(nil) = %v, want nil", got)
	}
	if got := HetznerQueues(hetznerQueueProject("jobs")); len(got) != 1 {
		t.Fatalf("hetzner derived %d queue(s), want 1", len(got))
	}
}

// A name that could not have come from the console's resolver is dropped rather than interpolated
// into a kubectl command line or a rendered manifest.
func TestHetznerQueuesDropUnsafeNames(t *testing.T) {
	for _, name := range []string{"", "Jobs", "jobs; rm -rf /", "jobs$(id)", "-jobs", "jobs/../x"} {
		if got := HetznerQueues(hetznerQueueProject(name)); len(got) != 0 {
			t.Errorf("name %q derived %d queue(s), want 0", name, len(got))
		}
	}
}

// The credential is created ONCE. Re-applying would hand a running RabbitMQ a new erlang cookie —
// which partitions the cluster — and a new password, which every client that already resolved the
// binding is still using.
func TestEnsureQueueCredentialSecretLeavesAnExistingSecretAlone(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Stdout: `{"data":{"password":"eA=="}}`})
	q := HetznerQueues(hetznerQueueProject("jobs"))[0]

	var out strings.Builder
	if err := EnsureQueueCredentialSecret(q, &out, io.Discard); err != nil {
		t.Fatalf("EnsureQueueCredentialSecret: %v", err)
	}
	if applied := stub.appliedManifests(); applied != "" {
		t.Fatalf("re-minted an existing queue credential:\n%s", applied)
	}
	if !strings.Contains(out.String(), "already exists") {
		t.Errorf("did not report the existing secret: %q", out.String())
	}
}

func TestEnsureQueueCredentialSecretSeedsWhenAbsent(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Exit: 1})
	q := HetznerQueues(hetznerQueueProject("jobs"))[0]

	if err := EnsureQueueCredentialSecret(q, io.Discard, io.Discard); err != nil {
		t.Fatalf("EnsureQueueCredentialSecret: %v", err)
	}
	for _, c := range stub.calls() {
		// A credential must never reach a command line — it rides a 0600 manifest file.
		if strings.Contains(c, "password=") || strings.Contains(c, "erlang-cookie=") {
			t.Errorf("a credential reached argv: %q", c)
		}
	}
	applied := stub.appliedManifests()
	if applied == "" {
		t.Fatalf("never applied the credential secret; calls = %v", stub.calls())
	}
	// Both keys, and both non-empty: a Secret carrying one key is a pod that will not start, and a
	// Secret carrying an empty value is a RabbitMQ with no authentication.
	for _, key := range []string{rabbitmqPasswordKey, rabbitmqErlangCookieKey} {
		line := regexp.MustCompile(`(?m)^  ` + regexp.QuoteMeta(key) + `: (.+)$`).FindStringSubmatch(applied)
		if line == nil {
			t.Fatalf("the applied Secret has no %q key:\n%s", key, applied)
		}
		raw, err := base64.StdEncoding.DecodeString(line[1])
		if err != nil || len(raw) == 0 {
			t.Errorf("%q decoded to %q (err %v) — want a non-empty credential", key, raw, err)
		}
	}
}

func TestEnsureQueueCredentialSecretRefusesAnUnsafeQueue(t *testing.T) {
	newKubectlStub(t, 0)
	bad := HetznerQueue{Name: "jobs; rm -rf /", Namespace: hetznerQueueNamespace, AddOnID: "queue-jobs"}
	if err := EnsureQueueCredentialSecret(bad, io.Discard, io.Discard); err == nil {
		t.Fatal("seeded credentials for an unsafe queue name")
	}
}

// An entropy failure must surface as an error and apply NOTHING. Falling back to something weaker
// is how a "random" credential becomes guessable with nothing downstream noticing.
func TestEnsureQueueCredentialSecretSurfacesAnEntropyFailure(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Exit: 1})
	prev := rabbitmqRandReader
	t.Cleanup(func() { rabbitmqRandReader = prev })
	rabbitmqRandReader = failingReader{}

	q := HetznerQueues(hetznerQueueProject("jobs"))[0]
	if err := EnsureQueueCredentialSecret(q, io.Discard, io.Discard); err == nil {
		t.Fatal("no error when the entropy source failed")
	}
	if applied := stub.appliedManifests(); applied != "" {
		t.Fatalf("applied a secret despite a failed entropy read:\n%s", applied)
	}
}

// The manifest carries BOTH keys, the sweep labels, and — deliberately — no ArgoCD tracking
// metadata. A Secret carrying `app.kubernetes.io/instance` becomes a resource the Application owns,
// and an owned resource absent from the rendered manifest is exactly what `prune: true` deletes.
func TestQueueCredentialSecretManifestShape(t *testing.T) {
	q := HetznerQueues(hetznerQueueProject("jobs"))[0]
	manifest := queueCredentialSecretManifest(q, "pw-value", "cookie-value")

	for _, want := range []string{
		"name: rabbitmq-jobs-credentials",
		"namespace: queues",
		"kind: Namespace",
		"alethia.io/managed-by: addon-marketplace",
		addonSecretLabelKey + ": queue-jobs",
		rabbitmqPasswordKey + ": " + base64.StdEncoding.EncodeToString([]byte("pw-value")),
		rabbitmqErlangCookieKey + ": " + base64.StdEncoding.EncodeToString([]byte("cookie-value")),
	} {
		if !strings.Contains(manifest, want) {
			t.Errorf("manifest is missing %q:\n%s", want, manifest)
		}
	}
	if strings.Contains(manifest, "app.kubernetes.io/instance") {
		t.Errorf("the manifest carries ArgoCD tracking metadata — the Application will prune it:\n%s", manifest)
	}
	// The plaintext must appear nowhere but inside the base64 payload.
	if strings.Contains(manifest, "pw-value") || strings.Contains(manifest, "cookie-value") {
		t.Errorf("a credential is in the manifest in plaintext:\n%s", manifest)
	}
}

// Two queues in one project get two DIFFERENT credentials. A shared cookie would silently merge
// two clusters that are meant to be separate.
func TestQueueCredentialsAreNotSharedBetweenQueues(t *testing.T) {
	qs := HetznerQueues(hetznerQueueProject("jobs", "events"))
	if len(qs) != 2 {
		t.Fatalf("derived %d queues, want 2", len(qs))
	}
	if qs[0].CredentialSecretName() == qs[1].CredentialSecretName() {
		t.Fatalf("both queues share the Secret %q", qs[0].CredentialSecretName())
	}
	first, err := rabbitmqCredential()
	if err != nil {
		t.Fatal(err)
	}
	second, err := rabbitmqCredential()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("two generated credentials are identical")
	}
}

// ── the migration: a queue that already deployed keeps the credentials it is running with ──────

// chartMintedSecretJSON is what the chart's own Secret looks like in the cluster. The chart marks
// it `helm.sh/resource-policy: keep`, so it survives the chart no longer rendering it — which is
// what makes adoption possible at all.
func chartMintedSecretJSON(password, cookie string) string {
	b64 := base64.StdEncoding.EncodeToString
	return `{"items":[
	 {"metadata":{"name":"sh.helm.release.v1.addon-queue-jobs.v1"},"type":"helm.sh/release.v1"},
	 {"metadata":{"name":"addon-queue-jobs-rabbitmq"},"type":"Opaque","data":{` +
		`"password":"` + b64([]byte(password)) + `",` +
		`"erlang-cookie":"` + b64([]byte(cookie)) + `"}}
	]}`
}

// The one-time rotation this fix could have caused is the very breakage it exists to prevent: a new
// erlang cookie partitions a RUNNING cluster and a new password breaks every client that already
// resolved the binding. So the live values are carried across instead.
func TestEnsureQueueCredentialSecretAdoptsTheChartMintedCredentials(t *testing.T) {
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get secret rabbitmq-jobs-credentials", Exit: 1},
		stubRule{Match: "app.kubernetes.io/instance=addon-queue-jobs", Stdout: chartMintedSecretJSON("live-password", "live-cookie")},
	)
	q := HetznerQueues(hetznerQueueProject("jobs"))[0]

	var out strings.Builder
	if err := EnsureQueueCredentialSecret(q, &out, io.Discard); err != nil {
		t.Fatalf("EnsureQueueCredentialSecret: %v", err)
	}
	if !strings.Contains(out.String(), "no rotation") {
		t.Errorf("did not report the adoption: %q", out.String())
	}
	// The APPLIED BYTES decide whether the cluster keeps working, so that is what is asserted —
	// not that an apply happened, and not what the renderer would produce if it were handed the
	// right values. Those are different claims, and only this one is the fix.
	applied := stub.appliedManifests()
	if applied == "" {
		t.Fatalf("applied no manifest at all; calls = %v", stub.calls())
	}
	b64 := base64.StdEncoding.EncodeToString
	if !strings.Contains(applied, rabbitmqPasswordKey+": "+b64([]byte("live-password"))) {
		t.Errorf("the applied Secret does not carry the live password:\n%s", applied)
	}
	if !strings.Contains(applied, rabbitmqErlangCookieKey+": "+b64([]byte("live-cookie"))) {
		t.Errorf("the applied Secret does not carry the live erlang cookie — the cluster would partition:\n%s", applied)
	}
	if !stub.calledWith("app.kubernetes.io/instance=addon-queue-jobs") {
		t.Errorf("never looked for the chart-minted Secret; calls = %v", stub.calls())
	}
}

// HALF a pair is not a migration. Adopting the password while generating a new cookie still
// partitions the cluster — and would do it while reporting that nothing rotated.
func TestAdoptionRefusesAHalfPair(t *testing.T) {
	b64 := base64.StdEncoding.EncodeToString
	for _, tc := range []struct {
		name string
		json string
	}{
		{"password only", `{"items":[{"metadata":{"name":"addon-queue-jobs-rabbitmq"},"type":"Opaque","data":{"password":"` + b64([]byte("pw")) + `"}}]}`},
		{"cookie only", `{"items":[{"metadata":{"name":"addon-queue-jobs-rabbitmq"},"type":"Opaque","data":{"erlang-cookie":"` + b64([]byte("ck")) + `"}}]}`},
		{"no secret at all", `{"items":[]}`},
		{"helm release secret only", `{"items":[{"metadata":{"name":"sh.helm.release.v1.x.v1"},"type":"helm.sh/release.v1","data":{"password":"` + b64([]byte("pw")) + `","erlang-cookie":"` + b64([]byte("ck")) + `"}}]}`},
		{"empty values", `{"items":[{"metadata":{"name":"addon-queue-jobs-rabbitmq"},"type":"Opaque","data":{"password":"","erlang-cookie":""}}]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			newKubectlStub(t, 0, stubRule{Match: "app.kubernetes.io/instance=", Stdout: tc.json})
			q := HetznerQueues(hetznerQueueProject("jobs"))[0]
			if _, _, ok := adoptChartMintedQueueCredentials(q, io.Discard); ok {
				t.Fatal("adopted an incomplete credential pair")
			}
		})
	}
}

// A queue that has never deployed has nothing to adopt, and must still get credentials.
func TestEnsureQueueCredentialSecretGeneratesWhenThereIsNothingToAdopt(t *testing.T) {
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get secret rabbitmq-jobs-credentials", Exit: 1},
		stubRule{Match: "app.kubernetes.io/instance=", Stdout: `{"items":[]}`},
	)
	q := HetznerQueues(hetznerQueueProject("jobs"))[0]

	var out strings.Builder
	if err := EnsureQueueCredentialSecret(q, &out, io.Discard); err != nil {
		t.Fatalf("EnsureQueueCredentialSecret: %v", err)
	}
	if strings.Contains(out.String(), "no rotation") {
		t.Errorf("claimed an adoption with nothing to adopt: %q", out.String())
	}
	if stub.appliedManifests() == "" {
		t.Fatalf("never applied the credential secret; calls = %v", stub.calls())
	}
}
