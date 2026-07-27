// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func boolPtr(b bool) *bool { return &b }

// keylessService is a service binding a database with the full facet set — the shape both the
// password path and the keyless path resolve from.
func keylessService() types.ProjectServiceConfig {
	return types.ProjectServiceConfig{
		Name:   "api",
		Type:   "deployment",
		Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/api:1"},
		Bindings: []types.ServiceBinding{{
			Target: types.ServiceBindingTarget{Kind: "database", Name: "orders-db"},
			Inject: []types.ServiceBindingInjection{
				{Env: "DATABASE_HOST", From: "endpoint"},
				{Env: "DATABASE_PORT", From: "port"},
				{Env: "DATABASE_USER", From: "username"},
				{Env: "DATABASE_PASSWORD", From: "password"},
			},
		}},
	}
}

func envValue(env []types.ServiceEnvVar, name string) (string, bool) {
	for _, e := range env {
		if e.Name == name {
			return e.Value, true
		}
	}
	return "", false
}

// TestKeyless_GCP_CloudSQLProxy locks the GCP keyless path (#722): a binding to an iam_auth database
// on GCP holds NO password — the endpoint points at the local Cloud SQL Auth Proxy sidecar, the
// username resolves to the IAM identity output, and no ExternalSecret secretKeyRef is emitted.
func TestKeyless_GCP_CloudSQLProxy(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
		Provider:      "gcp",
		KeylessDBAuth: true,
		Databases:     []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(true)}},
		Outputs: map[string]string{
			"cloud_sql_connection_name": "proj:us-central1:orders",
			"cloud_sql_iam_user":        "orders-app@proj.iam",
			"cloud_sql_app_gsa_email":   "orders-app@proj.iam.gserviceaccount.com",
		},
	})
	if len(skipped) != 0 {
		t.Fatalf("nothing should skip, got %v", skipped)
	}
	a := apps[0]

	if v, _ := envValue(a.Env, "DATABASE_HOST"); v != "127.0.0.1" {
		t.Errorf("endpoint = %q, want 127.0.0.1 (local proxy)", v)
	}
	if v, _ := envValue(a.Env, "DATABASE_PORT"); v != "5432" {
		t.Errorf("port = %q, want 5432", v)
	}
	if v, _ := envValue(a.Env, "DATABASE_USER"); v != "orders-app@proj.iam" {
		t.Errorf("username = %q, want the IAM identity output", v)
	}
	if _, ok := envValue(a.Env, "DATABASE_PASSWORD"); ok {
		t.Error("keyless must NOT inject a password env")
	}
	if len(a.SecretEnv) != 0 {
		t.Errorf("keyless must emit no secretKeyRef, got %+v", a.SecretEnv)
	}
	if len(a.Sidecars) != 1 || a.Sidecars[0].Name != "cloudsql-proxy" {
		t.Fatalf("want one cloudsql-proxy sidecar, got %+v", a.Sidecars)
	}
	joined := strings.Join(a.Sidecars[0].Args, " ")
	if !strings.Contains(joined, "proj:us-central1:orders") || !strings.Contains(joined, "--auto-iam-authn") {
		t.Errorf("proxy args missing connection name / --auto-iam-authn: %v", a.Sidecars[0].Args)
	}
	if len(a.Volumes) != 0 {
		t.Errorf("GCP proxy needs no volume, got %+v", a.Volumes)
	}
	// The pod runs as the Workload-Identity KSA, annotated with the app GSA.
	if a.ServiceAccount != "alethia-app" {
		t.Errorf("ServiceAccount = %q, want alethia-app", a.ServiceAccount)
	}
	if a.ServiceAccountAnnotations["iam.gke.io/gcp-service-account"] != "orders-app@proj.iam.gserviceaccount.com" {
		t.Errorf("KSA annotation wrong: %+v", a.ServiceAccountAnnotations)
	}

	// The sidecar + the annotated ServiceAccount both render.
	yaml, err := RenderApp(a)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(yaml, "name: cloudsql-proxy") || !strings.Contains(yaml, cloudSQLProxyImage) {
		t.Errorf("rendered YAML missing the proxy sidecar:\n%s", yaml)
	}
	if !strings.Contains(yaml, "kind: ServiceAccount") || !strings.Contains(yaml, "iam.gke.io/gcp-service-account") {
		t.Errorf("rendered YAML missing the annotated KSA:\n%s", yaml)
	}
}

