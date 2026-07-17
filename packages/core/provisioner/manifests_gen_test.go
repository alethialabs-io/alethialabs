// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

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

	skips, n, err := writeBindingExternalSecrets(dir, vc, outputs, io.Discard)
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
	warnings, err := generateAppManifests(vc, map[string]interface{}{}, "token", io.Discard, io.Discard)
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
	skips, n, err := writeBindingExternalSecrets(dir, vc, map[string]string{}, &log)
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
