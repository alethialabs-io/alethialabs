// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/categories"
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func boolPtr(b bool) *bool { return &b }

func TestHasManifests(t *testing.T) {
	// Empty repo (or README-only) → no manifests → safe to scaffold.
	empty := t.TempDir()
	if err := os.WriteFile(filepath.Join(empty, "README.md"), []byte("# hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	if hasManifests(empty) {
		t.Errorf("a README-only repo should NOT count as having manifests")
	}

	// A repo with a k8s YAML → bring-your-own → must NOT be clobbered.
	byo := t.TempDir()
	if err := os.WriteFile(filepath.Join(byo, "deploy.yaml"), []byte("kind: Deployment"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !hasManifests(byo) {
		t.Errorf("a repo with a .yaml must count as having manifests (don't clobber BYO)")
	}
}

// TestWriteBindingExternalSecrets locks the W3 credential wiring (#630): a service's credential
// binding writes an ExternalSecret referencing the per-cloud store + the provisioned secret and
// targeting the SAME per-service Secret name the workload's secretKeyRef reads (BindingSecretName).
// A non-secret facet (endpoint) produces no ExternalSecret.
func TestWriteBindingExternalSecrets(t *testing.T) {
	dir := t.TempDir()
	vc := &types.ProjectConfig{
		Provider: "aws",
		Services: []types.ProjectServiceConfig{{
			Name: "api",
			Bindings: []types.ServiceBinding{{
				Target: types.ServiceBindingTarget{Kind: "database", Name: "orders-db"},
				Inject: []types.ServiceBindingInjection{
					{Env: "DATABASE_HOST", From: "endpoint"},     // non-secret → no ExternalSecret
					{Env: "DATABASE_PASSWORD", From: "password"}, // credential → ExternalSecret
				},
			}},
		}},
	}
	outputs := map[string]string{"rds_master_credentials_secret_name": "alethia/proj/rds-maindb"}

	skips, n, err := writeBindingExternalSecrets(dir, vc, outputs, false, nil, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("expected 1 ExternalSecret written, got %d", n)
	}
	if len(skips) != 0 {
		t.Fatalf("a satisfiable facet should not skip, got %v", skips)
	}

	secretName := manifests.BindingSecretName("api", types.ServiceBindingTarget{Kind: "database", Name: "orders-db"})
	b, err := os.ReadFile(filepath.Join(dir, secretName+"-externalsecret.yaml"))
	if err != nil {
		t.Fatalf("ExternalSecret file not written: %v", err)
	}
	y := string(b)
	for _, want := range []string{
		"kind: ExternalSecret",
		"name: " + secretName,          // target Secret == the renderer's secretKeyRef.name
		"secretstore-aws",              // the per-cloud ClusterSecretStore
		"key: alethia/proj/rds-maindb", // remoteRef → the provisioned master-credentials secret
		"secretKey: password",          // the credential facet
	} {
		if !strings.Contains(y, want) {
			t.Errorf("ExternalSecret missing %q:\n%s", want, y)
		}
	}
}

// TestWriteBindingExternalSecrets_BYOIaC locks #687: a credential binding to a BYO-IaC target
// materializes its ExternalSecret from the CUSTOMER module's declared credential-secret output (not
// the platform template key), so the runner's ExternalSecret RemoteKey matches the resolveBindings
// secretKeyRef. A BYO-IaC target that declared NO credential-secret output is reported unsatisfiable
// and writes nothing (never points the workload at a Secret that won't exist).
func TestWriteBindingExternalSecrets_BYOIaC(t *testing.T) {
	byo := types.ServiceBindingTarget{
		Kind:    "database",
		Name:    "primary",
		Address: "module.db.aws_db_instance.main",
		OutputKeys: &types.ServiceBindingOutputKeys{
			Endpoint:         "db_endpoint",
			CredentialSecret: "db_master_secret",
		},
	}
	vc := &types.ProjectConfig{
		Provider: "aws",
		Services: []types.ProjectServiceConfig{{
			Name: "api",
			Bindings: []types.ServiceBinding{{
				Target: byo,
				Inject: []types.ServiceBindingInjection{{Env: "DATABASE_USER", From: "username"}},
			}},
		}},
	}
	// Customer-named output — NOT rds_master_credentials_secret_name.
	dir := t.TempDir()
	skips, n, err := writeBindingExternalSecrets(dir, vc, map[string]string{"db_master_secret": "acme/db/master"}, false, nil, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || len(skips) != 0 {
		t.Fatalf("satisfiable BYO-IaC credential → 1 ExternalSecret, no skips; got n=%d skips=%v", n, skips)
	}
	secretName := manifests.BindingSecretName("api", byo)
	b, err := os.ReadFile(filepath.Join(dir, secretName+"-externalsecret.yaml"))
	if err != nil {
		t.Fatalf("ExternalSecret not written: %v", err)
	}
	if y := string(b); !strings.Contains(y, "key: acme/db/master") {
		t.Errorf("ExternalSecret must reference the CUSTOMER RemoteKey acme/db/master:\n%s", y)
	}

	// A BYO-IaC target with no declared credential-secret output → unsatisfiable, nothing written.
	byoNoCred := byo
	byoNoCred.OutputKeys = &types.ServiceBindingOutputKeys{Endpoint: "db_endpoint"}
	vc.Services[0].Bindings[0].Target = byoNoCred
	skips2, n2, err := writeBindingExternalSecrets(t.TempDir(), vc, map[string]string{"db_endpoint": "x"}, false, nil, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if n2 != 0 || len(skips2) == 0 {
		t.Errorf("BYO-IaC credential with no secret output → 0 written + reported; got n=%d skips=%v", n2, skips2)
	}
}

// TestWriteBindingExternalSecrets_Secret locks the secret-kind binding path (#1207): a service bound
// to a project secret backed by a pluggable SaaS store writes an ExternalSecret pointing at
// secretstore-<slug>; a secret with no readable store (native/excluded provider) is fail-closed
// (nothing written, reported) — in lock-step with resolveBindings.
func TestWriteBindingExternalSecrets_Secret(t *testing.T) {
	target := types.ServiceBindingTarget{Kind: "secret", Name: "stripe-key"}
	vc := &types.ProjectConfig{
		Provider: "hetzner", // cloud-agnostic: the SaaS store works even with no native store
		Secrets:  []types.ProjectSecretConfig{{Name: "stripe-key", Provider: "vault"}},
		Services: []types.ProjectServiceConfig{{
			Name: "api",
			Bindings: []types.ServiceBinding{{
				Target: target,
				Inject: []types.ServiceBindingInjection{{Env: "STRIPE_KEY", From: "value"}},
			}},
		}},
	}
	stores := secretStoreRefs(vc, saasFacts("vault"))
	if stores["stripe-key"].StoreName != "secretstore-vault" || stores["stripe-key"].ValueProperty != "value" {
		t.Fatalf("secretStoreRefs wrong: %+v", stores)
	}
	dir := t.TempDir()
	skips, n, err := writeBindingExternalSecrets(dir, vc, map[string]string{}, false, stores, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || len(skips) != 0 {
		t.Fatalf("vault-backed secret binding → 1 ExternalSecret, no skips; got n=%d skips=%v", n, skips)
	}
	b, err := os.ReadFile(filepath.Join(dir, manifests.BindingSecretName("api", target)+"-externalsecret.yaml"))
	if err != nil {
		t.Fatalf("ExternalSecret not written: %v", err)
	}
	if y := string(b); !strings.Contains(y, "name: secretstore-vault") || !strings.Contains(y, "key: stripe-key") || !strings.Contains(y, "property: value") {
		t.Errorf("secret ExternalSecret wrong:\n%s", y)
	}

	// A native-provider secret has no readable store → fail-closed (nothing written, reported).
	vc.Secrets[0].Provider = ""
	skips2, n2, err := writeBindingExternalSecrets(t.TempDir(), vc, map[string]string{}, false, secretStoreRefs(vc, saasFacts("vault")), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if n2 != 0 || len(skips2) == 0 {
		t.Errorf("native secret → 0 written + reported; got n=%d skips=%v", n2, skips2)
	}
}

// saasFacts are facts whose rendered SaaS store is `slug` — i.e. `slug` is the project's DOMINANT
// secrets provider, the only one externalSecretsStoreTemplate emits for this deploy.
func saasFacts(slug string) *argocd.InfraFacts {
	return &argocd.InfraFacts{
		SecretsSaaS: &categories.SecretsSaaSStore{Slug: slug, StoreName: "secretstore-" + slug},
	}
}

// TestSecretStoreRefs_Classification: only first-class runtime-read stores (vault/doppler/generic) get
// an entry, and only in the deploy that actually rendered THAT store; doppler is flat (no property);
// native/excluded providers are absent (fail-closed).
func TestSecretStoreRefs_Classification(t *testing.T) {
	vc := &types.ProjectConfig{Secrets: []types.ProjectSecretConfig{
		{Name: "a", Provider: "vault"},
		{Name: "b", Provider: "doppler"},
		{Name: "c", Provider: "generic"},
		{Name: "d", Provider: "onepassword"}, // runtime-read excluded on ESO 0.9.12
		{Name: "e", Provider: ""},            // native
	}}
	// One dominant store per deploy, so each SaaS row resolves only in the deploy that rendered ITS
	// store. Asserting all three at once — as this test used to — described a project that cannot
	// exist, and was what let the non-dominant bug through.
	if refs := secretStoreRefs(vc, saasFacts("vault")); refs["a"] != (manifests.SecretStoreRef{StoreName: "secretstore-vault", ValueProperty: "value"}) {
		t.Errorf("vault ref wrong: %+v", refs["a"])
	}
	if refs := secretStoreRefs(vc, saasFacts("doppler")); refs["b"] != (manifests.SecretStoreRef{StoreName: "secretstore-doppler", ValueProperty: ""}) {
		t.Errorf("doppler ref must be flat (no property): %+v", refs["b"])
	}
	refs := secretStoreRefs(vc, saasFacts("generic"))
	if refs["c"].StoreName != "secretstore-generic" || refs["c"].ValueProperty != "value" {
		t.Errorf("generic ref wrong: %+v", refs["c"])
	}
	if _, ok := refs["d"]; ok {
		t.Error("onepassword (excluded runtime-read) must have no store ref")
	}
	if _, ok := refs["e"]; ok {
		t.Error("native secret must have no store ref")
	}
}

// REGRESSION (#1409): a SaaS row that is NOT the dominant provider must get no ref.
//
// dominantProvider picks ONE slug for the project and only that store is rendered, but this function
// used to key each entry off the row's own provider — so a doppler secret in a vault-dominant project
// got `secretstore-doppler`, and both binding lanes then emitted an ExternalSecret plus a
// secretKeyRef against a ClusterSecretStore that was never applied. The pod waits forever on a Secret
// nothing will create, with no error at deploy time.
func TestSecretStoreRefs_NonDominantSaaSAbsent(t *testing.T) {
	vc := &types.ProjectConfig{Secrets: []types.ProjectSecretConfig{
		{Name: "a", Provider: "vault"},
		{Name: "b", Provider: "doppler"},
	}}
	refs := secretStoreRefs(vc, saasFacts("vault"))
	if refs["a"].StoreName != "secretstore-vault" {
		t.Errorf("the dominant SaaS secret must resolve: %+v", refs["a"])
	}
	if ref, ok := refs["b"]; ok {
		t.Errorf("a non-dominant SaaS secret must have NO ref, got %+v — that ExternalSecret would point at a store this deploy never applied", ref)
	}
	// And with nothing rendered at all, no SaaS row resolves. nil facts is the same case: a caller
	// with no post-apply facts cannot know what shipped, so it must not guess.
	for _, f := range []*argocd.InfraFacts{{}, nil} {
		if refs := secretStoreRefs(vc, f); len(refs) != 0 {
			t.Errorf("no rendered SaaS store ⇒ no refs, got %+v", refs)
		}
	}
}

// TestWriteBindingExternalSecrets_KeylessSkips locks the keyless skip (#722): when the flag is on and
// the bound database has iam_auth, NO ExternalSecret is written (the renderer wired an auth-proxy
// sidecar instead) — in lock-step with FromServices. Flag off → the password ExternalSecret is
// written as before (no regression).
func TestWriteBindingExternalSecrets_KeylessSkips(t *testing.T) {
	vc := &types.ProjectConfig{
		Provider:  "gcp",
		Databases: []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(true)}},
		Services: []types.ProjectServiceConfig{{
			Name: "api",
			Bindings: []types.ServiceBinding{{
				Target: types.ServiceBindingTarget{Kind: "database", Name: "orders-db"},
				Inject: []types.ServiceBindingInjection{{Env: "DATABASE_PASSWORD", From: "password"}},
			}},
		}},
	}

	// Flag ON + iam_auth db → skipped (no ExternalSecret).
	_, n, err := writeBindingExternalSecrets(t.TempDir(), vc, map[string]string{}, true, nil, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("keyless binding must write no ExternalSecret, got %d", n)
	}

	// Flag OFF → the password path still runs (here fail-closed: no master-secret output on GCP, so it
	// reports a skip rather than writing — but crucially it does NOT skip via the keyless branch).
	skips, n2, err := writeBindingExternalSecrets(t.TempDir(), vc, map[string]string{}, false, nil, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if n2 != 0 || len(skips) == 0 {
		t.Errorf("flag off → password path (fail-closed skip reported), got n=%d skips=%v", n2, skips)
	}
}

// TestGenerateAppManifests_ReturnsWarnings locks #717: generateAppManifests returns the
// manifest-generation warnings (here an unbuilt repo-sourced service, which FromServices skips) so
// the caller can attach them to GitopsStatus.ManifestWarnings. The all-skipped path returns before
// any git I/O, so this needs no repo.
func TestGenerateAppManifests_ReturnsWarnings(t *testing.T) {
	vc := &types.ProjectConfig{
		Repositories: types.ProjectRepositoriesConfig{
			AppsDestinationRepo: "https://example.com/apps.git",
		},
		Services: []types.ProjectServiceConfig{{
			Name:   "api",
			Type:   "deployment",
			Source: types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/api"},
			// No ResolvedImage → unbuilt → FromServices skips it → apps empty → returns before git.
		}},
	}
	warnings, err := generateAppManifests(context.Background(), vc, map[string]interface{}{}, "token", nil, io.Discard, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 1 {
		t.Fatalf("expected 1 warning (unbuilt service), got %v", warnings)
	}
	if !strings.Contains(warnings[0], "not built") {
		t.Errorf("warning should name the unbuilt service, got %q", warnings[0])
	}
}

// TestWriteBindingExternalSecrets_Unsatisfiable reports (never silently drops) a credential facet
// that can't be materialized — here Hetzner, which has no ClusterSecretStore.
func TestWriteBindingExternalSecrets_Unsatisfiable(t *testing.T) {
	dir := t.TempDir()
	vc := &types.ProjectConfig{
		Provider: "hetzner",
		Services: []types.ProjectServiceConfig{{
			Name: "api",
			Bindings: []types.ServiceBinding{{
				Target: types.ServiceBindingTarget{Kind: "database", Name: "db"},
				Inject: []types.ServiceBindingInjection{{Env: "PW", From: "password"}},
			}},
		}},
	}
	var log strings.Builder
	skips, n, err := writeBindingExternalSecrets(dir, vc, map[string]string{}, false, nil, &log)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("no store for hetzner → 0 written, got %d", n)
	}
	if !strings.Contains(log.String(), "skipped") {
		t.Errorf("an unsatisfiable facet must be reported, got: %q", log.String())
	}
	// The reason is also RETURNED (for GitopsStatus.ManifestWarnings), not only logged.
	if len(skips) == 0 {
		t.Errorf("an unsatisfiable facet must be returned as a skip reason, got none")
	}
}

// xacctFacts are AWS facts whose cross-account gate is OPEN (both the cluster's own ESO identity and
// the target are present), i.e. the deploy really did apply secretstore-aws-xacct.
func xacctFacts() *argocd.InfraFacts {
	return &argocd.InfraFacts{
		Provider:               "aws",
		IRSAExternalSecretsArn: "arn:aws:iam::111111111111:role/eso",
		SecretsXacctRef:        "arn:aws:iam::222222222222:role/AlethiaSecretsReadRole",
		SecretsXacctRegion:     "us-east-1",
		SecretsXacctSlug:       "aws-sm-xacct",
	}
}

// A project secret backed by the DOMINANT cross-account manager resolves to that cloud's *-xacct
// store, with NO remoteRef property: the whole remote value IS the secret on all four clouds.
func TestSecretStoreRefs_Xacct(t *testing.T) {
	vc := &types.ProjectConfig{Provider: "aws", Secrets: []types.ProjectSecretConfig{
		{Name: "stripe-key", Provider: "aws-sm-xacct"},
		{Name: "sendgrid-key", Provider: "aws-sm-xacct"},
	}}
	refs := secretStoreRefs(vc, xacctFacts())
	for _, n := range []string{"stripe-key", "sendgrid-key"} {
		if refs[n] != (manifests.SecretStoreRef{StoreName: "secretstore-aws-xacct"}) {
			t.Errorf("%s ref wrong: %+v (want secretstore-aws-xacct with no property)", n, refs[n])
		}
	}
}

// The cross-account store is DOMINANT per project — only ONE renders. A secret selecting a different
// *-xacct slug has no store of its own, so it must be ABSENT rather than silently read the dominant
// account's target (a cross-account read of the wrong account).
func TestSecretStoreRefs_XacctNonDominantSlugAbsent(t *testing.T) {
	vc := &types.ProjectConfig{Provider: "aws", Secrets: []types.ProjectSecretConfig{
		{Name: "a", Provider: "aws-sm-xacct"},
		{Name: "b", Provider: "gcp-sm-xacct"}, // not the dominant slug
	}}
	refs := secretStoreRefs(vc, xacctFacts())
	if refs["a"].StoreName != "secretstore-aws-xacct" {
		t.Errorf("the dominant-slug secret must resolve: %+v", refs["a"])
	}
	if _, ok := refs["b"]; ok {
		t.Errorf("a non-dominant *-xacct slug must have NO store ref, got %+v", refs["b"])
	}
}

// Fail-closed: the store is applied by the runner, so when the render gate is CLOSED (here: the
// cluster's own IRSA fact is missing) nothing was applied and no secret may resolve.
func TestSecretStoreRefs_XacctFailClosedWhenGateClosed(t *testing.T) {
	vc := &types.ProjectConfig{Provider: "aws", Secrets: []types.ProjectSecretConfig{
		{Name: "a", Provider: "aws-sm-xacct"},
	}}
	f := xacctFacts()
	f.IRSAExternalSecretsArn = "" // gate closed — the store never rendered
	if refs := secretStoreRefs(vc, f); len(refs) != 0 {
		t.Errorf("gate closed ⇒ no refs, got %+v", refs)
	}
	// nil facts (a caller with no post-apply facts) is equally fail-closed.
	if refs := secretStoreRefs(vc, nil); len(refs) != 0 {
		t.Errorf("nil facts ⇒ no refs, got %+v", refs)
	}
}

// The most dangerous failure mode: falling back to the NATIVE store. That would silently read the
// CLUSTER's own account instead of the customer's target account — same secret name, wrong tenant.
func TestSecretStoreRefs_XacctNeverFallsBackToNative(t *testing.T) {
	vc := &types.ProjectConfig{Provider: "aws", Secrets: []types.ProjectSecretConfig{
		{Name: "a", Provider: "aws-sm-xacct"},
		{Name: "b", Provider: "gcp-sm-xacct"},
	}}
	native := manifests.StoreNameFor("aws")
	if native == "" {
		t.Fatal("expected a native store name for aws")
	}
	for _, f := range []*argocd.InfraFacts{xacctFacts(), nil, {Provider: "aws", SecretsXacctSlug: "aws-sm-xacct"}} {
		for name, ref := range secretStoreRefs(vc, f) {
			if ref.StoreName == native {
				t.Errorf("%s resolved to the NATIVE store %q — a cross-account secret must never fall back to the cluster's own account", name, native)
			}
		}
	}
}

// #1306: every *-xacct store denies namespaces labelled alethia.io/placement=namespace, so a PLACED
// tenant must never be handed an ExternalSecret against a foreign-account store — it could not sync
// anyway, and offering it would leak the target's existence into a shared Fabric.
func TestSecretStoreRefs_XacctSkippedOnPlacedNamespace(t *testing.T) {
	vc := &types.ProjectConfig{
		Provider:      "aws",
		PlacementMode: types.PlacementModeNamespace,
		Secrets:       []types.ProjectSecretConfig{{Name: "a", Provider: "aws-sm-xacct"}},
	}
	if refs := secretStoreRefs(vc, xacctFacts()); len(refs) != 0 {
		t.Errorf("placed tenant ⇒ no cross-account refs, got %+v", refs)
	}
	// ...but a SaaS store is unaffected: it is in-cluster and carries no such condition. Facts must
	// carry the rendered SaaS store, since that is now what a SaaS row is gated on.
	vc.Secrets = []types.ProjectSecretConfig{{Name: "a", Provider: "vault"}}
	placedSaaS := xacctFacts()
	placedSaaS.SecretsSaaS = &categories.SecretsSaaSStore{Slug: "vault", StoreName: "secretstore-vault"}
	if refs := secretStoreRefs(vc, placedSaaS); refs["a"].StoreName != "secretstore-vault" {
		t.Errorf("a SaaS store must still resolve for a placed tenant, got %+v", refs["a"])
	}
}

// End-to-end through the writer: a secret-kind binding on a cross-account secret writes an
// ExternalSecret naming the *-xacct store, keyed by the project secret's own name, with NO
// `property:` line (the conditional-property template is what makes this renderable).
func TestWriteBindingExternalSecrets_Xacct(t *testing.T) {
	target := types.ServiceBindingTarget{Kind: "secret", Name: "stripe-key"}
	vc := &types.ProjectConfig{
		Provider: "aws",
		Secrets:  []types.ProjectSecretConfig{{Name: "stripe-key", Provider: "aws-sm-xacct"}},
		Services: []types.ProjectServiceConfig{{
			Name: "api",
			Bindings: []types.ServiceBinding{{
				Target: target,
				Inject: []types.ServiceBindingInjection{{Env: "STRIPE_KEY", From: "value"}},
			}},
		}},
	}
	dir := t.TempDir()
	skips, n, err := writeBindingExternalSecrets(dir, vc, map[string]string{}, false, secretStoreRefs(vc, xacctFacts()), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || len(skips) != 0 {
		t.Fatalf("xacct secret binding → 1 ExternalSecret, no skips; got n=%d skips=%v", n, skips)
	}
	b, err := os.ReadFile(filepath.Join(dir, manifests.BindingSecretName("api", target)+"-externalsecret.yaml"))
	if err != nil {
		t.Fatalf("ExternalSecret not written: %v", err)
	}
	y := string(b)
	if !strings.Contains(y, "name: secretstore-aws-xacct") || !strings.Contains(y, "key: stripe-key") {
		t.Errorf("xacct ExternalSecret wrong:\n%s", y)
	}
	if strings.Contains(y, "property:") {
		t.Errorf("a cross-account remoteRef must carry NO property sub-selector:\n%s", y)
	}
}

// A gate-closed cross-account secret is REPORTED, never silently dropped — and the skip reason must
// carry names only (service / secret), never a secret value.
func TestWriteBindingExternalSecrets_XacctSkipReasonCarriesNoValue(t *testing.T) {
	vc := &types.ProjectConfig{
		Provider: "aws",
		Secrets:  []types.ProjectSecretConfig{{Name: "stripe-key", Provider: "aws-sm-xacct"}},
		Services: []types.ProjectServiceConfig{{
			Name: "api",
			Bindings: []types.ServiceBinding{{
				Target: types.ServiceBindingTarget{Kind: "secret", Name: "stripe-key"},
				Inject: []types.ServiceBindingInjection{{Env: "STRIPE_KEY", From: "value"}},
			}},
		}},
	}
	f := xacctFacts()
	f.IRSAExternalSecretsArn = "" // gate closed
	skips, n, err := writeBindingExternalSecrets(t.TempDir(), vc, map[string]string{}, false, secretStoreRefs(vc, f), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 || len(skips) != 1 {
		t.Fatalf("gate closed ⇒ 0 written + 1 reported; got n=%d skips=%v", n, skips)
	}
	for _, s := range skips {
		if !strings.Contains(s, "api") || !strings.Contains(s, "stripe-key") {
			t.Errorf("skip reason should name the service and secret: %q", s)
		}
		if strings.Contains(s, "arn:aws:iam::222222222222") {
			t.Errorf("skip reason must not echo the cross-account target: %q", s)
		}
	}
}

// A NATIVE secret carries Provider "". If facts.SecretsXacctSlug were ever empty while a store
// rendered, gate 3's `s.Provider == facts.SecretsXacctSlug` would be ""=="" and every native secret
// would silently resolve to the CROSS-ACCOUNT store — reading the customer's foreign account for a
// secret that never should have left the cluster's own. Unreachable today (all four providers
// hardcode their slug); asserted because the failure is silent and cross-tenant.
func TestSecretStoreRefs_XacctEmptySlugNeverMatchesNativeSecret(t *testing.T) {
	vc := &types.ProjectConfig{Provider: "aws", Secrets: []types.ProjectSecretConfig{
		{Name: "native-secret", Provider: ""},
	}}
	f := xacctFacts()
	f.SecretsXacctSlug = "" // a lane that forgot to set Slug
	if refs := secretStoreRefs(vc, f); len(refs) != 0 {
		t.Errorf("a native secret must NEVER resolve to a cross-account store, got %+v", refs)
	}
}

// The skip reason must name the ACTUAL cause. Reporting "native/excluded provider" for a
// cross-account secret whose store simply didn't render sends the operator to change a provider that
// is already correct — and the honest-N/A contract is what the decision records exist to uphold.
func TestSecretStoreSkipCause_DistinguishesXacctFromNative(t *testing.T) {
	vc := &types.ProjectConfig{Secrets: []types.ProjectSecretConfig{
		{Name: "xa", Provider: "aws-sm-xacct"},
		{Name: "nat", Provider: ""},
	}}
	xa := secretStoreSkipCause(vc, "xa")
	if !strings.Contains(xa, "cross-account") || !strings.Contains(xa, "aws-sm-xacct") {
		t.Errorf("cross-account cause should name the manager: %q", xa)
	}
	if strings.Contains(xa, "native/excluded") {
		t.Errorf("cross-account cause must not blame the provider choice: %q", xa)
	}
	if nat := secretStoreSkipCause(vc, "nat"); !strings.Contains(nat, "native/excluded") {
		t.Errorf("native cause wrong: %q", nat)
	}
	// An unknown secret name falls back to the generic cause rather than panicking.
	if got := secretStoreSkipCause(vc, "nope"); got == "" {
		t.Error("unknown secret must still yield a cause")
	}
}