// TestKeyless_Azure_TokenRefresherAndBouncer locks the Azure keyless path (#722): a refresher +
// pgbouncer sidecar pair backed by a shared emptyDir, app connects to 127.0.0.1, no password.
func TestKeyless_Azure_TokenRefresherAndBouncer(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
		Provider:      "azure",
		KeylessDBAuth: true,
		RunnerImage:   "ghcr.io/alethialabs-io/runner:1.2.3",
		Databases:     []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(true)}},
		Outputs: map[string]string{
			"azure_db_fqdn":      "orders.postgres.database.azure.com",
			"azure_db_aad_user":  "orders-app",
			"azure_db_client_id": "11111111-2222-3333-4444-555555555555",
		},
	})
	if len(skipped) != 0 {
		t.Fatalf("nothing should skip, got %v", skipped)
	}
	a := apps[0]

	if v, _ := envValue(a.Env, "DATABASE_HOST"); v != "127.0.0.1" {
		t.Errorf("endpoint = %q, want 127.0.0.1 (local pgbouncer)", v)
	}
	if v, _ := envValue(a.Env, "DATABASE_USER"); v != "alethia_app" {
		t.Errorf("username = %q, want the least-priv bootstrap role alethia_app", v)
	}
	if len(a.SecretEnv) != 0 {
		t.Errorf("keyless must emit no secretKeyRef, got %+v", a.SecretEnv)
	}
	if len(a.Sidecars) != 2 {
		t.Fatalf("want refresher + pgbouncer, got %+v", a.Sidecars)
	}
	// Postgres is the DEFAULT engine — an unset EngineFamily must keep rendering pgbouncer on 5432
	// (the pre-MySQL behaviour #1441 must not regress).
	if a.Sidecars[1].Name != "pgbouncer" || len(a.Sidecars[1].Ports) != 1 || a.Sidecars[1].Ports[0] != 5432 {
		t.Errorf("unset EngineFamily must render pgbouncer on 5432, got %+v", a.Sidecars[1])
	}
	if v, _ := envValue(a.Env, "DATABASE_PORT"); v != "5432" {
		t.Errorf("port = %q, want 5432 (pgbouncer's listener)", v)
	}
	if len(a.Volumes) != 1 || a.Volumes[0].Name != "db-token" {
		t.Fatalf("want one shared db-token volume, got %+v", a.Volumes)
	}
	// The refresher runs the runner image's db-token subcommand.
	if a.Sidecars[0].Image != "ghcr.io/alethialabs-io/runner:1.2.3" ||
		!strings.Contains(strings.Join(a.Sidecars[0].Args, " "), "db-token") {
		t.Errorf("refresher sidecar wrong: %+v", a.Sidecars[0])
	}
	// The pod runs as the Azure Workload-Identity KSA (labelled use=true, annotated client-id).
	if a.ServiceAccount != "alethia-app" ||
		a.ServiceAccountLabels["azure.workload.identity/use"] != "true" ||
		a.ServiceAccountAnnotations["azure.workload.identity/client-id"] != "11111111-2222-3333-4444-555555555555" {
		t.Errorf("Azure KSA wiring wrong: sa=%q labels=%+v annotations=%+v", a.ServiceAccount, a.ServiceAccountLabels, a.ServiceAccountAnnotations)
	}
}

