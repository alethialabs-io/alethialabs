// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The #589 "done when": manifests rendered from first-class vc.Services with a REAL
// digest pass the elench verify gate (packages/core/verify/k8s.go) — in particular
// IMAGE-001, which fails ":latest"/untagged images and is exactly why the old scanner
// path's "<name>:latest" scaffold could never deploy through a fail-closed apply.
package manifests

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

func TestRenderedServiceManifestsPassVerify(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{
		{
			Name:          "web",
			Type:          "deployment",
			Source:        types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/web"},
			ResolvedImage: "123.dkr.ecr.eu-west-1.amazonaws.com/proj-web@sha256:0f3a1b",
			Env:           []types.ServiceEnvVar{{Name: "LOG_LEVEL", Value: "info"}},
			Ports:         []types.ServicePort{{ContainerPort: 8080, Protocol: "TCP"}},
			Replicas:      2,
			Probe:         &types.ServiceProbe{Type: "http", Path: "/healthz", Port: 8080},
		},
		{
			Name:   "worker",
			Type:   "deployment",
			Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/worker:1.2.3"},
		},
	}, Options{Namespace: "apps", Domain: "example.com"})
	if len(skipped) != 0 {
		t.Fatalf("nothing should be skipped: %v", skipped)
	}

	files, err := GenerateManifests(apps)
	if err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	for _, y := range files {
		all.WriteString(y)
		all.WriteString("\n---\n")
	}

	rep, err := verify.EvaluateManifests([]byte(all.String()))
	if err != nil {
		t.Fatalf("verify.EvaluateManifests: %v", err)
	}
	for _, c := range rep.Controls {
		for _, f := range c.Findings {
			// IMAGE-001 (mutable tag) must NEVER fire on rendered output — that is the
			// retired-:latest contract. Other controls' findings would flag template
			// hardening regressions just as loudly.
			t.Errorf("verify finding on rendered manifests [%s]: %s — %s", c.ID, f.Address, f.Message)
		}
	}
}

// TestRenderedKeylessManifestsPassVerify runs the KEYLESS render through the same elench gate. The
// keyless path was never covered here: it used to inject a third-party `bitnami/pgbouncer` sidecar,
// so IMAGE-001 (and the sidecar securityContext controls) had no test asserting the keyless pod was
// deployable through a fail-closed apply. With #1503 the only added container is the digest-or-tag
// pinned runner image, so the whole keyless pod is now gate-clean.
func TestRenderedKeylessManifestsPassVerify(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
		Provider:      "azure",
		KeylessDBAuth: true,
		RunnerImage:   "ghcr.io/alethialabs-io/runner@sha256:9c1e0b2a3d4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
		Databases: []types.ProjectDatabaseConfig{
			{Name: "orders-db", EngineFamily: engineMySQL, IamAuth: boolPtr(true)},
		},
		Outputs: map[string]string{
			"azure_db_fqdn":      "orders.mysql.database.azure.com",
			"azure_db_client_id": "11111111-2222-3333-4444-555555555555",
		},
	})
	if len(skipped) != 0 {
		t.Fatalf("nothing should be skipped: %v", skipped)
	}

	files, err := GenerateManifests(apps)
	if err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	for _, y := range files {
		all.WriteString(y)
		all.WriteString("\n---\n")
	}

	rep, err := verify.EvaluateManifests([]byte(all.String()))
	if err != nil {
		t.Fatalf("verify.EvaluateManifests: %v", err)
	}
	// RESOURCES-001 is a WARN (medium), so it does not block a fail-closed apply — but no sidecar in
	// this repo declares CPU/memory limits, so it fires on db-authproxy. That is epic #1500's gate F
	// (sidecar resources + securityContext), a lane of its own covering every sidecar renderer, not
	// just this one. It is tolerated HERE and nowhere else: any other finding, and any RESOURCES-001
	// finding against a container other than the sidecar, fails this test.
	for _, c := range rep.Controls {
		for _, f := range c.Findings {
			if c.ID == "RESOURCES-001" && strings.HasSuffix(f.Address, ":db-authproxy") {
				continue // known, boarded: gate F
			}
			t.Errorf("verify finding on rendered keyless manifests [%s]: %s — %s", c.ID, f.Address, f.Message)
		}
	}
	// The point of the exercise: the keyless pod clears every HARD control, so it can actually reach
	// `tofu apply` through the fail-closed gate. IMAGE-001 in particular — the retired path injected a
	// third-party bitnami/pgbouncer image that nothing here ever gate-checked.
	if rep.Blocking() {
		t.Errorf("keyless manifests must clear the fail-closed gate, got verdict %v", rep.Verdict)
	}
}
