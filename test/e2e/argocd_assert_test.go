// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Negative-path proof for the ArgoCD health assertion (BYOC A0.2): the parsing +
// decision logic is exercised against synthetic `applications.argoproj.io` JSON and
// metadata shapes WITHOUT a cluster — healthy, degraded, out-of-sync, missing app,
// and (crucially) the empty-expected-set vacuity guard, so the assertion itself is
// proven able to fail before any tier relies on it. UNTAGGED: runs under a bare
// `go test ./...` in test/e2e (no docker/kind/postgres needed).
package e2e

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// argoAppsJSON builds a minimal `kubectl get applications -o json` document from
// (name, health, sync) triples, in the exact shape parseArgoApps consumes.
func argoAppsJSON(items ...[3]string) []byte {
	var b strings.Builder
	b.WriteString(`{"items":[`)
	for i, it := range items {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"metadata":{"name":"` + it[0] + `"},"status":{"health":{"status":"` + it[1] + `"},"sync":{"status":"` + it[2] + `"}}}`)
	}
	b.WriteString(`]}`)
	return []byte(b.String())
}

func TestParseArgoApps(t *testing.T) {
	raw := []byte(`{"items":[
		{"metadata":{"name":"addon-reloader"},
		 "status":{"health":{"status":"Healthy"},"sync":{"status":"Synced"}}},
		{"metadata":{"name":"metrics-server"},
		 "status":{"health":{"status":"Degraded"},"sync":{"status":"OutOfSync"},
		           "conditions":[{"type":"SyncError","message":"one or more objects failed to apply"}]}},
		{"metadata":{"name":"just-created"},"status":{}}
	]}`)
	observed, err := parseArgoApps(raw)
	if err != nil {
		t.Fatalf("parseArgoApps: %v", err)
	}
	if got := observed["addon-reloader"]; got.Health != "Healthy" || got.Sync != "Synced" {
		t.Fatalf("addon-reloader = %+v, want Healthy/Synced", got)
	}
	deg := observed["metrics-server"]
	if deg.Health != "Degraded" || deg.Sync != "OutOfSync" {
		t.Fatalf("metrics-server = %+v, want Degraded/OutOfSync", deg)
	}
	if len(deg.Conditions) != 1 || !strings.Contains(deg.Conditions[0], "SyncError") {
		t.Fatalf("metrics-server conditions = %v, want the SyncError condition", deg.Conditions)
	}
	// An app with no status yet must normalise to Unknown (mirrors health.go), so it
	// FAILS the assertion rather than being skipped or misread.
	if got := observed["just-created"]; got.Health != "Unknown" || got.Sync != "Unknown" {
		t.Fatalf("just-created = %+v, want Unknown/Unknown", got)
	}
}

func TestParseArgoApps_BadJSON(t *testing.T) {
	if _, err := parseArgoApps([]byte("kubectl exploded")); err == nil {
		t.Fatal("expected an error for non-JSON input")
	}
}

func TestEvaluateArgoApps_AllHealthy(t *testing.T) {
	observed, err := parseArgoApps(argoAppsJSON(
		[3]string{"addon-reloader", "Healthy", "Synced"},
		[3]string{"addon-sealed-secrets", "Healthy", "Synced"},
		// An UNEXPECTED degraded app must not fail the assertion — only the derived
		// expected set is required (metrics-server is not part of the honest derivation).
		[3]string{"metrics-server", "Degraded", "Synced"},
	))
	if err != nil {
		t.Fatal(err)
	}
	losers, everr := evaluateArgoApps(observed, []string{"addon-reloader", "addon-sealed-secrets"})
	if everr != nil || len(losers) != 0 {
		t.Fatalf("want pass, got losers=%v err=%v", losers, everr)
	}
}

func TestEvaluateArgoApps_DegradedFails(t *testing.T) {
	observed, _ := parseArgoApps(argoAppsJSON(
		[3]string{"addon-reloader", "Degraded", "Synced"},
		[3]string{"addon-sealed-secrets", "Healthy", "Synced"},
	))
	losers, err := evaluateArgoApps(observed, []string{"addon-reloader", "addon-sealed-secrets"})
	if err == nil {
		t.Fatal("a Degraded expected app must fail the evaluation")
	}
	if len(losers) != 1 || losers[0] != "addon-reloader" {
		t.Fatalf("losers = %v, want [addon-reloader]", losers)
	}
	if !strings.Contains(err.Error(), "health=Degraded") {
		t.Fatalf("error must report the failing health, got: %v", err)
	}
}

func TestEvaluateArgoApps_OutOfSyncFails(t *testing.T) {
	// Healthy but OutOfSync is still a failure — sync must be asserted, not just health
	// (a self-heal that never converges shows exactly this shape).
	observed, _ := parseArgoApps(argoAppsJSON([3]string{"external-dns", "Healthy", "OutOfSync"}))
	losers, err := evaluateArgoApps(observed, []string{"external-dns"})
	if err == nil || len(losers) != 1 {
		t.Fatalf("Healthy+OutOfSync must fail, got losers=%v err=%v", losers, err)
	}
}

func TestEvaluateArgoApps_MissingAppFails(t *testing.T) {
	observed, _ := parseArgoApps(argoAppsJSON([3]string{"addon-reloader", "Healthy", "Synced"}))
	losers, err := evaluateArgoApps(observed, []string{"addon-reloader", "addon-vanished"})
	if err == nil {
		t.Fatal("a missing expected app must fail the evaluation")
	}
	if len(losers) != 1 || losers[0] != "addon-vanished" {
		t.Fatalf("losers = %v, want [addon-vanished]", losers)
	}
	if !strings.Contains(err.Error(), "MISSING") {
		t.Fatalf("error must call out the missing app, got: %v", err)
	}
}

func TestEvaluateArgoApps_EmptyExpectedIsVacuous(t *testing.T) {
	observed, _ := parseArgoApps(argoAppsJSON([3]string{"addon-reloader", "Healthy", "Synced"}))
	if _, err := evaluateArgoApps(observed, nil); err == nil || !strings.Contains(err.Error(), "VACUOUS") {
		t.Fatalf("an empty expected set must be refused as vacuous, got: %v", err)
	}
}

func TestAssertArgoAppsHealthy_EmptyExpectedIsVacuous(t *testing.T) {
	// The poll wrapper must refuse an empty set BEFORE touching any cluster — this call
	// must fail immediately with no kubeconfig and no kubectl.
	err := AssertArgoAppsHealthy(context.Background(), "/nonexistent/kubeconfig", nil, time.Minute)
	if err == nil || !strings.Contains(err.Error(), "VACUOUS") {
		t.Fatalf("want an immediate vacuity error, got: %v", err)
	}
}

func TestDeriveExpectedArgoApps(t *testing.T) {
	// The T1/T2 hetzner shape: every app-shipping infra service skipped, storage-class
	// installed (no Application of its own), two seeded add-ons. The always-rendered
	// platform apps must be expected regardless.
	meta := []byte(`{
		"cluster_name": "alethia-e2t1abc",
		"infra_services": [
			{"service":"external-dns","status":"skipped","reason":"DNS is disabled"},
			{"service":"external-secrets-store","status":"skipped","reason":"no cloud secret store"},
			{"service":"ingress","status":"skipped","reason":"install ingress-nginx"},
			{"service":"storage-class","status":"installed","reason":"hcloud-volumes default"},
			{"service":"argocd-url","status":"skipped","reason":"port-forward"}
		],
		"addon_status": {
			"addon-sealed-secrets": {"health":"Progressing","sync":"Synced"},
			"addon-reloader": {"health":"Unknown","sync":"Unknown"}
		}
	}`)
	got, err := DeriveExpectedArgoApps("hetzner", meta)
	if err != nil {
		t.Fatalf("DeriveExpectedArgoApps: %v", err)
	}
	want := []string{"addon-reloader", "addon-sealed-secrets", "external-secrets-operator", "metrics-server"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("derived = %v, want %v (sorted; storage-class must NOT map to an app; always-rendered apps must be present)", got, want)
	}
}

func TestDeriveExpectedArgoApps_InstalledInfraServicesMap(t *testing.T) {
	// The AWS-flavoured shape: installed decisions map to their Application names
	// (argocd-url is whitelisted as shipping no Application of its own).
	meta := []byte(`{
		"infra_services": [
			{"service":"external-dns","status":"installed","reason":"provider aws"},
			{"service":"external-secrets-store","status":"installed","reason":"AWS Secrets Manager"},
			{"service":"ingress","status":"installed","reason":"ALB controller"},
			{"service":"argocd-url","status":"installed","reason":"ALB ingress"}
		]
	}`)
	got, err := DeriveExpectedArgoApps("aws", meta)
	if err != nil {
		t.Fatalf("DeriveExpectedArgoApps: %v", err)
	}
	want := []string{"aws-load-balancer-controller", "external-dns", "external-secrets-operator", "metrics-server"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("derived = %v, want %v", got, want)
	}
}

func TestDeriveExpectedArgoApps_XacctStore(t *testing.T) {
	// REGRESSION (#1268): externalSecretsXacctStoreDecision records an
	// "external-secrets-store-xacct" decision whenever the project selects a cross-account
	// secret manager. Before that service was mapped, this metadata hard-errored — so every
	// T2 run that enabled the connector went RED here, before reaching any xacct assertion.
	meta := []byte(`{
		"infra_services": [
			{"service":"external-secrets-store","status":"installed","reason":"AWS Secrets Manager"},
			{"service":"external-secrets-store-xacct","status":"installed","reason":"cross-account AWS Secrets Manager"}
		]
	}`)
	got, err := DeriveExpectedArgoApps("aws", meta)
	if err != nil {
		t.Fatalf("DeriveExpectedArgoApps: %v", err)
	}
	// The cross-account store ships no Application of its own — it rides the operator's.
	want := []string{"external-secrets-operator", "metrics-server"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("derived = %v, want %v", got, want)
	}
}

func TestDeriveExpectedArgoApps_LeanPathStillAssertsPlatformApps(t *testing.T) {
	// All app-shipping services skipped + no add-ons: the derivation must still expect
	// the always-rendered platform Applications (they have no render gate), so the
	// assertion can never go vacuous even without seeded add-ons.
	meta := []byte(`{
		"cluster_name": "x",
		"infra_services": [
			{"service":"external-dns","status":"skipped","reason":"r"},
			{"service":"storage-class","status":"installed","reason":"r"}
		]
	}`)
	got, err := DeriveExpectedArgoApps("hetzner", meta)
	if err != nil {
		t.Fatalf("DeriveExpectedArgoApps: %v", err)
	}
	want := []string{"external-secrets-operator", "metrics-server"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("derived = %v, want exactly the always-rendered apps %v", got, want)
	}

	// The SAME lean shape on a cloud that ships its own metrics-server (#1722): the set
	// shrinks to the operator alone. This is the half that matters — before the gate, the
	// assertion waited for a metrics-server Application that GKE/AKS/ACK deploys never
	// render, so it could only ever time out.
	gotGCP, err := DeriveExpectedArgoApps("gcp", meta)
	if err != nil {
		t.Fatalf("DeriveExpectedArgoApps(gcp): %v", err)
	}
	wantGCP := []string{"external-secrets-operator"}
	if strings.Join(gotGCP, ",") != strings.Join(wantGCP, ",") {
		t.Fatalf("derived on gcp = %v, want %v (GKE ships its own metrics-server)", gotGCP, wantGCP)
	}
}

// TestMetricsServerGateMatchesTemplate pins metricsServerProviders to the actual gate in
// infra/templates/argocd/metrics-server.yaml, by parsing the template rather than trusting
// a comment.
//
// The two live in different modules and are edited months apart, and they fail in opposite
// directions: widen the template without widening the map and the assertion stops checking
// a real app; narrow the template without narrowing the map and every run on that cloud
// waits the full ArgoCD timeout for an Application nobody rendered. Neither shows up as a
// compile error, and #1722 is precisely the second failure arriving by accident.
func TestMetricsServerGateMatchesTemplate(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Join(filepath.Dir(thisFile), "..", "..")
	path := filepath.Join(root, "infra", "templates", "argocd", "metrics-server.yaml")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}

	// The gate is the first `{{- if ... }}` action in the file. Read the providers out of
	// it rather than the whole file, so a provider named in the explanatory comment above
	// cannot be mistaken for one the gate actually admits.
	gate := regexp.MustCompile(`\{\{-?\s*if\s+([^}]*?)\s*-?\}\}`).FindSubmatch(b)
	if gate == nil {
		t.Fatalf("no {{ if }} gate found in %s — metrics-server renders unconditionally again, which is the #1722 regression", path)
	}
	found := map[string]bool{}
	for _, m := range regexp.MustCompile(`eq\s+\.Provider\s+"([a-z]+)"`).FindAllSubmatch(gate[1], -1) {
		found[string(m[1])] = true
	}
	if len(found) == 0 {
		t.Fatalf("gate %q names no provider — cannot pin it to metricsServerProviders", gate[1])
	}

	if !equalStringSets(found, metricsServerProviders) {
		t.Fatalf("metrics-server gate DRIFT:\n  template %s admits: %v\n  metricsServerProviders:  %v\nThey must match — see the comment block in the template.",
			path, sortedKeys(found), sortedKeys(metricsServerProviders))
	}
}

func equalStringSets(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if v != b[k] {
			return false
		}
	}
	return true
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		if v {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func TestDeriveExpectedArgoApps_UnknownProviderFails(t *testing.T) {
	// FAIL-CLOSED on the new parameter: the provider decides metrics-server membership,
	// so a typo'd or empty one must hard-error rather than quietly answer "not expected"
	// — that would drop a real app from the assertion on aws/hetzner and turn a genuine
	// regression into a pass.
	meta := []byte(`{"infra_services":[{"service":"external-dns","status":"skipped","reason":"r"}]}`)
	for _, bad := range []string{"", "gpc", "AWS"} {
		if _, err := DeriveExpectedArgoApps(bad, meta); err == nil || !strings.Contains(err.Error(), "unknown provider") {
			t.Fatalf("provider %q: want an unknown-provider error, got: %v", bad, err)
		}
	}
}

func TestDeriveExpectedArgoApps_UnrecognizedInstalledServiceFails(t *testing.T) {
	// FAIL-CLOSED: an "installed" decision that is in neither infraServiceArgoApps nor
	// infraServiceNoApp must hard-error — a renamed or newly added service in
	// decisions.go must widen the assertion, never silently shrink it.
	meta := []byte(`{
		"infra_services": [
			{"service":"brand-new-service","status":"installed","reason":"r"}
		]
	}`)
	if _, err := DeriveExpectedArgoApps("aws", meta); err == nil || !strings.Contains(err.Error(), "unrecognized installed infra service") {
		t.Fatalf("want a fail-closed error for an unmapped installed service, got: %v", err)
	}
	// The same unknown service SKIPPED is fine — only installed services must map.
	skipped := []byte(`{"infra_services":[{"service":"brand-new-service","status":"skipped","reason":"r"}]}`)
	if _, err := DeriveExpectedArgoApps("aws", skipped); err != nil {
		t.Fatalf("a skipped unknown service must not error, got: %v", err)
	}
}

// ssotFactVariants are the InfraFacts inputs TestInfraServiceMapsCoverDecisionsSSOT
// enumerates to reach every service InfraServiceDecisions can record.
//
// Zero-value facts are NOT sufficient. Most decisions are unconditional (the service
// name is emitted whatever the facts say, only status/reason vary), but a decision may
// be CONDITIONALLY APPENDED — externalSecretsXacctStoreDecision returns ok=false unless
// the project selected a cross-account secret manager, so it is invisible to a
// zero-value enumeration and the "stale service" check below would reject its map entry
// as unrecognized. A new conditionally-appended decision must add a variant here that
// turns it on, or this guard silently stops covering it.
var ssotFactVariants = map[string]*argocd.InfraFacts{
	"zero value": {},
	// turns on externalSecretsXacctStoreDecision (any provider — the service name is
	// the same on all of them; only the reason differs)
	"cross-account secret store selected": {
		Provider:               "aws",
		IRSAExternalSecretsArn: "arn:aws:iam::111111111111:role/eks-ue1-dev-x-secrets-operator",
		SecretsXacctRef:        "arn:aws:iam::222222222222:role/AlethiaSecretsReadRole",
	},
	// Everything ON. The two variants above leave nearly every decision "skipped", and the
	// map coverage that matters is over INSTALLED decisions — a skipped service is never
	// looked up, so a variant set that installs nothing proves nothing about the lookup.
	// Every cloud's identity/certificate/WAF fact is set at once: TestInfraServiceMapsCover-
	// DecisionsSSOT overrides Provider per iteration, and a fact belonging to another cloud is
	// simply unread by the arm that runs.
	"every installable service turned on": {
		DNSEnabled:             true,
		DomainName:             "example.com",
		DNSCredentialPresent:   true,
		AppsDestinationRepo:    "https://github.com/acme/apps",
		ACMCertificateArn:      "arn:aws:acm:us-east-1:111111111111:certificate/abc",
		WAFWebACLArn:           "arn:aws:wafv2:us-east-1:111111111111:regional/webacl/app/0c4e-1",
		IRSAExternalSecretsArn: "arn:aws:iam::111111111111:role/eks-ue1-dev-x-secrets-operator",
		// ManagedCertificate is the canvas ASK, and on gcp/azure it is now the whole certificate
		// story — both converged onto cert-manager, so there is no per-cloud certificate fact to
		// set. The solver's per-cloud identity/zone facts below are what make CertManagerEnabled
		// true on each, and without them "every installable service turned on" would quietly not
		// include the ingress on either cloud.
		ManagedCertificate:            true,
		ClusterName:                   "mock-cluster",
		GCPExternalDNSSA:              "external-dns@mock-project.iam.gserviceaccount.com",
		GCPExternalSecretsSA:          "external-secrets@mock-project.iam.gserviceaccount.com",
		GCPProjectID:                  "mock-project",
		GCPDNSZoneName:                "mock-zone",
		GCPArmorPolicy:                "alethia-nl-production-armor-policy",
		AzureExternalDNSClient:        "11111111-2222-3333-4444-555555555555",
		AzureExternalSecretsClient:    "66666666-7777-8888-9999-000000000000",
		AzureKeyVaultURI:              "https://mock-kv.vault.azure.net/",
		AzureResourceGroup:            "rg-mock",
		AzureSubscriptionID:           "99999999-8888-7777-6666-555555555555",
		AzureTenantID:                 "12121212-3434-5656-7878-909090909090",
		AzureIngressClient:            "22222222-3333-4444-5555-666666666666",
		AzureAppGatewayName:           "agw-mock",
		AlibabaExternalSecretsRoleArn: "acs:ram::111111111111:role/alethia-eso",
	},
}

func TestInfraServiceMapsCoverDecisionsSSOT(t *testing.T) {
	// Tie infraServiceArgoApps + infraServiceNoApp to the REAL decision list: every service
	// InfraServiceDecisions can record must resolve, ON EVERY CLOUD, to exactly one of "this
	// Application" or "no Application here" — and the maps must contain nothing else, so a
	// rename/add/remove in decisions.go breaks this test instead of silently shrinking the
	// assertion.
	//
	// The enumeration crosses the variants with every provider rather than trusting each
	// variant's own Provider field. Both maps are provider-keyed now — "ingress" is an
	// Application on AWS and nothing at all on GKE — so a service-level check would pass while
	// a cloud in between resolved to neither, which is the exact hole that lets a run wait out
	// the ArgoCD timeout on an app nobody rendered.
	seen := map[string]struct{}{}
	for _, provider := range t2AllProviders() {
		for name, base := range ssotFactVariants {
			facts := *base
			facts.Provider = provider
			for _, d := range argocd.InfraServiceDecisions(&facts) {
				seen[d.Service] = struct{}{}
				// The exactly-one rule binds where the derivation actually LOOKS: on an
				// installed decision. A skipped one is `continue`d before either map is
				// consulted, and demanding an entry for it would force every lane to claim
				// something about a cloud it does not ship on.
				if d.Status != "installed" {
					continue
				}
				_, hasApp := argoAppForInfraService(provider, d.Service)
				noApp := infraServiceShipsNoApp(provider, d.Service)
				if hasApp == noApp { // neither, or both
					t.Errorf("service %q on provider %q (facts: %s) must resolve to exactly one of an Application or infraServiceNoApp (hasApp=%v noApp=%v)", d.Service, provider, name, hasApp, noApp)
				}
			}
		}
	}
	// Independently of any cloud: a service the decisions can record must be KNOWN to at least
	// one of the maps. Without this, a brand-new service that happens never to be "installed"
	// in the variants above would slip through the per-cloud loop entirely and only be caught
	// on a live run.
	for s := range seen {
		_, hasApp := infraServiceArgoApps[s]
		_, noApp := infraServiceNoApp[s]
		if !hasApp && !noApp {
			t.Errorf("service %q is recorded by InfraServiceDecisions but appears in neither infraServiceArgoApps nor infraServiceNoApp", s)
		}
	}
	for s := range infraServiceArgoApps {
		if _, ok := seen[s]; !ok {
			t.Errorf("infraServiceArgoApps has stale service %q — not recorded by InfraServiceDecisions", s)
		}
	}
	for s := range infraServiceNoApp {
		if _, ok := seen[s]; !ok {
			t.Errorf("infraServiceNoApp has stale service %q — not recorded by InfraServiceDecisions", s)
		}
	}
}

func TestSeedAddOnsPinnedToCatalog(t *testing.T) {
	// The seeded add-ons must be EXACTLY what the console emits for the same ids.
	//
	// This used to string-grep apps/console/lib/addons/catalog.ts for four scalar fields
	// (version/chartRepo/chart/namespace) against a hand-written Go literal. That pin is what let
	// #643 through: it gave reloader real knob defaults, and `values` was not in the four-field list,
	// so the literal kept emitting `{}` and this test stayed green for three weeks (#1965). A pin
	// that silently omits the field that drifted is worse than no pin, because it reads as coverage.
	//
	// Now both sides come from the generated fixture, so the comparison can be TOTAL — every field of
	// the install spec, including `values`, with no hand-maintained field list to fall out of date.
	// The fixture↔catalog.ts edge is held by the console's own catalog-export.test.ts, which
	// regenerates in-memory and deep-equals; this asserts the Go seed sits on that same artifact.
	catalog, err := AllCatalogAddOns()
	if err != nil {
		t.Fatalf("load generated add-on catalog: %v", err)
	}
	byID := make(map[string]types.AddOnInstall, len(catalog))
	for _, a := range catalog {
		byID[a.ID] = a
	}
	for _, a := range seedAddOns() {
		want, ok := byID[a.ID]
		if !ok {
			t.Errorf("seeded add-on %q is not in the generated catalog fixture — regenerate: pnpm -F console export:addon-catalog", a.ID)
			continue
		}
		if !reflect.DeepEqual(a, want) {
			t.Errorf("seeded add-on %q diverges from the console's install spec.\n seeded: %+v\ncatalog: %+v\n"+
				"the seed should DERIVE from the generated fixture (CatalogAddOn), never restate it", a.ID, a, want)
		}
	}
}

func TestDeriveExpectedArgoApps_EmptyMetadataFails(t *testing.T) {
	if _, err := DeriveExpectedArgoApps("aws", nil); err == nil {
		t.Fatal("want an error for empty execution_metadata")
	}
	if _, err := DeriveExpectedArgoApps("aws", []byte("{not json")); err == nil {
		t.Fatal("want an error for malformed execution_metadata")
	}
}

// ── the provider-keyed infraServiceArgoApps map ──────────────────────────────────

// t2AllProviders lists the provider keys the derivation accepts, sorted, so the guards below
// enumerate the SAME set DeriveExpectedArgoApps will refuse to answer for.
func t2AllProviders() []string {
	out := make([]string, 0, len(t2ProviderTable))
	for k := range t2ProviderTable {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Every cloud whose "ingress" decision is INSTALLED must either name the Application it renders
// or be recorded as shipping none ON THAT CLOUD. This is the metricsServerProviders lesson
// (#1722) applied to the seam the per-cloud ingress lanes land on: the decision lives in
// packages/core, the Application name lives in this module, they are edited in different PRs,
// and a cloud that installs a controller nobody named here would make every run on that cloud
// wait out the full ArgoCD timeout for an app that was never rendered.
//
// "Or ships none" is not a loophole — it is the GKE case, where the Ingress controller runs in
// the Google-managed control plane and Alethia installs nothing. Saying so EXPLICITLY, per
// cloud, is what keeps it from becoming one: a cloud that is in neither map still fails.
//
// It reads the REAL decision (not a copy of the table), so a lane cannot satisfy it by
// editing a list.
func TestInstalledIngressDecisionsNameAnApplication(t *testing.T) {
	for _, provider := range t2AllProviders() {
		facts := &argocd.InfraFacts{Provider: provider}
		for _, d := range argocd.InfraServiceDecisions(facts) {
			if d.Service != "ingress" || d.Status != "installed" {
				continue
			}
			app, ok := argoAppForInfraService(provider, "ingress")
			if !ok {
				if !infraServiceShipsNoApp(provider, "ingress") {
					t.Errorf("provider %q installs an ingress controller (%s) but neither infraServiceArgoApps[\"ingress\"] nor infraServiceNoApp[\"ingress\"] has an entry for it — name the Application it renders, or record that it renders none, or the T2 run waits out the full ArgoCD timeout for an app nobody created", provider, d.Reason)
				}
				continue
			}
			if app == "" {
				t.Errorf("provider %q resolves to an EMPTY ingress Application name", provider)
			}
		}
	}
	// The two entries that exist today, asserted explicitly so a bad refactor that made the loop
	// above vacuous (e.g. every decision suddenly "skipped") still fails.
	if app, ok := argoAppForInfraService("aws", "ingress"); !ok || app != "aws-load-balancer-controller" {
		t.Errorf("argoAppForInfraService(aws, ingress) = (%q, %v), want the ALB controller", app, ok)
	}
	if !infraServiceShipsNoApp("gcp", "ingress") {
		t.Error("gcp's built-in GKE Ingress must be recorded in infraServiceNoApp — it installs no Application")
	}
	// …and the no-app entry must NOT leak: it is keyed on gcp alone, so a lane that ships an
	// Azure or Alibaba controller is still forced to name it.
	for _, provider := range []string{"aws", "azure", "alibaba", "hetzner"} {
		if infraServiceShipsNoApp(provider, "ingress") {
			t.Errorf("provider %q inherited gcp's \"ingress ships no Application\" entry — the no-app whitelist must stay per-cloud", provider)
		}
	}
}

// The provider-keyed lookup must fall back to the anyProvider entry for cloud-agnostic
// services, and must NOT leak a per-cloud entry to another cloud.
func TestArgoAppForInfraService_ProviderResolution(t *testing.T) {
	// The clouds that ship their own ingress controller, and the Application each renders. The
	// point of the loop below is that a cloud gets ITS OWN entry or nothing at all — the ALB
	// controller must never resolve on azure, nor AGIC on aws.
	ingressApps := map[string]string{
		"aws":   "aws-load-balancer-controller",
		"azure": "ingress-azure",
	}
	for _, provider := range t2AllProviders() {
		if app, ok := argoAppForInfraService(provider, "external-dns"); !ok || app != "external-dns" {
			t.Errorf("%s: cloud-agnostic service did not fall back to the anyProvider entry: (%q, %v)", provider, app, ok)
		}
		app, ok := argoAppForInfraService(provider, "ingress")
		want, hasController := ingressApps[provider]
		switch {
		case hasController && (!ok || app != want):
			t.Errorf("%s: ingress resolved to (%q, %v), want %q", provider, app, ok, want)
		case !hasController && ok:
			t.Errorf("%s: resolved another cloud's ingress Application %q — a per-cloud entry must not leak across clouds", provider, app)
		}
	}
	if _, ok := argoAppForInfraService("aws", "no-such-service"); ok {
		t.Error("an unknown service must not resolve to an Application")
	}
}

// FAIL-CLOSED across the provider dimension: an "installed" ingress on a cloud with no entry
// is a hard derivation error, exactly like an unknown service. This is the guard that stops a
// lane shipping a controller whose Application the assertion never checks.
func TestDeriveExpectedArgoApps_InstalledIngressOnUnmappedCloudFails(t *testing.T) {
	meta := []byte(`{"infra_services":[{"service":"ingress","status":"installed","reason":"a controller this test invented"}]}`)
	// ⚠️ THE FIXTURE CLOUD MOVES EVERY TIME AN INGRESS LANE LANDS, and it has moved twice: gcp →
	// azure (gcp became mapped as "installs no Application", its controller being in the managed
	// control plane) → alibaba (azure became mapped to the AGIC Application). Using a MAPPED cloud
	// here does not fail the test — it makes it pass for the wrong reason, which is worse.
	//
	// alibaba is the durable choice rather than the next one along: it is unmapped ON PURPOSE and
	// expected to stay that way, because ACK ships its own nginx-ingress-controller and a second
	// one from Alethia would be the #1722 ownership collision. If a lane ever does map it, pick
	// another genuinely-unmapped cloud — never one that merely has not landed yet.
	if _, err := DeriveExpectedArgoApps("alibaba", meta); err == nil {
		t.Fatal("expected a hard error for an installed ingress on a cloud in neither infraServiceArgoApps nor infraServiceNoApp")
	}
	// gcp, in contrast, derives CLEANLY and adds nothing — the no-app path, pinned so a future
	// edit cannot turn it back into an error or into a phantom Application.
	gcpApps, gcpErr := DeriveExpectedArgoApps("gcp", meta)
	if gcpErr != nil {
		t.Fatalf("gcp: an installed ingress that ships no Application must derive cleanly: %v", gcpErr)
	}
	for _, a := range gcpApps {
		if strings.Contains(a, "ingress") || a == "" {
			t.Errorf("gcp expected set %v contains an ingress Application — GKE's controller renders none", gcpApps)
		}
	}
	// The same record on AWS resolves, so the failure above is about the PROVIDER, not the
	// service name — otherwise this guard would pass for the wrong reason.
	apps, err := DeriveExpectedArgoApps("aws", meta)
	if err != nil {
		t.Fatalf("aws: %v", err)
	}
	if !containsString(apps, "aws-load-balancer-controller") {
		t.Errorf("aws expected set = %v, want the ALB controller", apps)
	}
}

// The WAF attach is an ANNOTATION on the ArgoCD ingress, not an Application — an installed
// "waf" decision must derive cleanly and add nothing to the expected set.
func TestDeriveExpectedArgoApps_WAFShipsNoApplication(t *testing.T) {
	meta := []byte(`{"infra_services":[{"service":"waf","status":"installed","reason":"attached"}],"addon_status":{"addon-reloader":{}}}`)
	apps, err := DeriveExpectedArgoApps("aws", meta)
	if err != nil {
		t.Fatalf("DeriveExpectedArgoApps: %v", err)
	}
	for _, a := range apps {
		if strings.Contains(a, "waf") {
			t.Errorf("expected set %v contains a WAF Application — the attach is an annotation, it renders none", apps)
		}
	}
}

// containsString lives in maxconfig.go: the in-cluster carriage verdict needs it in NON-test code
// (it checks an ArgoCD Application name against the converged set), so the test-local copy that used
// to sit here would now be a redeclaration.

// The AGIC Application name is a THREE-WAY constant: the template's `metadata.name`, the
// infraServiceArgoApps entry this assertion derives the expected set from, and — through
// `fullnameOverride` — the ServiceAccount name the azure template's federated identity credential
// trusts. A rename in one place and not the others produces either a run that waits out the whole
// ArgoCD timeout for an Application nobody rendered (the #1722 shape, one dimension over) or a
// controller whose token exchange silently fails. Parsed from the template, like
// TestMetricsServerGateMatchesTemplate, rather than restated.
func TestAGICApplicationNameMatchesTemplate(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Join(filepath.Dir(thisFile), "..", "..")
	path := filepath.Join(root, "infra", "templates", "argocd", "azure-application-gateway-ingress.yaml")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}

	name := regexp.MustCompile(`(?m)^metadata:\n\s+name:\s+(\S+)`).FindSubmatch(b)
	if name == nil {
		t.Fatalf("no Application metadata.name found in %s", path)
	}
	want, ok := argoAppForInfraService("azure", "ingress")
	if !ok {
		t.Fatalf("azure has no infraServiceArgoApps entry for \"ingress\" — the decision would resolve to nothing and hard-error the derivation")
	}
	if got := string(name[1]); got != want {
		t.Fatalf("AGIC Application name DRIFT:\n  template %s renders: %q\n  infraServiceArgoApps[\"ingress\"][\"azure\"]: %q", path, got, want)
	}

	// fullnameOverride is what pins the chart's ServiceAccount name; the azure template's
	// federated identity credential trusts `system:serviceaccount:agic:<that name>`.
	if !regexp.MustCompile(`fullnameOverride:\s+` + regexp.QuoteMeta(want)).Match(b) {
		t.Errorf("%s must set fullnameOverride: %s — without it the chart derives its ServiceAccount name from the Helm release name and the federated credential's subject no longer matches", path, want)
	}
	if !regexp.MustCompile(`namespace:\s+agic`).Match(b) {
		t.Errorf("%s must deploy into the `agic` namespace named by the federated credential's subject", path)
	}

	// The gate must be azure-only. A missing provider term would render the Application on every
	// cloud, where the chart has no gateway to reconcile onto.
	gate := regexp.MustCompile(`\{\{-?\s*if\s+([^}]*?)\s*-?\}\}`).FindSubmatch(b)
	if gate == nil {
		t.Fatalf("no {{ if }} gate found in %s — AGIC would render on every cloud", path)
	}
	if !regexp.MustCompile(`eq\s+\.Provider\s+"azure"`).Match(gate[1]) {
		t.Errorf("AGIC gate %q must be azure-only", gate[1])
	}
}