// TestKeyless_Azure_MySQL_ProxySQL locks the Azure MySQL app half (#1441): the SAME engine-agnostic
// Entra token refresher, but fronted by a MySQL-wire ProxySQL on 3306 instead of pgbouncer on 5432.
// The app contract is unchanged — it connects to 127.0.0.1 and still holds NO password.
func TestKeyless_Azure_MySQL_ProxySQL(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
		Provider:      "azure",
		KeylessDBAuth: true,
		RunnerImage:   "ghcr.io/alethialabs-io/runner:1.2.3",
		Databases: []types.ProjectDatabaseConfig{
			{Name: "orders-db", EngineFamily: "mysql", IamAuth: boolPtr(true)},
		},
		Outputs: map[string]string{
			"azure_db_fqdn":      "orders.mysql.database.azure.com",
			"azure_db_client_id": "11111111-2222-3333-4444-555555555555",
		},
	})
	if len(skipped) != 0 {
		t.Fatalf("nothing should skip, got %v", skipped)
	}
	a := apps[0]

	// The app contract: localhost + the PROXY's port, no password.
	if v, _ := envValue(a.Env, "DATABASE_HOST"); v != "127.0.0.1" {
		t.Errorf("endpoint = %q, want 127.0.0.1 (local proxysql)", v)
	}
	if v, _ := envValue(a.Env, "DATABASE_PORT"); v != "3306" {
		t.Errorf("port = %q, want 3306 (proxysql's listener, not pgbouncer's 5432)", v)
	}
	if v, _ := envValue(a.Env, "DATABASE_USER"); v != "alethia_app" {
		t.Errorf("username = %q, want the bootstrap-created AADUSER alethia_app", v)
	}
	if _, ok := envValue(a.Env, "DATABASE_PASSWORD"); ok {
		t.Error("keyless must NOT inject a password env")
	}
	if len(a.SecretEnv) != 0 {
		t.Errorf("keyless must emit no secretKeyRef, got %+v", a.SecretEnv)
	}

	// Refresher + proxysql (NOT pgbouncer — it speaks the wrong wire protocol for MySQL).
	if len(a.Sidecars) != 2 {
		t.Fatalf("want refresher + proxysql, got %+v", a.Sidecars)
	}
	refresher, proxy := a.Sidecars[0], a.Sidecars[1]
	if refresher.Name != "db-token" || refresher.Image != "ghcr.io/alethialabs-io/runner:1.2.3" {
		t.Errorf("refresher sidecar wrong: %+v", refresher)
	}
	// The refresher is UNCHANGED for MySQL: the ossrdbms-aad scope is shared across engines, so it
	// carries no engine flag.
	if args := strings.Join(refresher.Args, " "); !strings.Contains(args, "db-token") ||
		!strings.Contains(args, "--provider azure") {
		t.Errorf("refresher args should be the engine-agnostic azure db-token call, got %v", refresher.Args)
	}
	if proxy.Name != "proxysql" || proxy.Image != proxySQLImage {
		t.Fatalf("want a proxysql sidecar on the pinned image, got %+v", proxy)
	}
	if len(proxy.Ports) != 1 || proxy.Ports[0] != 3306 {
		t.Errorf("proxysql must listen on 3306, got %+v", proxy.Ports)
	}
	if v, _ := envValue(proxy.Env, "PROXYSQL_UPSTREAM_HOST"); v != "orders.mysql.database.azure.com" {
		t.Errorf("proxysql upstream host wrong: %+v", proxy.Env)
	}
	if v, _ := envValue(proxy.Env, "PROXYSQL_UPSTREAM_USER"); v != "alethia_app" {
		t.Errorf("proxysql upstream user must be the AADUSER alethia_app: %+v", proxy.Env)
	}
	// It reads the SAME shared token file the refresher writes, read-only.
	if v, _ := envValue(proxy.Env, "PROXYSQL_TOKEN_FILE"); v != "/db-token/token" {
		t.Errorf("proxysql token file wrong: %+v", proxy.Env)
	}
	if len(proxy.Mounts) != 1 || proxy.Mounts[0].Name != "db-token" || !proxy.Mounts[0].ReadOnly {
		t.Errorf("proxysql must mount the shared db-token volume read-only, got %+v", proxy.Mounts)
	}
	if len(a.Volumes) != 1 || a.Volumes[0].Name != "db-token" {
		t.Fatalf("want one shared db-token volume, got %+v", a.Volumes)
	}

	// The Azure Workload-Identity KSA is engine-agnostic — unchanged from the Postgres path.
	if a.ServiceAccount != "alethia-app" ||
		a.ServiceAccountLabels["azure.workload.identity/use"] != "true" ||
		a.ServiceAccountAnnotations["azure.workload.identity/client-id"] != "11111111-2222-3333-4444-555555555555" {
		t.Errorf("Azure KSA wiring wrong: sa=%q labels=%+v annotations=%+v", a.ServiceAccount, a.ServiceAccountLabels, a.ServiceAccountAnnotations)
	}

	yaml, err := RenderApp(a)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(yaml, "name: proxysql") || !strings.Contains(yaml, proxySQLImage) {
		t.Errorf("rendered YAML missing the proxysql sidecar:\n%s", yaml)
	}
	if strings.Contains(yaml, "pgbouncer") {
		t.Errorf("a MySQL pod must not render a Postgres-wire pgbouncer:\n%s", yaml)
	}
}

