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
	apps, skipped, _ := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
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
	apps, skipped, _ := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
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
	apps, _, _ := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
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
	apps, _, _ := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
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
	apps, skipped, _ := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
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

// TestKeyless_ExcludedCloudNeverSilentlyDowngrades: Alibaba ApsaraDB RDS has no token-based DB login
// and Hetzner's in-cluster databases have no identity plane → documented exclusions. The binding must
// fail CLOSED with the exclusion's reason.
//
// This test used to assert the opposite — that an `iam_auth: true` database on Alibaba quietly
// acquired a PASSWORD (`secretEnv` of length 2). That is the defect #1510 fixes, and it contradicted
// KeylessDBTarget's own doc comment ("must never quietly acquire a password"). A user who asked for
// keyless and silently got a password has no way to find out; a user whose deploy refuses, citing
// ApsaraDB's control-plane-only RAM, knows exactly what happened.
func TestKeyless_ExcludedCloudNeverSilentlyDowngrades(t *testing.T) {
	for _, provider := range []string{"alibaba", "hetzner"} {
		t.Run(provider, func(t *testing.T) {
			apps, skipped, _ := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
				Provider:      provider,
				KeylessDBAuth: true,
				Databases:     []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(true)}},
				Outputs:       map[string]string{},
			})
			a := apps[0]
			if len(a.Sidecars) != 0 {
				t.Errorf("an excluded cell renders no proxy, got %+v", a.Sidecars)
			}
			if len(a.SecretEnv) != 0 {
				t.Errorf("a db marked iam_auth must NOT acquire a password on an excluded cloud, got %+v", a.SecretEnv)
			}
			if _, ok := envValue(a.Env, "DATABASE_PASSWORD"); ok {
				t.Error("fail-closed: no password env on an excluded cell")
			}
			// The refusal must carry the product-voice reason, not a bare "unsupported".
			report := strings.Join(skipped, " ")
			if !strings.Contains(report, "fail-closed") || !strings.Contains(report, "keeps a generated password") {
				t.Errorf("want a fail-closed report carrying the cell's reason, got %v", skipped)
			}
		})
	}
}

// TestKeylessDBTarget_IsProviderBlind pins the split that makes that refusal possible: KeylessDBTarget
// answers "did the operator ask for this?" and nothing else. It used to answer "can we do it?" too, by
// returning false for alibaba/hetzner — which is how the downgrade became silent, since a `false` here
// routes the binding to the password path with no error raised anywhere.
func TestKeylessDBTarget_IsProviderBlind(t *testing.T) {
	dbs := []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(true)}}
	target := types.ServiceBindingTarget{Kind: "database", Name: "orders-db"}
	if !KeylessDBTarget(target, dbs) {
		t.Error("an iam_auth database is a keyless target regardless of cloud")
	}
	off := []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(false)}}
	if KeylessDBTarget(target, off) {
		t.Error("a password-auth database is not a keyless target")
	}
	if KeylessDBTarget(types.ServiceBindingTarget{Kind: "cache", Name: "orders-db"}, dbs) {
		t.Error("only database targets are keyless targets")
	}
}

// TestKeylessCellsTotal is the cloud-parity rule as a test. Absence used to mean "excluded", so
// alibaba and hetzner were excluded by not being written down — and the canvas, which could not read
// this table at all, went on offering the toggle for them. A cell nobody thought about must fail here
// rather than compile into a hole.
func TestKeylessCellsTotal(t *testing.T) {
	for _, cloud := range []string{providerAWS, providerGCP, providerAzure, providerAlibaba, providerHetzner} {
		for _, engine := range []string{enginePostgres, engineMySQL} {
			cell, ok := keylessCells[cloud][engine]
			if !ok {
				t.Errorf("%s × %s has no cell — every cloud the console can place a database on needs one", cloud, engine)
				continue
			}
			switch cell.state {
			case KeylessCellLive:
				if cell.reason != "" {
					t.Errorf("%s × %s is live but carries a reason %q — a reason is what a REFUSAL says", cloud, engine, cell.reason)
				}
			case KeylessCellPending, KeylessCellExcluded:
				if cell.reason == "" {
					t.Errorf("%s × %s is %q with no reason — the canvas and the deploy error would have nothing to show", cloud, engine, cell.state)
				}
			default:
				t.Errorf("%s × %s has unknown state %q", cloud, engine, cell.state)
			}
		}
	}
	// The list above is the five clouds a project can actually be placed on. It is deliberately NOT
	// types.AllCloudProviders, which carries `digitalocean` and `civo` — enum values with no project
	// template, so there is no keyless decision to make about them yet. The check that a PLACEABLE
	// cloud never goes missing lives in gen-keyless-cells.mjs, which fails when a CloudProviderSlug
	// has no cell: the slug union is the real placeable set and it only exists on the TypeScript side.
}

