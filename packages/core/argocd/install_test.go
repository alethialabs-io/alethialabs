// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/base64"
	"io"
	"regexp"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func TestIsOperatorNotReady(t *testing.T) {
	cases := []struct {
		name   string
		output string
		want   bool
	}{
		{"crd not registered", `error: resource mapping not found for name: "secretstore-azure": no matches for kind "ClusterSecretStore" in version "external-secrets.io/v1beta1"`, true},
		{"no matches for kind", `unable to recognize "x.yaml": no matches for kind "SecretStore"`, true},
		{"webhook no endpoints", `Error from server (InternalError): failed calling webhook "validate.clustersecretstore.external-secrets.io": failed to call webhook: Post "https://...": no endpoints available for service "external-secrets-operator-webhook"`, true},
		{"real auth failure not retried", `error: unable to apply: forbidden: user cannot patch`, false},
		{"validation error not retried", `error validating data: unknown field "spec.bogus"`, false},
		{"empty output", "", false},
	}
	for _, c := range cases {
		if got := isOperatorNotReady(c.output); got != c.want {
			t.Errorf("%s: isOperatorNotReady=%v, want %v", c.name, got, c.want)
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

func TestEnsureExternalDNSCredentialRefusesEmptyToken(t *testing.T) {
	// Fail-closed: an empty token means the render gate should have skipped the app —
	// writing an empty secret would just move the failure into the cluster.
	hetzner := &InfraFacts{Provider: "hetzner", DNSCredentialPresent: true}
	if err := EnsureExternalDNSCredential(hetzner, "", "", io.Discard, io.Discard); err == nil {
		t.Fatalf("expected an error for an empty token")
	}
}

func TestExternalSecretsStoreManifest(t *testing.T) {
	cases := []struct {
		name        string
		facts       *InfraFacts
		wantStore   string // "" ⇒ expect NO store (fail-closed / no cloud secret manager)
		wantContain []string
	}{
		{"aws with IRSA", &InfraFacts{Provider: "aws", Region: "us-east-1", IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso"},
			"secretstore-aws", []string{"service: SecretsManager", "region: us-east-1", "name: external-secrets-operator-sa"}},
		{"gcp with GSA", &InfraFacts{Provider: "gcp", GCPExternalSecretsSA: "eso@p.iam.gserviceaccount.com", GCPProjectID: "proj-1"},
			"secretstore-gcp", []string{"gcpsm:", "projectID: proj-1"}},
		{"azure with client + vault", &InfraFacts{Provider: "azure", AzureExternalSecretsClient: "cid", AzureKeyVaultURI: "https://kv.vault.azure.net/"},
			"secretstore-azure", []string{"azurekv:", "authType: WorkloadIdentity", "vaultUrl: https://kv.vault.azure.net/"}},
		{"alibaba with role", &InfraFacts{Provider: "alibaba", Region: "eu-central-1", AlibabaExternalSecretsRoleArn: "acs:ram::1:role/eso", AlibabaOIDCProviderArn: "acs:ram::1:oidc-provider/ack"},
			"secretstore-alibaba", []string{"alibaba:", "regionID: eu-central-1", "rrsa:", "roleArn: acs:ram::1:role/eso"}},
		{"hetzner has no cloud store", &InfraFacts{Provider: "hetzner", Region: "nbg1"}, "", nil},
		{"aws without the IRSA fact is fail-closed empty", &InfraFacts{Provider: "aws", Region: "us-east-1"}, "", nil},
		{"azure missing the vault URI is empty", &InfraFacts{Provider: "azure", AzureExternalSecretsClient: "cid"}, "", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, err := externalSecretsStoreManifest(c.facts)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			if c.wantStore == "" {
				if m != "" {
					t.Fatalf("expected NO store, got:\n%s", m)
				}
				return
			}
			if !strings.Contains(m, "kind: ClusterSecretStore") || !strings.Contains(m, "name: "+c.wantStore) {
				t.Fatalf("expected a %s ClusterSecretStore, got:\n%s", c.wantStore, m)
			}
			for _, want := range c.wantContain {
				if !strings.Contains(m, want) {
					t.Errorf("store must contain %q:\n%s", want, m)
				}
			}
			// #1306: every rendered store is scoped away from placed tenant namespaces via
			// spec.conditions, so a `placement=namespace` tenant on a shared Fabric can't reach it.
			assertScopedAwayFromTenants(t, m)
			// Exactly one cloud's block renders — never a leaked doc separator from a sibling.
			if strings.Contains(m, "---") {
				t.Errorf("a single store must not contain a doc separator:\n%s", m)
			}
		})
	}
}

// TestExternalSecretsStoreManifest_Xacct covers the ADDITIONAL cross-account (*-xacct) ClusterSecretStore:
// it renders as a SECOND document (with a `---` separator) alongside the native store, and only when BOTH
// the cluster's own external-secrets identity fact AND the cross-account target are present (fail-closed).
//
// It doubles as the drift guard for InfraFacts.XacctSecretStore: every case asserts the GATE agrees with
// what the TEMPLATE actually rendered. The gate is what the decision record, the stale-store reaper and the
// manifest lane all read, so a template branch changed without the gate (or vice versa) would let a
// workload reference a store that was never applied. Asserting both off ONE table is why they can't drift.
func TestExternalSecretsStoreManifest_Xacct(t *testing.T) {
	cases := []struct {
		name        string
		facts       *InfraFacts
		wantStore   string // the -xacct store expected, "" ⇒ none (fail-closed)
		wantContain []string
	}{
		{"aws xacct assumes target role",
			&InfraFacts{Provider: "aws", Region: "us-east-1", IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso",
				SecretsXacctRef: "arn:aws:iam::999:role/read", SecretsXacctRegion: "eu-west-1"},
			"secretstore-aws-xacct", []string{"role: arn:aws:iam::999:role/read", "region: eu-west-1", "service: SecretsManager"}},
		// An sts:ExternalId condition on the target trust policy must reach the store or STS rejects every
		// assume — the dangling-control bug (the bootstrap module offered external_id while nothing carried
		// it through to ESO). Absent id ⇒ field omitted, asserted separately below.
		{"aws xacct forwards the external id when the trust policy requires one",
			&InfraFacts{Provider: "aws", Region: "us-east-1", IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso",
				SecretsXacctRef: "arn:aws:iam::999:role/read", SecretsXacctRegion: "eu-west-1", SecretsXacctExternalID: "acme-7f3c"},
			"secretstore-aws-xacct", []string{"role: arn:aws:iam::999:role/read", "externalID: acme-7f3c"}},
		{"gcp xacct reads target project",
			&InfraFacts{Provider: "gcp", GCPExternalSecretsSA: "eso@p.iam.gserviceaccount.com", GCPProjectID: "proj-1",
				SecretsXacctProjectID: "secrets-project-b"},
			"secretstore-gcp-xacct", []string{"gcpsm:", "projectID: secrets-project-b"}},
		{"azure xacct reads target vault",
			&InfraFacts{Provider: "azure", AzureExternalSecretsClient: "cid", AzureKeyVaultURI: "https://kv.vault.azure.net/",
				SecretsXacctRef: "https://target.vault.azure.net/"},
			"secretstore-azure-xacct", []string{"authType: WorkloadIdentity", "vaultUrl: https://target.vault.azure.net/"}},
		{"alibaba xacct via target OIDC provider",
			&InfraFacts{Provider: "alibaba", Region: "cn-hangzhou", AlibabaExternalSecretsRoleArn: "acs:ram::1:role/eso", AlibabaOIDCProviderArn: "acs:ram::1:oidc-provider/ack",
				SecretsXacctRef: "acs:ram::999:role/read", SecretsXacctOIDCProviderRef: "acs:ram::999:oidc-provider/ack", SecretsXacctRegion: "cn-hangzhou"},
			"secretstore-alibaba-xacct", []string{"roleArn: acs:ram::999:role/read", "oidcProviderArn: acs:ram::999:oidc-provider/ack"}},
		// Fail-closed: a cross-account target selected but the cluster's own identity fact is absent ⇒
		// NEITHER store renders (nothing to authenticate the read).
		{"aws xacct without IRSA is fail-closed empty",
			&InfraFacts{Provider: "aws", Region: "us-east-1", SecretsXacctRef: "arn:aws:iam::999:role/read"}, "", nil},
		// Fail-closed: alibaba xacct missing the target OIDC provider ⇒ no xacct store.
		{"alibaba xacct without target OIDC provider omits the xacct store",
			&InfraFacts{Provider: "alibaba", Region: "cn-hangzhou", AlibabaExternalSecretsRoleArn: "acs:ram::1:role/eso", AlibabaOIDCProviderArn: "acs:ram::1:oidc-provider/ack",
				SecretsXacctRef: "acs:ram::999:role/read"}, "", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, err := externalSecretsStoreManifest(c.facts)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			// The gate must report exactly what the template rendered — in BOTH directions.
			gotName, gotSelected := c.facts.XacctSecretStore()
			if !gotSelected {
				t.Fatalf("XacctSecretStore reported not-selected, but these facts carry a cross-account target")
			}
			if gotName != c.wantStore {
				t.Errorf("XacctSecretStore name = %q, but the template rendered %q — the gate and the template have drifted", gotName, c.wantStore)
			}
			if c.wantStore == "" {
				if strings.Contains(m, "-xacct") {
					t.Fatalf("expected NO -xacct store, got:\n%s", m)
				}
				return
			}
			if !strings.Contains(m, "name: "+c.wantStore) {
				t.Fatalf("expected a %s ClusterSecretStore, got:\n%s", c.wantStore, m)
			}
			// The xacct store is a SECOND document alongside the native one — the separator must be present.
			if !strings.Contains(m, "---") {
				t.Errorf("expected a doc separator between the native and %s stores:\n%s", c.wantStore, m)
			}
			for _, want := range c.wantContain {
				if !strings.Contains(m, want) {
					t.Errorf("%s must contain %q:\n%s", c.wantStore, want, m)
				}
			}
			// #1306: the -xacct store (and the native store beside it) are both scoped away from
			// placed tenant namespaces — a shared-Fabric tenant must not reach a FOREIGN-account store.
			assertScopedAwayFromTenants(t, m)
		})
	}
}

// assertScopedAwayFromTenants verifies the rendered manifest carries the #1306 spec.conditions guard
// that keeps every ClusterSecretStore out of reach of placed tenant namespaces (labeled
// alethia.io/placement=namespace). It also guards the ESO footgun that an EMPTY namespaceSelector ({})
// means match-ALL — the matchExpressions form must actually render.
func assertScopedAwayFromTenants(t *testing.T, m string) {
	t.Helper()
	for _, want := range []string{"conditions:", "key: alethia.io/placement", "operator: NotIn", `values: ["namespace"]`} {
		if !strings.Contains(m, want) {
			t.Errorf("store must be scoped away from tenant namespaces (missing %q):\n%s", want, m)
		}
	}
	if strings.Contains(m, "namespaceSelector: {}") {
		t.Errorf("an empty namespaceSelector means match-ALL — the scope guard is missing:\n%s", m)
	}
}

// The external id is OPTIONAL: a target role whose trust policy has NO sts:ExternalId condition is the
// common case, and sending one anyway would make STS reject the assume. So the field must be absent from
// the rendered store — not empty-valued — when the connector doesn't set it.
func TestExternalSecretsStoreManifest_XacctOmitsAbsentExternalID(t *testing.T) {
	m, err := externalSecretsStoreManifest(&InfraFacts{
		Provider: "aws", Region: "us-east-1", IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso",
		SecretsXacctRef: "arn:aws:iam::999:role/read", SecretsXacctRegion: "eu-west-1",
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(m, "secretstore-aws-xacct") {
		t.Fatalf("expected the xacct store to render:\n%s", m)
	}
	if strings.Contains(m, "externalID") {
		t.Fatalf("externalID must be omitted when unset, got:\n%s", m)
	}
}

// ── #2652: the ClusterSecretStore CRD wait ───────────────────────────────────────────────────────

// TestIsCRDPendingEstablishment pins BOTH halves of the classifier, because the two halves have
// opposite costs. Matching too little turns a normal fresh-cluster wait into no wait at all; matching
// too much turns "the cluster cannot answer" into a fifteen-minute stall before the apply that would
// have reported the real cause. `kubectl: command not found` is in the reject list specifically —
// a bare "not found" marker would have matched it.
func TestIsCRDPendingEstablishment(t *testing.T) {
	pending := map[string]string{
		"the CRD does not exist yet": `Error from server (NotFound): customresourcedefinitions.apiextensions.k8s.io "clustersecretstores.external-secrets.io" not found`,
		"older kubectl phrasing":     `error: no matching resources found`,
		"exists but not Established": `error: timed out waiting for the condition on customresourcedefinitions/clustersecretstores.external-secrets.io`,
	}
	for name, output := range pending {
		if !isCRDPendingEstablishment(output) {
			t.Errorf("%s: isCRDPendingEstablishment=false, want true — the operator is still installing", name)
		}
	}

	unanswerable := map[string]string{
		"rbac refusal":     `Error from server (Forbidden): customresourcedefinitions.apiextensions.k8s.io is forbidden: User "runner" cannot get resource`,
		"no cluster":       `Unable to connect to the server: dial tcp 127.0.0.1:6443: connect: connection refused`,
		"no kubectl":       `bash: line 1: kubectl: command not found`,
		"empty output":     "",
		"unrelated stdout": "customresourcedefinition.apiextensions.k8s.io/clustersecretstores.external-secrets.io condition met",
	}
	for name, output := range unanswerable {
		if isCRDPendingEstablishment(output) {
			t.Errorf("%s: isCRDPendingEstablishment=true, want false — waiting cannot fix this", name)
		}
	}
}

// firstCallIndex returns the index of the first recorded kubectl invocation containing every
// fragment, or -1. Order of invocations is the assertion #2652 is about, so the tests need indices
// rather than calledWith's boolean.
func firstCallIndex(calls []string, fragments ...string) int {
	for i, c := range calls {
		all := true
		for _, f := range fragments {
			if !strings.Contains(c, f) {
				all = false
				break
			}
		}
		if all {
			return i
		}
	}
	return -1
}

// TestTheStoreWaitsForItsCRDBeforeApplyingIt is #2652's ordering fix.
//
// The store's kind is installed asynchronously by ArgoCD, and the apply's retry loop was ABSORBING
// `no matches for kind` for up to fifteen minutes instead of waiting for the CRD — so the deploy's
// correctness rested on a retry rather than on order. The wait must be issued, must name the
// cluster-scoped CRD, and must come BEFORE the apply; issuing it afterwards would assert nothing.
func TestTheStoreWaitsForItsCRDBeforeApplyingIt(t *testing.T) {
	stub := newKubectlStub(t, 0)
	facts := &InfraFacts{
		Provider: "aws", Region: "us-east-1",
		IRSAExternalSecretsArn: "arn:aws:iam::123:role/eso",
	}
	var stdout, stderr bytes.Buffer
	if err := EnsureExternalSecretsStore(facts, &stdout, &stderr); err != nil {
		t.Fatalf("EnsureExternalSecretsStore() error = %v, want nil", err)
	}

	calls := stub.calls()
	waitAt := firstCallIndex(calls, "wait --for=condition=established", "crd/clustersecretstores.external-secrets.io")
	applyAt := firstCallIndex(calls, "apply --server-side")
	if waitAt < 0 {
		t.Fatalf("no wait on the ClusterSecretStore CRD was issued at all: %v", calls)
	}
	if applyAt < 0 {
		t.Fatalf("the store was never applied: %v", calls)
	}
	if waitAt > applyAt {
		t.Fatalf("the CRD wait was issued AFTER the apply (wait=%d apply=%d) — it cannot order anything: %v",
			waitAt, applyAt, calls)
	}

	// #2652 point 3: a green run must carry evidence of WHICH path it took. A converged retry and a
	// clean first apply printed the same single line before this.
	if !strings.Contains(stdout.String(), "applied on attempt 1, after clustersecretstores.external-secrets.io was confirmed Established") {
		t.Errorf("the success line does not record the attempt count and the confirmed CRD:\n%s", stdout.String())
	}
}

// TestTheVaultStoreRidesTheSameCRDWait covers vault.go's caller. EnsureHetznerSecretStore applies the
// same kind against the same CRD and shares applyStoreAwaitingOperator deliberately, so the wait must
// reach it too — a fix applied at one of two call sites is a fix that drifts.
func TestTheVaultStoreRidesTheSameCRDWait(t *testing.T) {
	stub := newKubectlStub(t, 0)
	var stdout, stderr bytes.Buffer
	if err := EnsureHetznerSecretStore(
		&InfraFacts{Provider: "hetzner", HetznerInClusterVault: true}, &stdout, &stderr,
	); err != nil {
		t.Fatalf("EnsureHetznerSecretStore() error = %v, want nil", err)
	}
	calls := stub.calls()
	waitAt := firstCallIndex(calls, "wait --for=condition=established", "crd/clustersecretstores.external-secrets.io")
	applyAt := firstCallIndex(calls, "apply --server-side")
	if waitAt < 0 || applyAt < 0 || waitAt > applyAt {
		t.Fatalf("the in-cluster Vault store did not wait for its CRD before applying (wait=%d apply=%d): %v",
			waitAt, applyAt, calls)
	}
}

// TestAnUnanswerableCRDWaitIsNeitherReadinessNorFailure is the failure branch, which is this repo's
// dominant defect class: a check whose "could not look" outcome is indistinguishable from "nothing
// wrong". Three separate things must hold when the wait cannot be answered at all —
//
//   - it must NOT read as ready: the log says the CRD was not confirmed, and the success line says
//     the apply ran without a confirmation rather than claiming one;
//   - it must NOT become a hard failure: the apply still runs, and a working apply still returns nil,
//     so a slow establish stays as recoverable as it was before the wait existed;
//   - it must NOT consume the store's budget: an RBAC refusal is not a race, so re-asking it fifteen
//     minutes long would only delay the apply that reports the real cause. The default
//     externalSecretsStoreMaxWait is left in place here precisely so a regression to "retry
//     everything" hangs this test instead of passing it.
func TestAnUnanswerableCRDWaitIsNeitherReadinessNorFailure(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{
		Match:  "wait --for=condition=established",
		Stdout: `Error from server (Forbidden): customresourcedefinitions.apiextensions.k8s.io is forbidden: User "runner" cannot get resource`,
		Exit:   1,
	})
	facts := &InfraFacts{
		Provider: "aws", Region: "us-east-1",
		IRSAExternalSecretsArn: "arn:aws:iam::123:role/eso",
	}
	var stdout, stderr bytes.Buffer

	start := time.Now()
	err := EnsureExternalSecretsStore(facts, &stdout, &stderr)
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("a CRD wait that could not be answered failed the deploy: %v", err)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("an unanswerable CRD wait was retried on the store's budget (took %s)", elapsed)
	}
	if !stub.calledWith("apply --server-side") {
		t.Fatalf("the store was never applied — an unconfirmed CRD must not skip the apply: %v", stub.calls())
	}
	if !strings.Contains(stderr.String(), "could not confirm") ||
		!strings.Contains(stderr.String(), "NOT treating that as ready") {
		t.Errorf("the unconfirmed CRD was not reported as unconfirmed:\n%s", stderr.String())
	}
	if strings.Contains(stdout.String(), "was confirmed Established") {
		t.Errorf("a wait that never answered was logged as a confirmation:\n%s", stdout.String())
	}
	if !strings.Contains(stdout.String(), "WITHOUT clustersecretstores.external-secrets.io having been confirmed") {
		t.Errorf("the success line does not admit the CRD was unconfirmed:\n%s", stdout.String())
	}
}

// TestTheCRDWaitRetriesWhileTheCRDIsStillRegistering proves the wait actually WAITS. `kubectl wait`
// on a named resource that does not exist yet fails immediately rather than blocking, so on a fresh
// cluster — the exact case #2652 is about — a single unconditional wait would return at once and
// order nothing. Only the poll makes it an ordering primitive.
func TestTheCRDWaitRetriesWhileTheCRDIsStillRegistering(t *testing.T) {
	// THE LOOP MUST END ON STATE, NOT ON A CLOCK.
	//
	// This test used to cap `externalSecretsStoreMaxWait` at 300ms against a stub that answered
	// NotFound forever, and assert the wait had been issued at least twice before the deadline
	// elapsed. Every stub call spawns a `/bin/sh`, so the assertion was really "can this machine
	// fork twice in 300ms" — true on an idle laptop, false under coverage instrumentation or on a
	// loaded CI runner. It failed exactly that way once, and a wall-clock flake in a shared repo
	// reds pull requests that have nothing to do with it.
	//
	// So the CRD now BECOMES Established on the third answer, and the deadline is set far beyond
	// anything the test needs. The loop exits because the condition it waits for came true, which
	// is the behaviour under test; the count is then exact rather than a lower bound, and no
	// amount of machine load can change it.
	origWait, origPoll := externalSecretsStoreMaxWait, clusterSecretStoreCRDPollInterval
	externalSecretsStoreMaxWait = time.Minute
	clusterSecretStoreCRDPollInterval = time.Millisecond
	t.Cleanup(func() {
		externalSecretsStoreMaxWait, clusterSecretStoreCRDPollInterval = origWait, origPoll
	})

	notFound := `Error from server (NotFound): customresourcedefinitions.apiextensions.k8s.io "clustersecretstores.external-secrets.io" not found`
	stub := newKubectlStub(t, 0, stubRule{
		Match:  "wait --for=condition=established",
		Stdout: notFound,
		Exit:   1,
		Then: []stubAnswer{
			{Stdout: notFound, Exit: 1},
			{Stdout: "customresourcedefinition.apiextensions.k8s.io/clustersecretstores.external-secrets.io condition met", Exit: 0},
		},
	})
	facts := &InfraFacts{
		Provider: "aws", Region: "us-east-1",
		IRSAExternalSecretsArn: "arn:aws:iam::123:role/eso",
	}
	var stdout, stderr bytes.Buffer
	if err := EnsureExternalSecretsStore(facts, &stdout, &stderr); err != nil {
		t.Fatalf("EnsureExternalSecretsStore() error = %v, want nil", err)
	}

	waits := 0
	for _, c := range stub.calls() {
		if strings.Contains(c, "wait --for=condition=established") {
			waits++
		}
	}
	// EXACTLY three: two NotFounds and the one that succeeded. Fewer means the poll gave up on a
	// CRD that was still registering; more means it kept asking after the answer was yes.
	if waits != 3 {
		t.Fatalf("the CRD wait was issued %d time(s), want exactly 3 (NotFound, NotFound, Established): %v",
			waits, stub.calls())
	}
	if !strings.Contains(stdout.String(), "isn't Established yet (attempt 1)") {
		t.Errorf("the poll never reported that it was waiting:\n%s", stdout.String())
	}
	// The point of polling is to reach a CONFIRMED establish. A run that only ever saw NotFound
	// and fell through to the apply retry would satisfy the count above but not this.
	if !strings.Contains(stdout.String(), "was confirmed Established") {
		t.Errorf("the poll never reported the establish it was waiting for:\n%s", stdout.String())
	}
}

// esoLabelRequirement, esoNamespaceSelector and esoStoreCondition are the slice of an ESO
// ClusterSecretStore's spec.conditions the evaluator below reads.
type esoLabelRequirement struct {
	Key      string   `yaml:"key"`
	Operator string   `yaml:"operator"`
	Values   []string `yaml:"values"`
}

type esoNamespaceSelector struct {
	MatchLabels      map[string]string     `yaml:"matchLabels"`
	MatchExpressions []esoLabelRequirement `yaml:"matchExpressions"`
}

type esoStoreCondition struct {
	NamespaceSelector *esoNamespaceSelector `yaml:"namespaceSelector"`
	Namespaces        []string              `yaml:"namespaces"`
	NamespaceRegexes  []string              `yaml:"namespaceRegexes"`
}

type esoStoreDoc struct {
	Kind     string `yaml:"kind"`
	Metadata struct {
		Name string `yaml:"name"`
	} `yaml:"metadata"`
	Spec struct {
		Conditions []esoStoreCondition `yaml:"conditions"`
	} `yaml:"spec"`
}

// esoSelectorMatches is a Kubernetes label selector over one namespace's labels: every matchLabels
// pair and every matchExpressions requirement must hold. An operator it does not know fails the test
// rather than being guessed at.
func esoSelectorMatches(t *testing.T, sel esoNamespaceSelector, nsLabels map[string]string) bool {
	t.Helper()
	for k, v := range sel.MatchLabels {
		if nsLabels[k] != v {
			return false
		}
	}
	for _, r := range sel.MatchExpressions {
		v, has := nsLabels[r.Key]
		in := false
		for _, want := range r.Values {
			if has && v == want {
				in = true
			}
		}
		switch r.Operator {
		case "In":
			if !in {
				return false
			}
		case "NotIn":
			if in {
				return false
			}
		case "Exists":
			if !has {
				return false
			}
		case "DoesNotExist":
			if has {
				return false
			}
		default:
			t.Fatalf("label selector operator %q is not one this evaluator reads", r.Operator)
		}
	}
	return true
}

// esoStoreAdmits answers ESO's own question for a ClusterSecretStore and a namespace
// (pkg/controllers/secretstore/client_manager.go at v0.9.20, the pinned chart): no conditions admits
// every namespace; otherwise the namespace is admitted when ANY condition matches it, by selector, by
// name (which ESO turns into a kubernetes.io/metadata.name selector) or by regex. Conditions see
// only the NAMESPACE the requesting object lives in, never the object, which is why a test of them
// is a test over namespaces.
func esoStoreAdmits(t *testing.T, store esoStoreDoc, ns string, nsLabels map[string]string) bool {
	t.Helper()
	if len(store.Spec.Conditions) == 0 {
		return true
	}
	labels := map[string]string{"kubernetes.io/metadata.name": ns}
	for k, v := range nsLabels {
		labels[k] = v
	}
	for _, c := range store.Spec.Conditions {
		if c.NamespaceSelector != nil && esoSelectorMatches(t, *c.NamespaceSelector, labels) {
			return true
		}
		for _, n := range c.Namespaces {
			if n == ns {
				return true
			}
		}
		for _, re := range c.NamespaceRegexes {
			if regexp.MustCompile(re).MatchString(ns) {
				return true
			}
		}
	}
	return false
}

// everyRenderedSecretStore renders every ClusterSecretStore the platform applies: each cloud's native
// store, each cross-account store, and the in-cluster Vault store on Hetzner.
func everyRenderedSecretStore(t *testing.T) []esoStoreDoc {
	t.Helper()
	facts := []*InfraFacts{
		{Provider: "aws", Region: "us-east-1", IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso",
			SecretsXacctRef: "arn:aws:iam::999:role/read", SecretsXacctRegion: "eu-west-1"},
		{Provider: "gcp", GCPExternalSecretsSA: "eso@p.iam.gserviceaccount.com", GCPProjectID: "proj-1",
			SecretsXacctProjectID: "secrets-project-b"},
		{Provider: "azure", AzureExternalSecretsClient: "cid", AzureKeyVaultURI: "https://kv.vault.azure.net/",
			SecretsXacctRef: "https://target.vault.azure.net/"},
		{Provider: "alibaba", Region: "cn-hangzhou", AlibabaExternalSecretsRoleArn: "acs:ram::1:role/eso", AlibabaOIDCProviderArn: "acs:ram::1:oidc-provider/ack",
			SecretsXacctRef: "acs:ram::999:role/read", SecretsXacctOIDCProviderRef: "acs:ram::999:oidc-provider/ack", SecretsXacctRegion: "cn-hangzhou"},
	}
	streams := []string{HetznerSecretStoreManifest()}
	for _, f := range facts {
		m, err := externalSecretsStoreManifest(f)
		if err != nil {
			t.Fatalf("render %s store: %v", f.Provider, err)
		}
		streams = append(streams, m)
	}
	var out []esoStoreDoc
	for _, s := range streams {
		dec := yaml.NewDecoder(strings.NewReader(s))
		for {
			var d esoStoreDoc
			if err := dec.Decode(&d); err != nil {
				if err == io.EOF {
					break
				}
				t.Fatalf("parse store manifest: %v\n%s", err, s)
			}
			if d.Kind == "ClusterSecretStore" {
				out = append(out, d)
			}
		}
	}
	// 4 native + 4 cross-account + Hetzner. A count that falls means a store went unexamined.
	if len(out) != 9 {
		t.Fatalf("expected 9 ClusterSecretStores, parsed %d", len(out))
	}
	return out
}

// TestSecretStoreConditionsAdmitTheRunnersBindingPath pins which namespaces the platform's
// ClusterSecretStores serve, evaluated the way ESO evaluates them.
//
// A BYO chart's namespace, labelled exactly as the runner labels it (RenderByoNamespaces with the
// runner's secret-store stamp, which provisioner.configureByoCharts passes), IS admitted: the
// runner's per-binding ExternalSecrets live there (the Secret a chart's existingSecret names must be
// in the chart's own namespace), so excluding it would withdraw every binding. Because a condition
// selects namespaces and never objects, what keeps a chart from declaring its own ExternalSecret
// there is the BYO AppProject's deny (TestByoAppProjectDeniesSecretSyncKinds), not these conditions.
// A placed tenant namespace is excluded (#1306).
//
// The stamp (secretStoreConditions): a namespace marked as a BYO chart's WITHOUT it is refused; an
// ordinary unlabelled namespace is still served; and a reserved platform namespace is still served
// even when a runner from before #6439/#6446 marked it as a BYO chart's — "default" holds every
// first-class service's binding ExternalSecrets.
func TestSecretStoreConditionsAdmitTheRunnersBindingPath(t *testing.T) {
	rendered, err := RenderByoNamespaces([]string{"byo-payments"}, map[string]string{ByoBindingOwnerLabel: "env-1", SecretStoreAccessLabel: SecretStoreAccessValue})
	if err != nil {
		t.Fatalf("render BYO namespace: %v", err)
	}
	var ns struct {
		Metadata struct {
			Name   string            `yaml:"name"`
			Labels map[string]string `yaml:"labels"`
		} `yaml:"metadata"`
	}
	if err := yaml.Unmarshal([]byte(rendered), &ns); err != nil {
		t.Fatalf("parse BYO namespace: %v\n%s", err, rendered)
	}
	unstamped := map[string]string{}
	for k, v := range ns.Metadata.Labels {
		if k != SecretStoreAccessLabel {
			unstamped[k] = v
		}
	}
	for _, store := range everyRenderedSecretStore(t) {
		if !esoStoreAdmits(t, store, ns.Metadata.Name, ns.Metadata.Labels) {
			t.Errorf("%s does not admit the BYO namespace %s (labels %v): the runner's binding ExternalSecrets there would stop syncing",
				store.Metadata.Name, ns.Metadata.Name, ns.Metadata.Labels)
		}
		if esoStoreAdmits(t, store, ns.Metadata.Name, unstamped) {
			t.Errorf("%s admits a namespace marked as a BYO chart's without the runner's stamp (labels %v)", store.Metadata.Name, unstamped)
		}
		if !esoStoreAdmits(t, store, "payments", nil) {
			t.Errorf("%s does not admit an ordinary unlabelled namespace", store.Metadata.Name)
		}
		for _, platform := range []string{"default", "monitoring"} {
			if !esoStoreAdmits(t, store, platform, unstamped) {
				t.Errorf("%s does not admit the platform namespace %q an older runner marked as a BYO chart's", store.Metadata.Name, platform)
			}
		}
		if !esoStoreAdmits(t, store, "alethia-byo-db-users", map[string]string{"alethia.io/byo-db-users": "true", SecretStoreAccessLabel: SecretStoreAccessValue}) {
			t.Errorf("%s does not admit the BYO users namespace", store.Metadata.Name)
		}
		if esoStoreAdmits(t, store, "tenant-a", map[string]string{"alethia.io/placement": "namespace"}) {
			t.Errorf("%s admits a placed tenant namespace", store.Metadata.Name)
		}
		if esoStoreAdmits(t, store, "default", map[string]string{"alethia.io/placement": "namespace", SecretStoreAccessLabel: SecretStoreAccessValue}) {
			t.Errorf("%s admits a placed tenant namespace through the stamp or the platform-name condition", store.Metadata.Name)
		}
	}
}