// TestKeyless_Azure_PostgresEngine_KeepsPgBouncer: an EXPLICIT postgres EngineFamily renders exactly
// as the unset default does. Together with the unset case in TestKeyless_Azure_TokenRefresherAndBouncer
// this pins both spellings of "not MySQL" to the pre-#1441 behaviour.
func TestKeyless_Azure_PostgresEngine_KeepsPgBouncer(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
		Provider:      "azure",
		KeylessDBAuth: true,
		RunnerImage:   "ghcr.io/alethialabs-io/runner:1.2.3",
		Databases: []types.ProjectDatabaseConfig{
			{Name: "orders-db", EngineFamily: "postgres", IamAuth: boolPtr(true)},
		},
		Outputs: map[string]string{
			"azure_db_fqdn":      "orders.postgres.database.azure.com",
			"azure_db_client_id": "11111111-2222-3333-4444-555555555555",
		},
	})
	if len(skipped) != 0 {
		t.Fatalf("nothing should skip, got %v", skipped)
	}
	a := apps[0]
	if len(a.Sidecars) != 2 || a.Sidecars[1].Name != "pgbouncer" {
		t.Fatalf("explicit postgres must still render pgbouncer, got %+v", a.Sidecars)
	}
	if v, _ := envValue(a.Env, "DATABASE_PORT"); v != "5432" {
		t.Errorf("port = %q, want 5432", v)
	}
}

