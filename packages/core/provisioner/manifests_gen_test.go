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
	stores := secretStoreRefs(vc)
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
	skips2, n2, err := writeBindingExternalSecrets(t.TempDir(), vc, map[string]string{}, false, secretStoreRefs(vc), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if n2 != 0 || len(skips2) == 0 {
		t.Errorf("native secret → 0 written + reported; got n=%d skips=%v", n2, skips2)
	}
}

// TestSecretStoreRefs_Classification: only first-class runtime-read stores (vault/doppler/generic) get
// an entry; doppler is flat (no property); native/excluded providers are absent (fail-closed).
func TestSecretStoreRefs_Classification(t *testing.T) {
	vc := &types.ProjectConfig{Secrets: []types.ProjectSecretConfig{
		{Name: "a", Provider: "vault"},
		{Name: "b", Provider: "doppler"},
		{Name: "c", Provider: "generic"},
		{Name: "d", Provider: "onepassword"}, // runtime-read excluded on ESO 0.9.12
		{Name: "e", Provider: ""},            // native
	}}
	refs := secretStoreRefs(vc)
	if refs["a"] != (manifests.SecretStoreRef{StoreName: "secretstore-vault", ValueProperty: "value"}) {
		t.Errorf("vault ref wrong: %+v", refs["a"])
	}
	if refs["b"] != (manifests.SecretStoreRef{StoreName: "secretstore-doppler", ValueProperty: ""}) {
		t.Errorf("doppler ref must be flat (no property): %+v", refs["b"])
	}
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
	warnings, err := generateAppManifests(context.Background(), vc, map[string]interface{}{}, "token", io.Discard, io.Discard)
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
