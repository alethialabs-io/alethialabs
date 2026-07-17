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

	n, err := writeBindingExternalSecrets(dir, vc, outputs, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("expected 1 ExternalSecret written, got %d", n)
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
	n, err := writeBindingExternalSecrets(dir, vc, map[string]string{}, &log)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("no store for hetzner → 0 written, got %d", n)
	}
	if !strings.Contains(log.String(), "skipped") {
		t.Errorf("an unsatisfiable facet must be reported, got: %q", log.String())
	}
}