// TestKeyless_MySQL_NonAzure_FailsClosed: keyless MySQL is AZURE-ONLY. AWS Aurora-MySQL and GCP Cloud
// SQL MySQL bind their DB login by a different mechanism and ship no template, so the bootstrap Job
// already errors on --engine mysql there. The app half must agree EXPLICITLY: without this gate the
// binding would render a Postgres-wire pgbouncer (or a 5432 Cloud SQL proxy) against a MySQL server
// and fail only at runtime. The whole binding is omitted and reported, never half-wired.
func TestKeyless_MySQL_NonAzure_FailsClosed(t *testing.T) {
	cases := []struct {
		provider string
		outputs  map[string]string
	}{
		{"aws", map[string]string{
			"rds_cluster_endpoint":  "orders.cluster-x.us-east-1.rds.amazonaws.com",
			"aws_region":            "us-east-1",
			"rds_iam_auth_irsa_arn": "arn:aws:iam::123456789012:role/orders-rds-iam",
		}},
		{"gcp", map[string]string{
			"cloud_sql_connection_name": "proj:us-central1:orders",
			"cloud_sql_iam_user":        "orders-app@proj.iam",
			"cloud_sql_app_gsa_email":   "orders-app@proj.iam.gserviceaccount.com",
		}},
	}
	for _, tc := range cases {
		t.Run(tc.provider, func(t *testing.T) {
			apps, _ := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
				Provider:      tc.provider,
				KeylessDBAuth: true,
				RunnerImage:   "ghcr.io/alethialabs-io/runner:1.2.3",
				Databases: []types.ProjectDatabaseConfig{
					{Name: "orders-db", EngineFamily: "mysql", IamAuth: boolPtr(true)},
				},
				Outputs: tc.outputs,
			})
			a := apps[0]
			if len(a.Sidecars) != 0 || len(a.Volumes) != 0 {
				t.Errorf("keyless MySQL on %s must wire NOTHING, got sidecars=%+v volumes=%+v", tc.provider, a.Sidecars, a.Volumes)
			}
			// Fail-closed: the binding's envs are omitted rather than pointed at a proxy that
			// speaks the wrong protocol.
			for _, env := range []string{"DATABASE_HOST", "DATABASE_PORT", "DATABASE_USER", "DATABASE_PASSWORD"} {
				if v, ok := envValue(a.Env, env); ok {
					t.Errorf("%s must be omitted on a fail-closed binding, got %q", env, v)
				}
			}
			if len(a.SecretEnv) != 0 {
				t.Errorf("no secretKeyRef may be emitted, got %+v", a.SecretEnv)
			}
		})
	}
}

// TestKeyless_FlagOff_KeepsPasswordPath: with the dark flag off, an iam_auth database still uses the
// unchanged ExternalSecret/password path — no regression, no sidecars.
func TestKeyless_FlagOff_KeepsPasswordPath(t *testing.T) {
	apps, _ := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
		Provider:      "gcp",
		KeylessDBAuth: false, // flag OFF
		Databases:     []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(true)}},
		Outputs:       map[string]string{"cloud_sql_ip": "10.0.0.5", "cloud_sql_connection_name": "p:r:i"},
	})
	a := apps[0]
	if len(a.Sidecars) != 0 {
		t.Errorf("flag off → no sidecars, got %+v", a.Sidecars)
	}
	if len(a.SecretEnv) != 2 {
		t.Errorf("flag off → password path (username+password secretKeyRef), got %+v", a.SecretEnv)
	}
	if v, _ := envValue(a.Env, "DATABASE_HOST"); v != "10.0.0.5" {
		t.Errorf("flag off → real endpoint, got %q", v)
	}
}

// TestKeyless_IamAuthFalse_KeepsPasswordPath: flag on but the bound db is password-auth → unchanged.
func TestKeyless_IamAuthFalse_KeepsPasswordPath(t *testing.T) {
	apps, _ := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
		Provider:      "gcp",
		KeylessDBAuth: true,
		Databases:     []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(false)}},
		Outputs:       map[string]string{"cloud_sql_ip": "10.0.0.5"},
	})
	a := apps[0]
	if len(a.Sidecars) != 0 || len(a.SecretEnv) != 2 {
		t.Errorf("iam_auth=false → password path; sidecars=%+v secretEnv=%+v", a.Sidecars, a.SecretEnv)
	}
}