// TestKeyless_MissingConnectionName_FailsClosed: a keyless GCP binding with no connection-name output
// omits the WHOLE binding (no 127.0.0.1 pointed at an absent proxy) and reports it — fail-closed.
func TestKeyless_MissingConnectionName_FailsClosed(t *testing.T) {
	apps, skipped, _ := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
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
// --upstream flags read. It is tested directly, not only through a rendered cell, so a regression in
// the mapping is attributed here rather than surfacing as six confusing cell failures.
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

// TestKeylessCells_PerCloudPerEngine is the cloud × engine matrix: every cell renders a proxy wired to
// the ENGINE's port. This is the test that would have caught "MySQL renders a Postgres proxy on 5432" —
// the bug #1503 exists to fix.
//
// Every managed cell is implemented, so no row here fails closed. That path stays covered end to end by
// TestKeyless_MissingConnectionName_FailsClosed (a cell that cannot resolve its outputs) and at the gate
// itself by TestKeylessCellSupported_UnknownProviderOrEngine.
func TestKeylessCells_PerCloudPerEngine(t *testing.T) {
	cases := []struct {
		provider    string
		engine      string
		wantSidecar string
		wantPort    int
		wantArgs    []string
	}{
		{
			provider: "aws", engine: enginePostgres,
			wantSidecar: "db-authproxy", wantPort: 5432,
			wantArgs: []string{"--engine postgres", "--upstream orders.abc.rds.amazonaws.com:5432", "--listen 127.0.0.1:5432"},
		},
		{
			// Aurora-MySQL: #1504 template + `iam_database_authentication_enabled`, #1506's
			// AWSAuthenticationPlugin bootstrap SQL, #1507's mysql-client apply container. 3306 end to end.
			provider: "aws", engine: engineMySQL,
			wantSidecar: "db-authproxy", wantPort: 3306,
			wantArgs: []string{"--engine mysql", "--upstream orders.abc.rds.amazonaws.com:3306", "--listen 127.0.0.1:3306"},
		},
		{
			provider: "gcp", engine: enginePostgres,
			wantSidecar: "cloudsql-proxy", wantPort: 5432,
			wantArgs: []string{"--auto-iam-authn", "--port=5432"},
		},
		{
			// Cloud SQL MySQL: #1505's underscored `cloudsql_iam_authentication` flag. The native proxy
			// is engine-agnostic, so only the listener moves to 3306.
			provider: "gcp", engine: engineMySQL,
			wantSidecar: "cloudsql-proxy", wantPort: 3306,
			wantArgs: []string{"--auto-iam-authn", "--port=3306"},
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
			apps, skipped, _ := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
				Provider:      tc.provider,
				KeylessDBAuth: true,
				RunnerImage:   "ghcr.io/alethialabs-io/runner:1.2.3",
				Databases: []types.ProjectDatabaseConfig{
					{Name: "orders-db", EngineFamily: tc.engine, IamAuth: boolPtr(true)},
				},
				Outputs: keylessOutputsFor(tc.provider),
			})
			a := apps[0]

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
// rather than defaulting into a neighbouring cell's wiring — and an EXCLUDED cell is refused with the
// cell's own reason, so the sentence that answers "why not" is the whole message rather than being
// buried under our framing.
func TestKeylessCellSupported_UnknownProviderOrEngine(t *testing.T) {
	if err := keylessCellSupported("digitalocean", enginePostgres); err == nil {
		t.Error("an unlisted provider must be refused")
	}
	if err := keylessCellSupported("aws", "mariadb"); err == nil {
		t.Error("an unlisted engine must be refused")
	}
	if err := keylessCellSupported("azure", engineMySQL); err != nil {
		t.Errorf("azure/mysql is implemented, got %v", err)
	}
	for _, tc := range []struct{ provider, engine, want string }{
		{"hetzner", enginePostgres, hetznerKeylessExclusion},
		{"alibaba", enginePostgres, alibabaKeylessExclusion},
		{"alibaba", engineMySQL, alibabaKeylessExclusion},
	} {
		err := keylessCellSupported(tc.provider, tc.engine)
		if err == nil || err.Error() != tc.want {
			t.Errorf("keylessCellSupported(%q, %q) = %v, want the exclusion reason verbatim", tc.provider, tc.engine, err)
		}
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

// ── the keyless decision record (#1511) ───────────────────────────────────────────────────────

// findKeylessDecision returns the decision for one target, or the zero value.
func findKeylessDecision(ds []KeylessBindingDecision, target string) (KeylessBindingDecision, bool) {
	for _, d := range ds {
		if d.TargetName == target {
			return d, true
		}
	}
	return KeylessBindingDecision{}, false
}

// TestKeylessDecision_WiredIsRecorded is the assertion the whole record exists for: a keyless binding
// that WORKS must leave a positive trace. Before #1511 it left none — a successful binding wrote
// nothing at all, so "no fail-closed warning" and "keyless was never attempted" were the same
// observation, which is how a keyless path that had never authenticated to a real database went
// unnoticed (#1500).
func TestKeylessDecision_WiredIsRecorded(t *testing.T) {
	_, skipped, decisions := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
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
	d, ok := findKeylessDecision(decisions, "orders-db")
	if !ok {
		t.Fatalf("a WIRED keyless binding recorded no decision — %v", decisions)
	}
	if d.Status != KeylessBindingWired {
		t.Errorf("status = %q, want %q", d.Status, KeylessBindingWired)
	}
	if d.Service != "api" || d.TargetKind != "database" {
		t.Errorf("decision does not identify the binding: %+v", d)
	}
	if d.Engine != enginePostgres {
		t.Errorf("engine = %q, want %q — the engine is half the cell key", d.Engine, enginePostgres)
	}
	// The mechanism, not just the verdict: the two keyless mechanisms fail differently, so a record
	// that only said "wired" would send an operator to the wrong component.
	if !strings.Contains(d.Reason, "Cloud SQL Auth Proxy") {
		t.Errorf("wired reason %q does not name the mechanism", d.Reason)
	}
}

// TestKeylessDecision_FailedClosedCarriesTheCellReason: an excluded cell records the refusal AND the
// product-voice sentence the operator reads — the same string the canvas shows on the disabled
// toggle, because both read the cell table.
func TestKeylessDecision_FailedClosedCarriesTheCellReason(t *testing.T) {
	_, skipped, decisions := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
		Provider:      "hetzner",
		KeylessDBAuth: true,
		Databases:     []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(true)}},
	})
	if len(skipped) == 0 {
		t.Fatal("an excluded cell must still report the binding as unresolved")
	}
	d, ok := findKeylessDecision(decisions, "orders-db")
	if !ok {
		t.Fatalf("a fail-closed keyless binding recorded no decision — %v", decisions)
	}
	if d.Status != KeylessBindingFailedClosed {
		t.Errorf("status = %q, want %q", d.Status, KeylessBindingFailedClosed)
	}
	if d.Reason != hetznerKeylessExclusion {
		t.Errorf("reason = %q, want the cell's own exclusion prose %q", d.Reason, hetznerKeylessExclusion)
	}
}

