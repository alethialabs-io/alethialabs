// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"io"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

// parseYAMLDocs decodes every `---`-separated document in s, failing the test on any YAML error — the
// structural guard that catches template indentation bugs the strings.Contains checks would miss.
func parseYAMLDocs(t *testing.T, s string) []map[string]any {
	t.Helper()
	dec := yaml.NewDecoder(strings.NewReader(s))
	var docs []map[string]any
	for {
		var doc map[string]any
		err := dec.Decode(&doc)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("rendered YAML does not parse: %v\n---\n%s", err, s)
		}
		if doc != nil {
			docs = append(docs, doc)
		}
	}
	return docs
}

func dbTarget() types.ServiceBindingTarget {
	return types.ServiceBindingTarget{Kind: "database", Name: "orders-db"}
}

func TestBootstrapJob_AWS(t *testing.T) {
	res, err := RenderBootstrapJob(Options{
		Provider:    "aws",
		RunnerImage: "ghcr.io/alethialabs-io/runner:1.2.3",
		Outputs: map[string]string{
			"rds_cluster_endpoint":               "orders.abc.rds.amazonaws.com",
			"rds_database_name":                  "ordersdb",
			"rds_master_credentials_secret_name": "alethia/rds/orders",
		},
	}, dbTarget())
	if err != nil {
		t.Fatal(err)
	}
	docs := parseYAMLDocs(t, res.JobYAML)
	if len(docs) != 1 {
		t.Fatalf("AWS Job should be a single doc (no SA), got %d", len(docs))
	}
	job := docs[0]
	if job["kind"] != "Job" {
		t.Errorf("kind = %v, want Job", job["kind"])
	}
	ann := job["metadata"].(map[string]any)["annotations"].(map[string]any)
	if ann["argocd.argoproj.io/hook"] != "PreSync" || ann["argocd.argoproj.io/hook-delete-policy"] != "HookSucceeded" {
		t.Errorf("missing ArgoCD PreSync hook annotations: %v", ann)
	}
	// db-bootstrap init container writes to the shared volume; psql reads PG creds from the admin ES.
	if !strings.Contains(res.JobYAML, "db-bootstrap") || !strings.Contains(res.JobYAML, "--out") {
		t.Errorf("missing db-bootstrap --out init container:\n%s", res.JobYAML)
	}
	for _, want := range []string{`name: "PGUSER"`, `name: "PGPASSWORD"`, "secretKeyRef", "name: " + "bootstrap-database-orders-db-admin"} {
		if !strings.Contains(res.JobYAML, want) {
			t.Errorf("Job missing %q:\n%s", want, res.JobYAML)
		}
	}
	// Admin ExternalSecret materializes username+password from the master secret via the AWS store.
	if res.AdminSecretYAML == "" {
		t.Fatal("AWS needs an admin ExternalSecret")
	}
	es := parseYAMLDocs(t, res.AdminSecretYAML)
	if len(es) != 1 || es[0]["kind"] != "ExternalSecret" {
		t.Fatalf("admin secret should be one ExternalSecret, got %v", es)
	}
	for _, want := range []string{"secretstore-aws", "alethia/rds/orders", "property: username", "property: password"} {
		if !strings.Contains(res.AdminSecretYAML, want) {
			t.Errorf("admin ExternalSecret missing %q:\n%s", want, res.AdminSecretYAML)
		}
	}
}

func TestBootstrapJob_GCP(t *testing.T) {
	res, err := RenderBootstrapJob(Options{
		Provider:    "gcp",
		RunnerImage: "ghcr.io/alethialabs-io/runner:1.2.3",
		Outputs: map[string]string{
			"cloud_sql_ip":                 "10.0.0.5",
			"cloud_sql_database":           "orders-prod",
			"cloud_sql_iam_user":           "appdb-1a2b@proj.iam",
			"cloud_sql_credentials_secret": "orders-prod-sql-credentials",
		},
	}, dbTarget())
	if err != nil {
		t.Fatal(err)
	}
	parseYAMLDocs(t, res.JobYAML)
	// The grant targets the app's CLOUD_IAM_SERVICE_ACCOUNT user via --app-user.
	if !strings.Contains(res.JobYAML, "--app-user") || !strings.Contains(res.JobYAML, "appdb-1a2b@proj.iam") {
		t.Errorf("GCP Job must pass the app IAM user to db-bootstrap:\n%s", res.JobYAML)
	}
	if !strings.Contains(res.JobYAML, "PGHOST") || !strings.Contains(res.JobYAML, "10.0.0.5") {
		t.Errorf("GCP Job must connect to the private IP:\n%s", res.JobYAML)
	}
	if res.AdminSecretYAML == "" || !strings.Contains(res.AdminSecretYAML, "secretstore-gcp") {
		t.Errorf("GCP needs an admin ExternalSecret via the gcp store:\n%s", res.AdminSecretYAML)
	}
}