// TestKeyless_AWS_RDSIAMRefresher locks the AWS keyless path (#722 parity): RDS IAM auth uses the
// same token-refresher + pgbouncer mechanism as Azure, with an IRSA-annotated KSA.
func TestKeyless_AWS_RDSIAMRefresher(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
		Provider:      "aws",
		KeylessDBAuth: true,
		RunnerImage:   "ghcr.io/alethialabs-io/runner:1.2.3",
		Databases:     []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(true)}},
		Outputs: map[string]string{
			"rds_cluster_endpoint":  "orders.abc.rds.amazonaws.com",
			"aws_region":            "eu-central-1",
			"rds_iam_auth_irsa_arn": "arn:aws:iam::123456789012:role/rds-iam-auth-eks",
		},
	})
	if len(skipped) != 0 {
		t.Fatalf("nothing should skip, got %v", skipped)
	}
	a := apps[0]
	if v, _ := envValue(a.Env, "DATABASE_HOST"); v != "127.0.0.1" {
		t.Errorf("endpoint = %q, want 127.0.0.1 (local pgbouncer)", v)
	}
	if v, _ := envValue(a.Env, "DATABASE_USER"); v != "alethia_app" {
		t.Errorf("username = %q, want the least-priv bootstrap role alethia_app", v)
	}
	if _, ok := envValue(a.Env, "DATABASE_PASSWORD"); ok {
		t.Error("keyless must NOT inject a password env")
	}
	if len(a.SecretEnv) != 0 {
		t.Errorf("keyless must emit no secretKeyRef, got %+v", a.SecretEnv)
	}
	if len(a.Sidecars) != 2 || a.Sidecars[0].Name != "db-token" {
		t.Fatalf("want db-token refresher + pgbouncer, got %+v", a.Sidecars)
	}
	// The refresher mints an RDS auth token for the real endpoint/region/user.
	args := strings.Join(a.Sidecars[0].Args, " ")
	for _, want := range []string{"--provider aws", "orders.abc.rds.amazonaws.com", "eu-central-1", "--user alethia_app"} {
		if !strings.Contains(args, want) {
			t.Errorf("refresher args missing %q: %v", want, a.Sidecars[0].Args)
		}
	}
	// The pod runs as the IRSA-annotated KSA.
	if a.ServiceAccount != "alethia-app" ||
		a.ServiceAccountAnnotations["eks.amazonaws.com/role-arn"] != "arn:aws:iam::123456789012:role/rds-iam-auth-eks" {
		t.Errorf("AWS IRSA KSA wiring wrong: sa=%q annotations=%+v", a.ServiceAccount, a.ServiceAccountAnnotations)
	}
}

// TestKeyless_AlibabaExcluded: Alibaba ApsaraDB RDS has no token-based DB login → documented
// exclusion. An iam_auth db on Alibaba keeps the password path even with the flag on.
func TestKeyless_AlibabaExcluded(t *testing.T) {
	apps, _ := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
		Provider:      "alibaba",
		KeylessDBAuth: true,
		Databases:     []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(true)}},
		Outputs:       map[string]string{},
	})
	a := apps[0]
	if len(a.Sidecars) != 0 || len(a.SecretEnv) != 2 {
		t.Errorf("alibaba → password path (documented exclusion); sidecars=%+v secretEnv=%+v", a.Sidecars, a.SecretEnv)
	}
}

// TestKeyless_MissingConnectionName_FailsClosed: a keyless GCP binding with no connection-name output
// omits the WHOLE binding (no 127.0.0.1 pointed at an absent proxy) and reports it — fail-closed.
func TestKeyless_MissingConnectionName_FailsClosed(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
		Provider:      "gcp",
		KeylessDBAuth: true,
		Databases:     []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(true)}},
		Outputs:       map[string]string{"cloud_sql_iam_user": "orders-app@proj.iam"}, // no connection name
	})
	a := apps[0]
	if len(a.Sidecars) != 0 {
		t.Errorf("no proxy could be built → no sidecar, got %+v", a.Sidecars)
	}
	if _, ok := envValue(a.Env, "DATABASE_HOST"); ok {
		t.Error("fail-closed: endpoint must be omitted, not 127.0.0.1 with no proxy")
	}
	if len(skipped) == 0 || !strings.Contains(strings.Join(skipped, " "), "fail-closed") {
		t.Errorf("want a fail-closed report, got %v", skipped)
	}
}