// TestKeylessDecision_PasswordBindingRecordsNothing: the record is about keyless, not about bindings.
// A database the operator never marked `iam_auth` is not a keyless decision, and recording one would
// make the list unreadable as "every database that asked for keyless".
func TestKeylessDecision_PasswordBindingRecordsNothing(t *testing.T) {
	_, _, decisions := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
		Provider:      "aws",
		KeylessDBAuth: true,
		Databases:     []types.ProjectDatabaseConfig{{Name: "orders-db"}}, // no IamAuth
		Outputs:       map[string]string{"rds_endpoint": "db.example.com"},
	})
	if len(decisions) != 0 {
		t.Errorf("a password-auth database produced keyless decisions: %+v", decisions)
	}
}

// TestKeylessCell_ExportedAccessorAgreesWithTheGate pins the two readers of the cell table to each
// other. KeylessCell is what callers OUTSIDE this package see (the decision record, the T2 e2e lane
// table); keylessCellSupported is the internal render gate. If they could disagree, the e2e would
// happily try to prove a cell the renderer refuses — or worse, skip one it honors.
func TestKeylessCell_ExportedAccessorAgreesWithTheGate(t *testing.T) {
	for _, cloud := range []string{providerAWS, providerGCP, providerAzure, providerAlibaba, providerHetzner} {
		for _, engine := range []string{enginePostgres, engineMySQL} {
			state, reason, err := KeylessCell(cloud, engine)
			if err != nil {
				t.Errorf("KeylessCell(%s, %s) errored on a cell that exists: %v", cloud, engine, err)
				continue
			}
			gateOK := keylessCellSupported(cloud, engine) == nil
			if (state == KeylessCellLive) != gateOK {
				t.Errorf("%s × %s: KeylessCell says %q but the render gate says renderable=%v", cloud, engine, state, gateOK)
			}
			if state != KeylessCellLive && reason == "" {
				t.Errorf("%s × %s is %q with no reason — a refusal with nothing to show", cloud, engine, state)
			}
		}
	}
	// Fail-closed on the unknown: a typo'd provider must be an error, never a zero state that a
	// caller comparing against KeylessCellLive would read as "not live, carry on".
	if _, _, err := KeylessCell("nimbus", enginePostgres); err == nil {
		t.Error("KeylessCell accepted an unknown provider")
	}
	if _, _, err := KeylessCell(providerAWS, "cockroach"); err == nil {
		t.Error("KeylessCell accepted an unknown engine")
	}
}
