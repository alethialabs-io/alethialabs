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
	if len(docs) != 2 || docs[0]["kind"] != "ConfigMap" {
		t.Fatalf("AWS should emit the CA ConfigMap + the Job (no SA), got %d docs", len(docs))
	}
	job := docs[1]
	if job["kind"] != "Job" {
		t.Errorf("kind = %v, want Job", job["kind"])
	}
	ann := job["metadata"].(map[string]any)["annotations"].(map[string]any)
	if ann["argocd.argoproj.io/hook"] != "PreSync" || ann["argocd.argoproj.io/hook-delete-policy"] != "BeforeHookCreation,HookSucceeded" {
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
			"cloud_sql_server_ca_cert":     testGCPServerCA,
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
	// Azure emits the CA ConfigMap, a ServiceAccount and the Job (three docs).
	docs := parseYAMLDocs(t, res.JobYAML)
	if len(docs) != 3 || docs[0]["kind"] != "ConfigMap" {
		t.Fatalf("Azure should emit a CA ConfigMap + ServiceAccount + Job (3 docs), got %d:\n%s", len(docs), res.JobYAML)
	}
	sa := docs[1]
	if sa["kind"] != "ServiceAccount" {
		t.Fatalf("first doc should be the ServiceAccount, got %v", sa["kind"])
	}
	saAnn := sa["metadata"].(map[string]any)["annotations"].(map[string]any)
	if saAnn["azure.workload.identity/client-id"] != "aaaa1111-2222-3333-4444-555566667777" {
		t.Errorf("SA must be annotated with the DEDICATED admin client id, got %v", saAnn)
	}
	// The pod carries the WI use label (the webhook trigger) — assert on the parsed pod template.
	job := docs[2]
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

func TestBootstrapJob_Azure_MySQL_Keyless(t *testing.T) {
	// A keyless MySQL binding (EngineFamily "mysql") switches the apply client to the mysql client and
	// binds the app on its CLIENT id via CREATE AADUSER — not the Postgres OID/psql path.
	res, err := RenderBootstrapJob(Options{
		Provider:    "azure",
		RunnerImage: "ghcr.io/alethialabs-io/runner:1.2.3",
		Databases: []types.ProjectDatabaseConfig{
			{Name: "orders-db", EngineFamily: "mysql", IamAuth: boolPtr(true)},
		},
		Outputs: map[string]string{
			"azure_db_fqdn":            "orders.mysql.database.azure.com",
			"azure_db_name":            "orders_prod",
			"azure_db_admin_user":      "aks-orders-dbadmin",
			"azure_db_admin_client_id": "aaaa1111-2222-3333-4444-555566667777",
			"azure_db_client_id":       "cccc1111-2222-3333-4444-555566667777",
		},
	}, dbTarget())
	if err != nil {
		t.Fatal(err)
	}
	// Still the Azure keyless shape: CA ConfigMap + ServiceAccount + Job, WI-federated dedicated admin.
	docs := parseYAMLDocs(t, res.JobYAML)
	if len(docs) != 3 {
		t.Fatalf("Azure MySQL should emit a CA ConfigMap + ServiceAccount + Job (3 docs), got %d:\n%s", len(docs), res.JobYAML)
	}
	if docs[1]["kind"] != "ServiceAccount" {
		t.Fatalf("second doc should be the ServiceAccount, got %v", docs[1]["kind"])
	}
	// db-bootstrap binds the app on the CLIENT id via the MySQL dialect (--engine mysql --app-client-id).
	for _, want := range []string{
		"mint-admin-token", "db-token", // engine-agnostic admin-token init (unchanged)
		"--engine", "mysql", "--app-client-id", "cccc1111-2222-3333-4444-555566667777",
		mysqlClientImage, `name: "MYSQL_TCP_PORT"`, `value: "3306"`,
		"--enable-cleartext-plugin", "--ssl-mode=VERIFY_IDENTITY --ssl-ca=/etc/alethia/db-ca/ca.pem",
		"/bin/sh", "MYSQL_PWD=", "$(cat " + bootstrapTokenFile + ")", // token read into the mysql password

	} {
		if !strings.Contains(res.JobYAML, want) {
			t.Errorf("Azure MySQL Job missing %q:\n%s", want, res.JobYAML)
		}
	}
	// It must NOT be the Postgres path: no psql/postgres image, no OID bind, no PG* env.
	for _, bad := range []string{postgresClientImage, "psql", "--app-oid", "PGPORT", "PGPASSWORD"} {
		if strings.Contains(res.JobYAML, bad) {
			t.Errorf("Azure MySQL Job must not contain the Postgres construct %q:\n%s", bad, res.JobYAML)
		}
	}
	// Keyless: no admin ExternalSecret and no password secret ref (the password is the minted token).
	if res.AdminSecretYAML != "" {
		t.Errorf("Azure MySQL admin is keyless (token) — no admin ExternalSecret expected, got:\n%s", res.AdminSecretYAML)
	}
	if strings.Contains(res.JobYAML, "secretKeyRef") {
		t.Errorf("Azure MySQL Job must hold no password secret (keyless admin):\n%s", res.JobYAML)
	}
}

func TestBootstrapJob_Azure_MySQL_FailsClosed_OnMissingClientID(t *testing.T) {
	// Keyless MySQL binds on the app UAMI client id; without azure_db_client_id there is nothing to bind
	// to, so the Job must fail closed rather than render an un-bindable AADUSER.
	_, err := RenderBootstrapJob(Options{
		Provider:    "azure",
		RunnerImage: "ghcr.io/alethialabs-io/runner:1.2.3",
		Databases: []types.ProjectDatabaseConfig{
			{Name: "orders-db", EngineFamily: "mysql", IamAuth: boolPtr(true)},
		},
		Outputs: map[string]string{
			"azure_db_fqdn":            "orders.mysql.database.azure.com",
			"azure_db_name":            "orders_prod",
			"azure_db_admin_user":      "aks-orders-dbadmin",
			"azure_db_admin_client_id": "aaaa1111-2222-3333-4444-555566667777",
			// azure_db_client_id intentionally absent
		},
	}, dbTarget())
	if err == nil {
		t.Error("expected fail-closed error when azure_db_client_id is missing for a keyless MySQL bind")
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

func TestBootstrapJob_AWS_MySQL_Keyless(t *testing.T) {
	// AWS MySQL renders the AWSAuthenticationPlugin dialect and applies it with the mysql client, but the
	// ADMIN credential is unchanged: the RDS master from the ExternalSecret. Azure's minted-admin-token
	// machinery must NOT be ported here — an IAM-token admin would itself have to be a pre-existing
	// plugin user, and the master user is precisely who creates those (#1507).
	res, err := RenderBootstrapJob(Options{
		Provider:    "aws",
		RunnerImage: "ghcr.io/alethialabs-io/runner:1.2.3",
		Databases: []types.ProjectDatabaseConfig{
			{Name: "orders-db", EngineFamily: "mysql", IamAuth: boolPtr(true)},
		},
		Outputs: map[string]string{
			"rds_cluster_endpoint":               "orders.cluster-abc.eu-central-1.rds.amazonaws.com",
			"rds_database_name":                  "orders_prod",
			"rds_master_credentials_secret_name": "alethia/orders/rds-master",
		},
	}, dbTarget())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"--engine", "mysql", // the MySQL dialect, not the default Postgres one
		mysqlClientImage, `name: "MYSQL_TCP_PORT"`, `value: "3306"`,
		"--ssl-mode=VERIFY_IDENTITY --ssl-ca=/etc/alethia/db-ca/ca.pem",
		"secretKeyRef", // admin username + password come from the ExternalSecret
	} {
		if !strings.Contains(res.JobYAML, want) {
			t.Errorf("AWS MySQL Job missing %q:\n%s", want, res.JobYAML)
		}
	}
	// The admin ExternalSecret IS present here (unlike Azure's keyless admin).
	if res.AdminSecretYAML == "" {
		t.Error("AWS MySQL bootstrap must materialize the RDS master via an admin ExternalSecret")
	}
	// The cleartext plugin is an Azure Entra-token quirk. Enabling it against a NATIVE password admin
	// would let the client hand that password to the server in the clear on request — the single most
	// important thing this test pins.
	if strings.Contains(res.JobYAML, "--enable-cleartext-plugin") {
		t.Errorf("AWS MySQL admin auth is a native password — the cleartext plugin must be absent:\n%s", res.JobYAML)
	}
	// Not the Postgres path, and no Azure admin-token machinery.
	for _, bad := range []string{
		postgresClientImage, "psql", "PGPASSWORD", "PGPORT", // Postgres constructs
		"mint-admin-token", "db-token", "workload.identity", // Azure admin-identity machinery
	} {
		if strings.Contains(res.JobYAML, bad) {
			t.Errorf("AWS MySQL Job must not contain %q:\n%s", bad, res.JobYAML)
		}
	}
}

func TestBootstrapJob_GCP_MySQL_Keyless(t *testing.T) {
	// GCP MySQL is grants-only (tofu already created the CLOUD_IAM_SERVICE_ACCOUNT user, as on Postgres),
	// applied with the mysql client as the built-in admin from the ExternalSecret. The --app-user value
	// is the MySQL login form: Cloud SQL MySQL truncates the @ and domain (#1505).
	res, err := RenderBootstrapJob(Options{
		Provider:    "gcp",
		RunnerImage: "ghcr.io/alethialabs-io/runner:1.2.3",
		Databases: []types.ProjectDatabaseConfig{
			{Name: "orders-db", EngineFamily: "mysql", IamAuth: boolPtr(true)},
		},
		Outputs: map[string]string{
			"cloud_sql_ip":                 "10.20.0.3",
			"cloud_sql_server_ca_cert":     testGCPServerCA,
			"cloud_sql_database":           "orders_prod",
			"cloud_sql_iam_user":           "alethia-app", // MySQL form, not "alethia-app@proj.iam"
			"cloud_sql_credentials_secret": "projects/p/secrets/orders-sql",
		},
	}, dbTarget())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"--engine", "mysql", "--app-user", "alethia-app",
		mysqlClientImage, `value: "3306"`, "--ssl-mode=VERIFY_CA --ssl-ca=/etc/alethia/db-ca/ca.pem",
		"secretKeyRef",
	} {
		if !strings.Contains(res.JobYAML, want) {
			t.Errorf("GCP MySQL Job missing %q:\n%s", want, res.JobYAML)
		}
	}
	if res.AdminSecretYAML == "" {
		t.Error("GCP MySQL bootstrap must materialize the built-in admin via an admin ExternalSecret")
	}
	if strings.Contains(res.JobYAML, "--enable-cleartext-plugin") {
		t.Errorf("GCP MySQL admin auth is a native password — the cleartext plugin must be absent:\n%s", res.JobYAML)
	}
	for _, bad := range []string{postgresClientImage, "psql", "PGPASSWORD", "mint-admin-token"} {
		if strings.Contains(res.JobYAML, bad) {
			t.Errorf("GCP MySQL Job must not contain %q:\n%s", bad, res.JobYAML)
		}
	}
}

func TestBootstrapJob_Postgres_RendersUnchanged_OnAWSAndGCP(t *testing.T) {
	// The engine branch must not perturb the shipped Postgres path — an absent/blank EngineFamily still
	// renders psql, which is what every existing environment is running.
	for _, tc := range []struct {
		provider string
		outputs  map[string]string
	}{
		{"aws", map[string]string{
			"rds_cluster_endpoint":               "orders.cluster-abc.eu-central-1.rds.amazonaws.com",
			"rds_database_name":                  "orders_prod",
			"rds_master_credentials_secret_name": "alethia/orders/rds-master",
		}},
		{"gcp", map[string]string{
			"cloud_sql_ip":                 "10.20.0.3",
			"cloud_sql_server_ca_cert":     testGCPServerCA,
			"cloud_sql_database":           "orders_prod",
			"cloud_sql_iam_user":           "alethia-app@proj.iam",
			"cloud_sql_credentials_secret": "projects/p/secrets/orders-sql",
		}},
	} {
		t.Run(tc.provider, func(t *testing.T) {
			res, err := RenderBootstrapJob(Options{
				Provider:    tc.provider,
				RunnerImage: "ghcr.io/alethialabs-io/runner:1.2.3",
				Databases: []types.ProjectDatabaseConfig{
					{Name: "orders-db", IamAuth: boolPtr(true)}, // no EngineFamily → postgres
				},
				Outputs: tc.outputs,
			}, dbTarget())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(res.JobYAML, postgresClientImage) {
				t.Errorf("%s postgres Job should still use the psql client:\n%s", tc.provider, res.JobYAML)
			}
			for _, bad := range []string{mysqlClientImage, "--engine", "MYSQL_TCP_PORT"} {
				if strings.Contains(res.JobYAML, bad) {
					t.Errorf("%s postgres Job must not contain the MySQL construct %q:\n%s", tc.provider, bad, res.JobYAML)
				}
			}
		})
	}
}

// hookDeletePolicies returns the set of ArgoCD hook-delete-policy values on a parsed object, failing
// the test when the object is not a PreSync hook or carries no policy at all.
func hookDeletePolicies(t *testing.T, doc map[string]any) map[string]bool {
	t.Helper()
	meta, _ := doc["metadata"].(map[string]any)
	ann, _ := meta["annotations"].(map[string]any)
	if ann["argocd.argoproj.io/hook"] != "PreSync" {
		t.Fatalf("%v %v is not a PreSync hook: %v", doc["kind"], meta["name"], ann)
	}
	raw, _ := ann["argocd.argoproj.io/hook-delete-policy"].(string)
	if raw == "" {
		t.Fatalf("%v %v carries no hook-delete-policy", doc["kind"], meta["name"])
	}
	set := map[string]bool{}
	for _, p := range strings.Split(raw, ",") {
		set[strings.TrimSpace(p)] = true
	}
	return set
}

// assertPolicyExactly fails unless the object's delete policy is exactly want — no member missing,
// none extra.
func assertPolicyExactly(t *testing.T, doc map[string]any, want ...string) {
	t.Helper()
	got := hookDeletePolicies(t, doc)
	for _, w := range want {
		if !got[w] {
			t.Errorf("%v hook-delete-policy %v is missing %s", doc["kind"], got, w)
		}
	}
	if len(got) != len(want) {
		t.Errorf("%v hook-delete-policy = %v, want exactly %v", doc["kind"], got, want)
	}
}

// TestBootstrapJob_HookDeletePolicies pins the delete policy on every bootstrap hook. An object that
// is or confers an admin credential (the AWS/GCP admin ExternalSecret, the Azure admin-federated
// ServiceAccount) must be removed whatever the Job's outcome, and recreated fresh on a retry; the Job
// itself keeps a failed run for its logs but must be replaced on the next sync.
func TestBootstrapJob_HookDeletePolicies(t *testing.T) {
	adminPolicy := []string{"BeforeHookCreation", "HookSucceeded", "HookFailed"}
	jobPolicy := []string{"BeforeHookCreation", "HookSucceeded"}
	caPolicy := []string{"BeforeHookCreation"}
	for _, tc := range []struct {
		provider string
		outputs  map[string]string
	}{
		{"aws", map[string]string{
			"rds_cluster_endpoint":               "orders.abc.rds.amazonaws.com",
			"rds_database_name":                  "ordersdb",
			"rds_master_credentials_secret_name": "alethia/rds/orders",
		}},
		{"gcp", map[string]string{
			"cloud_sql_ip":                 "10.0.0.5",
			"cloud_sql_server_ca_cert":     testGCPServerCA,
			"cloud_sql_database":           "orders-prod",
			"cloud_sql_iam_user":           "appdb-1a2b@proj.iam",
			"cloud_sql_credentials_secret": "orders-prod-sql-credentials",
		}},
		{"azure", map[string]string{
			"azure_db_fqdn":            "orders.postgres.database.azure.com",
			"azure_db_name":            "orders_prod",
			"azure_db_admin_user":      "aks-orders-dbadmin",
			"azure_db_admin_client_id": "aaaa1111-2222-3333-4444-555566667777",
			"azure_db_app_oid":         "bbbb1111-2222-3333-4444-555566667777",
		}},
	} {
		t.Run(tc.provider, func(t *testing.T) {
			res, err := RenderBootstrapJob(Options{
				Provider:    tc.provider,
				RunnerImage: "ghcr.io/alethialabs-io/runner:1.2.3",
				Outputs:     tc.outputs,
			}, dbTarget())
			if err != nil {
				t.Fatal(err)
			}
			credentialHooks := 0
			for _, doc := range parseYAMLDocs(t, res.JobYAML) {
				switch doc["kind"] {
				case "Job":
					assertPolicyExactly(t, doc, jobPolicy...)
				case "ConfigMap":
					// Public CA certificates only: replaced on the next sync, not reaped with the credential.
					assertPolicyExactly(t, doc, caPolicy...)
				case "ServiceAccount":
					credentialHooks++
					assertPolicyExactly(t, doc, adminPolicy...)
				default:
					t.Errorf("unexpected object %v in the bootstrap Job YAML", doc["kind"])
				}
			}
			if res.AdminSecretYAML != "" {
				for _, doc := range parseYAMLDocs(t, res.AdminSecretYAML) {
					credentialHooks++
					assertPolicyExactly(t, doc, adminPolicy...)
					// The materialized Secret is owned by the ExternalSecret, so it is
					// garbage-collected when the hook is deleted.
					spec, _ := doc["spec"].(map[string]any)
					target, _ := spec["target"].(map[string]any)
					if target["creationPolicy"] != "Owner" {
						t.Errorf("admin ExternalSecret target.creationPolicy = %v, want Owner", target["creationPolicy"])
					}
				}
			}
			// Every provider has exactly one credential-bearing hook; zero means the loop above
			// asserted nothing about it.
			if credentialHooks != 1 {
				t.Errorf("%s: %d credential-bearing hooks checked, want 1", tc.provider, credentialHooks)
			}
		})
	}
}

// renderBootstrapJobDoc renders the bootstrap for a provider with the fixture outputs used above and
// returns the parsed Job document.
func renderBootstrapJobDoc(t *testing.T, provider string, outputs map[string]string) map[string]any {
	t.Helper()
	res, err := RenderBootstrapJob(Options{
		Provider:    provider,
		RunnerImage: "ghcr.io/alethialabs-io/runner:1.2.3",
		Outputs:     outputs,
	}, dbTarget())
	if err != nil {
		t.Fatal(err)
	}
	for _, doc := range parseYAMLDocs(t, res.JobYAML) {
		if doc["kind"] == "Job" {
			return doc
		}
	}
	t.Fatalf("no Job rendered for %s:\n%s", provider, res.JobYAML)
	return nil
}

// TestBootstrapJob_TimeBounds pins the Job's activeDeadlineSeconds (bounding the PreSync phase, so the
// hook delete policies always get to run) and ttlSecondsAfterFinished (bounding a kept failed Job's
// lifetime) on every provider.
func TestBootstrapJob_TimeBounds(t *testing.T) {
	for provider, outputs := range map[string]map[string]string{
		"aws": {
			"rds_cluster_endpoint":               "orders.abc.rds.amazonaws.com",
			"rds_database_name":                  "ordersdb",
			"rds_master_credentials_secret_name": "alethia/rds/orders",
		},
		"gcp": {
			"cloud_sql_ip":                 "10.0.0.5",
			"cloud_sql_server_ca_cert":     testGCPServerCA,
			"cloud_sql_database":           "orders-prod",
			"cloud_sql_iam_user":           "appdb-1a2b@proj.iam",
			"cloud_sql_credentials_secret": "orders-prod-sql-credentials",
		},
		"azure": {
			"azure_db_fqdn":            "orders.postgres.database.azure.com",
			"azure_db_name":            "orders_prod",
			"azure_db_admin_user":      "aks-orders-dbadmin",
			"azure_db_admin_client_id": "aaaa1111-2222-3333-4444-555566667777",
			"azure_db_app_oid":         "bbbb1111-2222-3333-4444-555566667777",
		},
	} {
		t.Run(provider, func(t *testing.T) {
			spec, _ := renderBootstrapJobDoc(t, provider, outputs)["spec"].(map[string]any)
			if got := spec["activeDeadlineSeconds"]; got != 900 {
				t.Errorf("activeDeadlineSeconds = %v, want 900", got)
			}
			if got := spec["ttlSecondsAfterFinished"]; got != 3600 {
				t.Errorf("ttlSecondsAfterFinished = %v, want 3600", got)
			}
		})
	}
}

// TestBootstrapJob_Azure_TokenScratchIsMemoryBacked pins the Azure admin-token scratch volume to a
// memory-backed emptyDir (scratch data stays off the node's disk), and the SQL scratch volume to a
// plain one.
func TestBootstrapJob_Azure_TokenScratchIsMemoryBacked(t *testing.T) {
	job := renderBootstrapJobDoc(t, "azure", map[string]string{
		"azure_db_fqdn":            "orders.postgres.database.azure.com",
		"azure_db_name":            "orders_prod",
		"azure_db_admin_user":      "aks-orders-dbadmin",
		"azure_db_admin_client_id": "aaaa1111-2222-3333-4444-555566667777",
		"azure_db_app_oid":         "bbbb1111-2222-3333-4444-555566667777",
	})
	podSpec := job["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)
	vols, _ := podSpec["volumes"].([]any)
	seen := map[string]bool{}
	for _, v := range vols {
		vol, _ := v.(map[string]any)
		name, _ := vol["name"].(string)
		seen[name] = true
		if name == dbCAVolume {
			continue // the CA ConfigMap, pinned by TestBootstrapJob_VerifiesTheServerPerCloud
		}
		ed, ok := vol["emptyDir"].(map[string]any)
		if !ok {
			t.Errorf("volume %s is not an emptyDir: %v", name, vol)
			continue
		}
		switch name {
		case "admin-token":
			if ed["medium"] != "Memory" {
				t.Errorf("admin-token emptyDir medium = %v, want Memory", ed["medium"])
			}
		case "sql":
			if _, has := ed["medium"]; has {
				t.Errorf("sql emptyDir should be a plain emptyDir, got %v", ed)
			}
		}
	}
	if !seen["admin-token"] || !seen["sql"] {
		t.Errorf("Azure Job volumes = %v, want both admin-token and sql", vols)
	}
}

// TestBootstrapJob_BootstrapOnlyLabel pins the label the runner's stranded-hook reconcile selects on:
// it is on every credential-bearing hook (the admin ExternalSecret on AWS/GCP, the admin-federated
// ServiceAccount on Azure) as the STRING "true", and NOT on the Job, which holds no credential and has
// its own time bounds. The key and value are written out literally so a change to the constants fails
// here as well as in the provisioner's selector test.
func TestBootstrapJob_BootstrapOnlyLabel(t *testing.T) {
	const key, value = "alethia.io/bootstrap-only", "true"
	for provider, outputs := range map[string]map[string]string{
		"aws": {
			"rds_cluster_endpoint":               "orders.abc.rds.amazonaws.com",
			"rds_database_name":                  "ordersdb",
			"rds_master_credentials_secret_name": "alethia/rds/orders",
		},
		"gcp": {
			"cloud_sql_ip":                 "10.0.0.5",
			"cloud_sql_server_ca_cert":     testGCPServerCA,
			"cloud_sql_database":           "orders-prod",
			"cloud_sql_iam_user":           "appdb-1a2b@proj.iam",
			"cloud_sql_credentials_secret": "orders-prod-sql-credentials",
		},
		"azure": {
			"azure_db_fqdn":            "orders.postgres.database.azure.com",
			"azure_db_name":            "orders_prod",
			"azure_db_admin_user":      "aks-orders-dbadmin",
			"azure_db_admin_client_id": "aaaa1111-2222-3333-4444-555566667777",
			"azure_db_app_oid":         "bbbb1111-2222-3333-4444-555566667777",
		},
	} {
		t.Run(provider, func(t *testing.T) {
			res, err := RenderBootstrapJob(Options{
				Provider:    provider,
				RunnerImage: "ghcr.io/alethialabs-io/runner:1.2.3",
				Outputs:     outputs,
			}, dbTarget())
			if err != nil {
				t.Fatal(err)
			}
			labelled := 0
			for _, doc := range append(parseYAMLDocs(t, res.JobYAML), parseYAMLDocs(t, res.AdminSecretYAML)...) {
				meta, _ := doc["metadata"].(map[string]any)
				labels, _ := meta["labels"].(map[string]any)
				got, present := labels[key]
				switch doc["kind"] {
				case "Job", "ConfigMap":
					if present {
						t.Errorf("the %v carries %s=%v; it holds no credential and must not be reaped", doc["kind"], key, got)
					}
				case "ExternalSecret", "ServiceAccount":
					if s, ok := got.(string); !ok || s != value {
						t.Errorf("%v label %s = %#v, want the string %q", doc["kind"], key, got, value)
					}
					labelled++
				default:
					t.Errorf("unexpected object %v", doc["kind"])
				}
			}
			if labelled != 1 {
				t.Errorf("%s: %d credential-bearing hooks checked, want 1", provider, labelled)
			}
		})
	}
}

// TestBootstrapLabelQuoting_BindingExternalSecretRendersItsLabelAsAString pins the BYO-chart binding
// ExternalSecret byte for byte. Its marker label value is the double-quoted string "true": the shared
// template quotes every caller-supplied label value, so the bootstrap-only label (which passes its
// rows pre-quoted) and the binding lane's marker both reach the API server as strings. An unquoted
// `true` is a YAML boolean, and an object carrying one as a label value is rejected at apply.
func TestBootstrapLabelQuoting_BindingExternalSecretRendersItsLabelAsAString(t *testing.T) {
	got, skipped, err := RenderExternalSecret(ExternalSecretParams{
		ServiceName: "web",
		Namespace:   "ns",
		Target:      types.ServiceBindingTarget{Kind: "database", Name: "orders"},
		Provider:    "aws",
		RemoteKey:   "arn:secret",
		Facets:      []string{"username", "password"},
		Labels:      map[string]string{"alethia.io/byo-binding": "true"},
	})
	if err != nil || len(skipped) != 0 {
		t.Fatalf("render err=%v skipped=%v", err, skipped)
	}
	const want = "apiVersion: external-secrets.io/v1beta1\nkind: ExternalSecret\nmetadata:\n  name: web-database-orders\n  namespace: ns\n  labels:\n    app.kubernetes.io/name: web-database-orders\n    app.kubernetes.io/managed-by: alethia\n    alethia.io/byo-binding: \"true\"\nspec:\n  refreshInterval: 1h\n  secretStoreRef:\n    name: secretstore-aws\n    kind: ClusterSecretStore\n  target:\n    name: web-database-orders\n    creationPolicy: Owner\n  data:\n    - secretKey: username\n      remoteRef:\n        key: arn:secret\n        property: username\n    - secretKey: password\n      remoteRef:\n        key: arn:secret\n        property: password\n"
	if got != want {
		t.Errorf("BYO-chart binding ExternalSecret rendering changed:\n got %q\nwant %q", got, want)
	}
}