func TestBootstrapJob_Azure_DedicatedAdminKeyless(t *testing.T) {
	res, err := RenderBootstrapJob(Options{
		Provider:    "azure",
		RunnerImage: "ghcr.io/alethialabs-io/runner:1.2.3",
		Outputs: map[string]string{
			"azure_db_fqdn":            "orders.postgres.database.azure.com",
			"azure_db_name":            "orders_prod",
			"azure_db_admin_user":      "aks-orders-dbadmin",
			"azure_db_admin_client_id": "aaaa1111-2222-3333-4444-555566667777",
			"azure_db_app_oid":         "bbbb1111-2222-3333-4444-555566667777",
		},
	}, dbTarget())
	if err != nil {
		t.Fatal(err)
	}
	// Azure emits a ServiceAccount + the Job (two docs).
	docs := parseYAMLDocs(t, res.JobYAML)
	if len(docs) != 2 {
		t.Fatalf("Azure should emit a ServiceAccount + Job (2 docs), got %d:\n%s", len(docs), res.JobYAML)
	}
	sa := docs[0]
	if sa["kind"] != "ServiceAccount" {
		t.Fatalf("first doc should be the ServiceAccount, got %v", sa["kind"])
	}
	saAnn := sa["metadata"].(map[string]any)["annotations"].(map[string]any)
	if saAnn["azure.workload.identity/client-id"] != "aaaa1111-2222-3333-4444-555566667777" {
		t.Errorf("SA must be annotated with the DEDICATED admin client id, got %v", saAnn)
	}
	// The pod carries the WI use label (the webhook trigger) — assert on the parsed pod template.
	job := docs[1]
	podLabels := job["spec"].(map[string]any)["template"].(map[string]any)["metadata"].(map[string]any)["labels"].(map[string]any)
	if podLabels["azure.workload.identity/use"] != "true" {
		t.Errorf("pod template must carry azure.workload.identity/use=true, got %v", podLabels)
	}
	// Two init containers: mint the admin token, then render the SQL binding the app OID.
	if !strings.Contains(res.JobYAML, "mint-admin-token") || !strings.Contains(res.JobYAML, "db-token") {
		t.Errorf("Azure must mint the admin Entra token in an init container:\n%s", res.JobYAML)
	}
	if !strings.Contains(res.JobYAML, "--app-oid") || !strings.Contains(res.JobYAML, "bbbb1111-2222-3333-4444-555566667777") {
		t.Errorf("Azure db-bootstrap must bind the app OID:\n%s", res.JobYAML)
	}
	// The psql step reads the token file into PGPASSWORD via a shell wrapper — NO password secret.
	if !strings.Contains(res.JobYAML, "/bin/sh") || !strings.Contains(res.JobYAML, "$(cat "+bootstrapTokenFile+")") {
		t.Errorf("Azure psql must read the minted token as the password:\n%s", res.JobYAML)
	}
	if res.AdminSecretYAML != "" {
		t.Errorf("Azure admin is keyless (token) — no admin ExternalSecret expected, got:\n%s", res.AdminSecretYAML)
	}
	// Keyless admin: the Job references no k8s Secret at all (the password is the minted token file).
	if strings.Contains(res.JobYAML, "secretKeyRef") {
		t.Errorf("Azure Job must hold no password secret (keyless admin):\n%s", res.JobYAML)
	}
}

func TestBootstrapJob_FailsClosed_OnMissingOutput(t *testing.T) {
	// A required admin output missing → error (the caller reports; no half-wired Job that wedges sync).
	_, err := RenderBootstrapJob(Options{
		Provider:    "aws",
		RunnerImage: "ghcr.io/alethialabs-io/runner:1.2.3",
		Outputs:     map[string]string{"rds_cluster_endpoint": "x", "rds_database_name": "d"}, // no master secret
	}, dbTarget())
	if err == nil {
		t.Error("expected fail-closed error when the admin credentials output is missing")
	}
}

func TestBootstrapJob_FailsClosed_OnMissingRunnerImage(t *testing.T) {
	_, err := RenderBootstrapJob(Options{Provider: "aws", Outputs: map[string]string{}}, dbTarget())
	if err == nil {
		t.Error("expected an error when no runner image is set (db-bootstrap/db-token cannot run)")
	}
}
