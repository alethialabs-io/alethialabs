// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/base64"
	"io"
	"strings"
	"testing"
	"time"
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
	origWait, origPoll := externalSecretsStoreMaxWait, clusterSecretStoreCRDPollInterval
	externalSecretsStoreMaxWait = 300 * time.Millisecond
	clusterSecretStoreCRDPollInterval = time.Millisecond
	t.Cleanup(func() {
		externalSecretsStoreMaxWait, clusterSecretStoreCRDPollInterval = origWait, origPoll
	})

	stub := newKubectlStub(t, 0, stubRule{
		Match:  "wait --for=condition=established",
		Stdout: `Error from server (NotFound): customresourcedefinitions.apiextensions.k8s.io "clustersecretstores.external-secrets.io" not found`,
		Exit:   1,
	})
	facts := &InfraFacts{
		Provider: "aws", Region: "us-east-1",
		IRSAExternalSecretsArn: "arn:aws:iam::123:role/eso",
	}
	var stdout, stderr bytes.Buffer
	if err := EnsureExternalSecretsStore(facts, &stdout, &stderr); err != nil {
		t.Fatalf("EnsureExternalSecretsStore() error = %v, want nil — a CRD that never appears is the apply's problem to report", err)
	}

	waits := 0
	for _, c := range stub.calls() {
		if strings.Contains(c, "wait --for=condition=established") {
			waits++
		}
	}
	if waits < 2 {
		t.Fatalf("the CRD wait was issued %d time(s) — a not-yet-registered CRD must be polled, not given up on: %v",
			waits, stub.calls())
	}
	if !strings.Contains(stdout.String(), "isn't Established yet (attempt 1)") {
		t.Errorf("the poll never reported that it was waiting:\n%s", stdout.String())
	}
}
