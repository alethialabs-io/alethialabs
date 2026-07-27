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

// TestKeyless_Azure_AuthProxy locks the Azure keyless path (#722, #1503): ONE self-contained
// `db-authproxy` sidecar, NO shared volume (the token never touches disk), app connects to 127.0.0.1
// with no password. Replaces the db-token + pgbouncer pair, which could never authenticate.
func TestKeyless_Azure_AuthProxy(t *testing.T) {
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
		t.Errorf("endpoint = %q, want 127.0.0.1 (the local auth proxy)", v)
	}
	if v, _ := envValue(a.Env, "DATABASE_USER"); v != "alethia_app" {
		t.Errorf("username = %q, want the least-priv bootstrap role alethia_app", v)
	}
	if len(a.SecretEnv) != 0 {
		t.Errorf("keyless must emit no secretKeyRef, got %+v", a.SecretEnv)
	}
	if len(a.Sidecars) != 1 || a.Sidecars[0].Name != "db-authproxy" {
		t.Fatalf("want exactly one db-authproxy sidecar, got %+v", a.Sidecars)
	}
	// The proxy mints in-process, so there is NOTHING to share — no emptyDir, no mount. A volume here
	// would mean the token-file path crept back in.
	if len(a.Volumes) != 0 {
		t.Fatalf("db-authproxy holds the token in memory → no volumes, got %+v", a.Volumes)
	}
	if len(a.Sidecars[0].Mounts) != 0 {
		t.Fatalf("db-authproxy needs no mounts, got %+v", a.Sidecars[0].Mounts)
	}
	if a.Sidecars[0].Image != "ghcr.io/alethialabs-io/runner:1.2.3" {
		t.Errorf("proxy must run the runner image, got %q", a.Sidecars[0].Image)
	}
	// Azure's Entra token is not region-signed — passing --region would be rejected as meaningless.
	if strings.Contains(strings.Join(a.Sidecars[0].Args, " "), "--region") {
		t.Errorf("azure must not pass --region: %v", a.Sidecars[0].Args)
	}
	// The pod runs as the Azure Workload-Identity KSA (labelled use=true, annotated client-id).
	if a.ServiceAccount != "alethia-app" ||
		a.ServiceAccountLabels["azure.workload.identity/use"] != "true" ||
		a.ServiceAccountAnnotations["azure.workload.identity/client-id"] != "11111111-2222-3333-4444-555555555555" {
		t.Errorf("Azure KSA wiring wrong: sa=%q labels=%+v annotations=%+v", a.ServiceAccount, a.ServiceAccountLabels, a.ServiceAccountAnnotations)
	}
	// …and the POD carries the label too. The azure-workload-identity webhook keys on the pod, not the
	// ServiceAccount: without this the proxy has no federated token to mint from, so keyless on Azure
	// could not authenticate no matter which proxy was rendered.
	if a.PodLabels["azure.workload.identity/use"] != "true" {
		t.Errorf("pod must carry the workload-identity label, got %+v", a.PodLabels)
	}
	yaml, err := RenderApp(a)
	if err != nil {
		t.Fatalf("RenderApp: %v", err)
	}
	if !strings.Contains(yaml, `azure.workload.identity/use: "true"`) {
		t.Error("rendered Deployment pod template is missing the workload-identity label")
	}
	// The SELECTOR must NOT gain the label: a Deployment's selector is immutable, so adding to it
	// breaks every in-place upgrade. (The label legitimately appears twice — on the emitted
	// ServiceAccount and on the pod template.)
	selector := yaml[strings.Index(yaml, "matchLabels:"):strings.Index(yaml, "template:")]
	if strings.Contains(selector, "azure.workload.identity/use") {
		t.Errorf("the WI label must not reach the immutable selector:\n%s", selector)
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

// TestKeyless_AWS_RDSIAMAuthProxy locks the AWS keyless path (#722 parity, #1503): RDS IAM auth uses
// the same single `db-authproxy` sidecar as Azure, with an IRSA-annotated KSA and a --region (the RDS
// token is region-signed, unlike Entra's).
func TestKeyless_AWS_RDSIAMAuthProxy(t *testing.T) {
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
		t.Errorf("endpoint = %q, want 127.0.0.1 (the local auth proxy)", v)
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
	if len(a.Sidecars) != 1 || a.Sidecars[0].Name != "db-authproxy" {
		t.Fatalf("want exactly one db-authproxy sidecar, got %+v", a.Sidecars)
	}
	if len(a.Volumes) != 0 {
		t.Fatalf("db-authproxy holds the token in memory → no volumes, got %+v", a.Volumes)
	}
	// The proxy mints an RDS auth token for the real endpoint/region/user. --upstream carries the
	// port because `db-authproxy` splits it with net.SplitHostPort and has no default.
	args := strings.Join(a.Sidecars[0].Args, " ")
	for _, want := range []string{
		"--provider aws", "--engine postgres",
		"--upstream orders.abc.rds.amazonaws.com:5432",
		"--listen 127.0.0.1:5432",
		"--region eu-central-1", "--user alethia_app",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("proxy args missing %q: %v", want, a.Sidecars[0].Args)
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

// TestEnginePort locks the engine→port mapping both the binding facet and the proxy's --listen /
// --upstream flags read. It is tested directly, not only through a rendered cell, so the MySQL branch
// stays covered while the aws/gcp MySQL cells are still gated off (#1504/#1505/#1506).
func TestEnginePort(t *testing.T) {
	cases := []struct {
		engine   string
		wantStr  string
		wantPort int
	}{
		{engineMySQL, "3306", 3306},
		{enginePostgres, "5432", 5432},
		{"", "5432", 5432}, // unset → postgres, the pre-MySQL default every old caller assumed
	}
	for _, tc := range cases {
		gotStr, gotInt := enginePort(tc.engine)
		if gotStr != tc.wantStr || gotInt != tc.wantPort {
			t.Errorf("enginePort(%q) = (%q, %d), want (%q, %d)", tc.engine, gotStr, gotInt, tc.wantStr, tc.wantPort)
		}
	}
	// The binding facet must agree with the proxy's listener, or the app dials a port nothing serves.
	if got := defaultPort("database", engineMySQL); got != "3306" {
		t.Errorf("defaultPort(database, mysql) = %q, want 3306", got)
	}
	if got := defaultPort("database", enginePostgres); got != "5432" {
		t.Errorf("defaultPort(database, postgres) = %q, want 5432", got)
	}
	// Engine is meaningless for the other kinds — they must be untouched.
	if got := defaultPort("cache", engineMySQL); got != "6379" {
		t.Errorf("defaultPort(cache, …) = %q, want 6379 regardless of engine", got)
	}
	if got := defaultPort("queue", engineMySQL); got != "5672" {
		t.Errorf("defaultPort(queue, …) = %q, want 5672 regardless of engine", got)
	}
}

// keylessOutputsFor returns the tofu outputs a keyless binding needs on each cloud.
func keylessOutputsFor(provider string) map[string]string {
	switch provider {
	case "aws":
		return map[string]string{
			"rds_cluster_endpoint":  "orders.abc.rds.amazonaws.com",
			"aws_region":            "eu-central-1",
			"rds_iam_auth_irsa_arn": "arn:aws:iam::123456789012:role/rds-iam-auth-eks",
		}
	case "gcp":
		return map[string]string{
			"cloud_sql_connection_name": "proj:us-central1:orders",
			"cloud_sql_iam_user":        "orders-app@proj.iam",
			"cloud_sql_app_gsa_email":   "orders-app@proj.iam.gserviceaccount.com",
		}
	case "azure":
		return map[string]string{
			"azure_db_fqdn":      "orders.mysql.database.azure.com",
			"azure_db_client_id": "11111111-2222-3333-4444-555555555555",
		}
	}
	return map[string]string{}
}

// TestKeylessCells_PerCloudPerEngine is the cloud × engine matrix: every cell either renders a proxy
// wired to the ENGINE's port, or fails closed naming the lane that will deliver it. This is the test
// that would have caught "MySQL renders a Postgres proxy on 5432" — the bug #1503 exists to fix.
func TestKeylessCells_PerCloudPerEngine(t *testing.T) {
	cases := []struct {
		provider    string
		engine      string
		wantSidecar string // "" → the cell must fail closed
		wantPort    int
		wantArgs    []string
		wantReason  string // substring of the fail-closed report
	}{
		{
			provider: "aws", engine: enginePostgres,
			wantSidecar: "db-authproxy", wantPort: 5432,
			wantArgs: []string{"--engine postgres", "--upstream orders.abc.rds.amazonaws.com:5432", "--listen 127.0.0.1:5432"},
		},
		{
			provider: "aws", engine: engineMySQL,
			wantReason: "#1504",
		},
		{
			provider: "gcp", engine: enginePostgres,
			wantSidecar: "cloudsql-proxy", wantPort: 5432,
			wantArgs: []string{"--auto-iam-authn", "--port=5432"},
		},
		{
			provider: "gcp", engine: engineMySQL,
			wantReason: "#1505",
		},
		{
			provider: "azure", engine: enginePostgres,
			wantSidecar: "db-authproxy", wantPort: 5432,
			wantArgs: []string{"--engine postgres", "--upstream orders.mysql.database.azure.com:5432", "--listen 127.0.0.1:5432"},
		},
		{
			// The one MySQL cell that is real today: Azure Flexible Server (#1435 template, #1448 SQL,
			// #1464 app identity, #1449 bootstrap Job). 3306 end to end.
			provider: "azure", engine: engineMySQL,
			wantSidecar: "db-authproxy", wantPort: 3306,
			wantArgs: []string{"--engine mysql", "--upstream orders.mysql.database.azure.com:3306", "--listen 127.0.0.1:3306"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.provider+"/"+tc.engine, func(t *testing.T) {
			apps, skipped := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
				Provider:      tc.provider,
				KeylessDBAuth: true,
				RunnerImage:   "ghcr.io/alethialabs-io/runner:1.2.3",
				Databases: []types.ProjectDatabaseConfig{
					{Name: "orders-db", EngineFamily: tc.engine, IamAuth: boolPtr(true)},
				},
				Outputs: keylessOutputsFor(tc.provider),
			})
			a := apps[0]

			if tc.wantSidecar == "" {
				// Fail closed: no sidecar, no endpoint pointed at an absent proxy, and a report that
				// names the lane — so an operator reads "not built yet, tracked in #N".
				if len(a.Sidecars) != 0 {
					t.Fatalf("unimplemented cell must render no proxy, got %+v", a.Sidecars)
				}
				if _, ok := envValue(a.Env, "DATABASE_HOST"); ok {
					t.Error("unimplemented cell must omit the endpoint, not point it at 127.0.0.1")
				}
				report := strings.Join(skipped, " ")
				if !strings.Contains(report, tc.wantReason) {
					t.Errorf("fail-closed report must name %s, got %v", tc.wantReason, skipped)
				}
				if !strings.Contains(report, "fail-closed") {
					t.Errorf("want a fail-closed report, got %v", skipped)
				}
				return
			}

			if len(skipped) != 0 {
				t.Fatalf("implemented cell must render cleanly, got %v", skipped)
			}
			if len(a.Sidecars) != 1 || a.Sidecars[0].Name != tc.wantSidecar {
				t.Fatalf("want one %s sidecar, got %+v", tc.wantSidecar, a.Sidecars)
			}
			if len(a.Sidecars[0].Ports) != 1 || a.Sidecars[0].Ports[0] != tc.wantPort {
				t.Errorf("containerPort = %v, want %d", a.Sidecars[0].Ports, tc.wantPort)
			}
			args := strings.Join(a.Sidecars[0].Args, " ")
			for _, want := range tc.wantArgs {
				if !strings.Contains(args, want) {
					t.Errorf("args missing %q: %v", want, a.Sidecars[0].Args)
				}
			}
			// The port the APP is told to dial must equal the port the proxy listens on. A mismatch
			// here is precisely the silent breakage this unit removes.
			port, ok := envValue(a.Env, "DATABASE_PORT")
			if !ok {
				t.Fatal("no DATABASE_PORT injected")
			}
			if wantStr, _ := enginePort(tc.engine); port != wantStr {
				t.Errorf("DATABASE_PORT = %q, want %q (the proxy's listener)", port, wantStr)
			}
			// Keyless means keyless, on every cell.
			if len(a.SecretEnv) != 0 {
				t.Errorf("keyless must emit no secretKeyRef, got %+v", a.SecretEnv)
			}
			if _, ok := envValue(a.Env, "DATABASE_PASSWORD"); ok {
				t.Error("keyless must NOT inject a password env")
			}
		})
	}
}

// TestKeylessCellSupported_UnknownProviderOrEngine: the gate refuses anything it does not know about
// rather than defaulting into a neighbouring cell's wiring.
func TestKeylessCellSupported_UnknownProviderOrEngine(t *testing.T) {
	if err := keylessCellSupported("hetzner", enginePostgres); err == nil {
		t.Error("an unlisted provider must be refused")
	}
	if err := keylessCellSupported("aws", "mariadb"); err == nil {
		t.Error("an unlisted engine must be refused")
	}
	if err := keylessCellSupported("azure", engineMySQL); err != nil {
		t.Errorf("azure/mysql is implemented, got %v", err)
	}
}

// TestUpstreamAddr: the platform endpoint outputs are host-only, but a host that already carries a
// port must pass through rather than become `[host:5432]:5432` — which the proxy would treat as a
// hostname with a colon and fail TLS verification against.
func TestUpstreamAddr(t *testing.T) {
	cases := []struct{ host, port, want string }{
		{"orders.abc.rds.amazonaws.com", "5432", "orders.abc.rds.amazonaws.com:5432"},
		{"orders.mysql.database.azure.com", "3306", "orders.mysql.database.azure.com:3306"},
		{"db.internal:5432", "3306", "db.internal:5432"}, // already qualified → authoritative
	}
	for _, tc := range cases {
		if got := upstreamAddr(tc.host, tc.port); got != tc.want {
			t.Errorf("upstreamAddr(%q, %q) = %q, want %q", tc.host, tc.port, got, tc.want)
		}
	}
}
