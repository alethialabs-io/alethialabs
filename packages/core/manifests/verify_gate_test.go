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
	// No exemptions. This used to tolerate RESOURCES-001 on the db-authproxy sidecar while gate F
	// (#1531) was open; the sidecar now declares CPU + memory limits, so the keyless pod is clean
	// under every control and this asserts it the same way its sibling above does.
	for _, c := range rep.Controls {
		for _, f := range c.Findings {
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

// assertManifestsPassVerify runs YAML docs through the elench gate and fails on ANY finding. The two
// tests above predate it and keep their bespoke messages; new renderers use this.
func assertManifestsPassVerify(t *testing.T, label string, yamls ...string) {
	t.Helper()
	var all strings.Builder
	for _, y := range yamls {
		if y == "" {
			continue
		}
		all.WriteString(y)
		all.WriteString("\n---\n")
	}
	rep, err := verify.EvaluateManifests([]byte(all.String()))
	if err != nil {
		t.Fatalf("%s: verify.EvaluateManifests: %v", label, err)
	}
	for _, c := range rep.Controls {
		for _, f := range c.Findings {
			t.Errorf("verify finding on %s [%s]: %s — %s", label, c.ID, f.Address, f.Message)
		}
	}
	if rep.Blocking() {
		t.Errorf("%s must clear the fail-closed gate, got verdict %v", label, rep.Verdict)
	}
}

// The three renderers below emit their own workload objects — two standalone Deployments and a Job —
// and NONE of them was covered by this gate before #1531. That is why their gaps survived: the
// refresher Deployments declared a memory limit but no cpu limit (RESOURCES-001 needs both) and no
// securityContext at all (CONTAINERSECURITY-001), and the bootstrap Job declared no resources on
// either its init or its main container. `Job` is in verify.workloadKinds, so it was always in
// scope for these controls — nothing was asking.

func TestRenderedRegistryRefresherPassesVerify(t *testing.T) {
	y, err := RenderRegistryRefresher(RegistryRefresher{
		Provider:      "aws",
		Namespace:     "default",
		SecretName:    "ecr-xacct-pull",
		RegistryHost:  "123456789012.dkr.ecr.us-east-1.amazonaws.com",
		Region:        "us-east-1",
		TargetRoleArn: "arn:aws:iam::999:role/pull",
		RunnerImage:   "ghcr.io/alethialabs-io/runner@sha256:9c1e0b2a3d4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
		SAAnnotations: map[string]string{"eks.amazonaws.com/role-arn": "arn:aws:iam::111:role/ecr-pull"},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertManifestsPassVerify(t, "rendered registry refresher", y)
}

func TestRenderedHelmRepoRefresherPassesVerify(t *testing.T) {
	y, err := RenderHelmRepoRefreshers([]HelmRepoRefresher{{
		SecretName:    "repo-helm-abc123",
		RepoURL:       "oci://111.dkr.ecr.us-east-1.amazonaws.com",
		Region:        "us-east-1",
		TargetRoleArn: "arn:aws:iam::111:role/pull",
	}},
		"arn:aws:iam::999:role/helm-pull",
		"ghcr.io/alethialabs-io/runner@sha256:9c1e0b2a3d4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b")
	if err != nil {
		t.Fatal(err)
	}
	assertManifestsPassVerify(t, "rendered helm repo refresher", y)
}

func TestRenderedBootstrapJobPassesVerify(t *testing.T) {
	const runnerImage = "ghcr.io/alethialabs-io/runner@sha256:9c1e0b2a3d4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b"
	// Provider × engine, because both axes change the container set: AWS/GCP add an admin-credential
	// init container where Azure mints a token instead, and the apply step is psqlContainer for
	// Postgres but mysqlContainer for MySQL. One cell passing says nothing about the others.
	awsOutputs := map[string]string{
		"rds_cluster_endpoint":               "orders.abc.rds.amazonaws.com",
		"rds_database_name":                  "ordersdb",
		"rds_master_credentials_secret_name": "alethia/rds/orders",
	}
	gcpOutputs := map[string]string{
		"cloud_sql_ip":                 "10.0.0.5",
		"cloud_sql_database":           "orders-prod",
		"cloud_sql_iam_user":           "appdb-1a2b@proj.iam",
		"cloud_sql_credentials_secret": "orders-prod-sql-credentials",
	}
	azureOutputs := map[string]string{
		"azure_db_fqdn":            "orders.postgres.database.azure.com",
		"azure_db_name":            "ordersdb",
		"azure_db_admin_user":      "alethia_admin",
		"azure_db_admin_client_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		"azure_db_app_oid":         "99999999-8888-7777-6666-555555555555",
		"azure_db_client_id":       "11111111-2222-3333-4444-555555555555",
	}
	for _, tc := range []struct {
		provider string
		engine   string
		outputs  map[string]string
	}{
		{"aws", enginePostgres, awsOutputs},
		{"aws", engineMySQL, awsOutputs},
		{"gcp", enginePostgres, gcpOutputs},
		{"gcp", engineMySQL, gcpOutputs},
		{"azure", enginePostgres, azureOutputs},
		{"azure", engineMySQL, azureOutputs},
	} {
		t.Run(tc.provider+"/"+tc.engine, func(t *testing.T) {
			res, err := RenderBootstrapJob(Options{
				Provider:    tc.provider,
				RunnerImage: runnerImage,
				Outputs:     tc.outputs,
				Databases: []types.ProjectDatabaseConfig{
					{Name: "orders-db", EngineFamily: tc.engine, IamAuth: boolPtr(true)},
				},
			}, dbTarget())
			if err != nil {
				t.Fatal(err)
			}
			assertManifestsPassVerify(t, tc.provider+"/"+tc.engine+" bootstrap job", res.JobYAML, res.AdminSecretYAML)
		})
	}
}
