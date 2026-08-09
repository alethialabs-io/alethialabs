// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// tailBoolPtr is a pointer to a bool literal, for types.ProjectDatabaseConfig.IamAuth.
func tailBoolPtr(b bool) *bool { return &b }

// tailInstallFakeCell temporarily teaches the keyless table about a synthetic provider whose cell
// carries `state`. The real table has no pending and no unknown-state cell today, so this is the
// only way to exercise the gate's remaining arms — and those arms are precisely what protect the
// NEXT cloud added to the table from falling open.
func tailInstallFakeCell(t *testing.T, provider string, cell keylessCell) {
	t.Helper()
	if _, exists := keylessCells[provider]; exists {
		t.Fatalf("provider %q already exists in keylessCells — pick a synthetic name", provider)
	}
	keylessCells[provider] = map[string]keylessCell{enginePostgres: cell}
	t.Cleanup(func() { delete(keylessCells, provider) })
}

// ── keyless.go: the cell gate ────────────────────────────────────────────────────

// TestTail_KeylessCellSupportedRemainingStates covers the pending and unrecognised-state arms. A
// fail-closed table must never fall OPEN on a state nobody taught the gate about.
func TestTail_KeylessCellSupportedRemainingStates(t *testing.T) {
	t.Run("pending names the lane that will deliver it", func(t *testing.T) {
		tailInstallFakeCell(t, "tailpending", keylessCell{state: KeylessCellPending, reason: "lane #9999 delivers it"})
		err := keylessCellSupported("tailpending", enginePostgres)
		if err == nil || !strings.Contains(err.Error(), "not implemented yet") {
			t.Fatalf("keylessCellSupported = %v, want the pending refusal", err)
		}
		if !strings.Contains(err.Error(), "lane #9999") {
			t.Fatalf("the pending refusal dropped the cell's reason: %v", err)
		}
	})

	t.Run("an unrecognised state is refused, not defaulted", func(t *testing.T) {
		tailInstallFakeCell(t, "tailunknown", keylessCell{state: KeylessCellState("brand-new")})
		err := keylessCellSupported("tailunknown", enginePostgres)
		if err == nil || !strings.Contains(err.Error(), "unrecognised cell state") {
			t.Fatalf("keylessCellSupported = %v, want the unrecognised-state refusal", err)
		}
	})
}

// TestTail_KeylessMechanismNamesAnUnknownProviderHonestly covers the fallback arm: an
// unrecognised provider is STATED as unknown rather than guessed into a neighbour's mechanism.
func TestTail_KeylessMechanismNamesAnUnknownProviderHonestly(t *testing.T) {
	got := keylessMechanism("tailcloud", enginePostgres)
	if !strings.Contains(got, "unrecognised mechanism") || !strings.Contains(got, "tailcloud") {
		t.Fatalf("keylessMechanism = %q, want an honest unknown-mechanism sentence", got)
	}
}

// TestTail_KeylessDBTargetIgnoresUnmatchedDatabases covers the fall-through arm: a database target
// whose name matches no configured database is NOT keyless.
func TestTail_KeylessDBTargetIgnoresUnmatchedDatabases(t *testing.T) {
	dbs := []types.ProjectDatabaseConfig{{Name: "orders", IamAuth: tailBoolPtr(true)}}
	tgt := types.ServiceBindingTarget{Kind: "database", Name: "billing"}
	if KeylessDBTarget(tgt, dbs) {
		t.Fatal("KeylessDBTarget matched a database that is not in the project config")
	}
}

// TestTail_KeylessDBUsernameFailureArms covers both refusals: GCP without its IAM-user output, and
// a provider with no keyless login at all.
func TestTail_KeylessDBUsernameFailureArms(t *testing.T) {
	if _, err := keylessDBUsername(string(types.CloudProviderGcp), map[string]string{}); err == nil ||
		!strings.Contains(err.Error(), "cloud_sql_iam_user") {
		t.Fatalf("keylessDBUsername(gcp) error = %v, want the missing-output refusal", err)
	}
	if _, err := keylessDBUsername("tailcloud", nil); err == nil ||
		!strings.Contains(err.Error(), "not supported for provider") {
		t.Fatalf("keylessDBUsername(tailcloud) error = %v, want the unsupported-provider refusal", err)
	}
}

// TestTail_KeylessDBSidecarFailureArms covers the namespace guard (the Workload-Identity subject is
// pinned, so any other namespace can never authenticate) and the final fail-closed arm for a
// provider whose cell exists but has no wiring.
func TestTail_KeylessDBSidecarFailureArms(t *testing.T) {
	tgt := types.ServiceBindingTarget{Kind: "database", Name: "orders"}

	t.Run("wrong namespace", func(t *testing.T) {
		opts := Options{Namespace: "somewhere-else", Provider: providerAWS}
		if _, err := keylessDBSidecar(opts, tgt); err == nil ||
			!strings.Contains(err.Error(), "requires namespace") {
			t.Fatalf("keylessDBSidecar error = %v, want the namespace refusal", err)
		}
	})

	t.Run("cell with no wiring", func(t *testing.T) {
		tailInstallFakeCell(t, "tailwired", keylessCell{state: KeylessCellLive})
		opts := Options{Provider: "tailwired"}
		if _, err := keylessDBSidecar(opts, tgt); err == nil ||
			!strings.Contains(err.Error(), "not supported for provider") {
			t.Fatalf("keylessDBSidecar error = %v, want the fail-closed refusal", err)
		}
	})
}

// ── keyless_{aws,gcp,azure}.go: the per-cloud wiring gates ───────────────────────

// TestTail_AuthProxyWiringFailsClosedOnMissingOutputs covers every missing-tofu-output arm on all
// three clouds. A proxy pointed at an empty endpoint (or minting tokens for an empty region) would
// fail at CONNECT time in the cluster; these gates move that to deploy time.
func TestTail_AuthProxyWiringFailsClosedOnMissingOutputs(t *testing.T) {
	awsFull := map[string]string{
		endpointOutputKey(providerAWS, "database"): "db.cluster.example.rds.amazonaws.com",
		"aws_region":            "us-east-1",
		"rds_iam_auth_irsa_arn": "arn:aws:iam::123:role/app",
	}
	gcpFull := map[string]string{
		"cloud_sql_connection_name": "p:us-central1:inst",
		"cloud_sql_app_gsa_email":   "app@p.iam.gserviceaccount.com",
	}
	azureFull := map[string]string{
		"azure_db_fqdn":      "db.postgres.database.azure.com",
		"azure_db_client_id": "00000000-0000-0000-0000-000000000000",
	}

	tests := []struct {
		name  string
		wire  func(Options, string) (keylessWiring, error)
		outs  map[string]string
		drop  string
		image string
		want  string
	}{
		{"aws no endpoint", awsAuthProxyWiring, awsFull, endpointOutputKey(providerAWS, "database"), "runner:1", "rds_cluster_endpoint"},
		{"aws no region", awsAuthProxyWiring, awsFull, "aws_region", "runner:1", "aws_region"},
		{"aws no irsa role", awsAuthProxyWiring, awsFull, "rds_iam_auth_irsa_arn", "runner:1", "rds_iam_auth_irsa_arn"},
		{"aws no runner image", awsAuthProxyWiring, awsFull, "", "", "no runner image"},
		{"gcp no connection name", gcpProxyWiring, gcpFull, "cloud_sql_connection_name", "runner:1", "cloud_sql_connection_name"},
		{"gcp no app gsa", gcpProxyWiring, gcpFull, "cloud_sql_app_gsa_email", "runner:1", "cloud_sql_app_gsa_email"},
		{"azure no fqdn", azureAuthProxyWiring, azureFull, "azure_db_fqdn", "runner:1", "azure_db_fqdn"},
		{"azure no client id", azureAuthProxyWiring, azureFull, "azure_db_client_id", "runner:1", "azure_db_client_id"},
		{"azure no runner image", azureAuthProxyWiring, azureFull, "", "", "no runner image"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			outs := map[string]string{}
			for k, v := range tt.outs {
				if k == tt.drop {
					continue
				}
				outs[k] = v
			}
			_, err := tt.wire(Options{Outputs: outs, RunnerImage: tt.image}, enginePostgres)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("wiring error = %v, want %q", err, tt.want)
			}
		})
	}
}

// ── bootstrap_job.go ─────────────────────────────────────────────────────────────

// TestTail_RenderBootstrapJobRefusesAnExcludedCell covers the cell gate on the bootstrap lane: a
// cloud that can never honor keyless must produce the SAME reasoned refusal here as on the binding
// lane, never a Job that would wedge ArgoCD on a failing PreSync hook.
func TestTail_RenderBootstrapJobRefusesAnExcludedCell(t *testing.T) {
	opts := Options{Provider: providerHetzner, RunnerImage: "runner:1"}
	tgt := types.ServiceBindingTarget{Kind: "database", Name: "orders"}
	_, err := RenderBootstrapJob(opts, tgt)
	if err == nil || !strings.Contains(err.Error(), "Unavailable on Hetzner") {
		t.Fatalf("RenderBootstrapJob error = %v, want the Hetzner exclusion reason", err)
	}
}

// TestTail_RenderBootstrapJobRefusesAProviderWithNoSpec covers the default arm: a cell the table
// calls live but that has no bootstrap spec is refused rather than defaulted onto another cloud's.
func TestTail_RenderBootstrapJobRefusesAProviderWithNoSpec(t *testing.T) {
	tailInstallFakeCell(t, "tailboot", keylessCell{state: KeylessCellLive})
	opts := Options{Provider: "tailboot", RunnerImage: "runner:1"}
	tgt := types.ServiceBindingTarget{Kind: "database", Name: "orders"}
	_, err := RenderBootstrapJob(opts, tgt)
	if err == nil || !strings.Contains(err.Error(), "bootstrap is not supported for provider") {
		t.Fatalf("RenderBootstrapJob error = %v, want the unsupported-provider refusal", err)
	}
}

// TestTail_BootstrapSpecsFailClosedOnMissingOutputs covers every per-cloud missing-output arm of
// the bootstrap Job. Each one would otherwise emit a Job that cannot connect.
func TestTail_BootstrapSpecsFailClosedOnMissingOutputs(t *testing.T) {
	awsFull := map[string]string{
		endpointOutputKey(string(types.CloudProviderAws), "database"): "db.example.rds.amazonaws.com",
		"rds_database_name":                  "appdb",
		"rds_master_credentials_secret_name": "alethia/rds/master",
	}
	gcpFull := map[string]string{
		endpointOutputKey(string(types.CloudProviderGcp), "database"): "10.0.0.3",
		"cloud_sql_database":           "appdb",
		"cloud_sql_iam_user":           "app@p.iam",
		"cloud_sql_credentials_secret": "alethia-cloudsql-master",
	}
	azureFull := map[string]string{
		endpointOutputKey(string(types.CloudProviderAzure), "database"): "db.postgres.database.azure.com",
		"azure_db_name":            "appdb",
		"azure_db_admin_user":      "alethia-admin",
		"azure_db_admin_client_id": "00000000-0000-0000-0000-000000000001",
		"azure_db_app_oid":         "00000000-0000-0000-0000-000000000002",
	}

	tests := []struct {
		name     string
		provider string
		outs     map[string]string
		drop     string
		want     string
	}{
		{"aws no endpoint", string(types.CloudProviderAws), awsFull, endpointOutputKey(string(types.CloudProviderAws), "database"), "rds_cluster_endpoint"},
		{"aws no database name", string(types.CloudProviderAws), awsFull, "rds_database_name", "rds_database_name"},
		{"aws no master secret", string(types.CloudProviderAws), awsFull, "rds_master_credentials_secret_name", "rds_master_credentials_secret_name"},
		{"gcp no endpoint", string(types.CloudProviderGcp), gcpFull, endpointOutputKey(string(types.CloudProviderGcp), "database"), "cloud_sql_ip"},
		{"gcp no database", string(types.CloudProviderGcp), gcpFull, "cloud_sql_database", "cloud_sql_database"},
		{"gcp no iam user", string(types.CloudProviderGcp), gcpFull, "cloud_sql_iam_user", "cloud_sql_iam_user"},
		{"gcp no credentials secret", string(types.CloudProviderGcp), gcpFull, "cloud_sql_credentials_secret", "cloud_sql_credentials_secret"},
		{"azure no fqdn", string(types.CloudProviderAzure), azureFull, endpointOutputKey(string(types.CloudProviderAzure), "database"), "azure_db_fqdn"},
		{"azure no database name", string(types.CloudProviderAzure), azureFull, "azure_db_name", "azure_db_name"},
		{"azure no admin user", string(types.CloudProviderAzure), azureFull, "azure_db_admin_user", "azure_db_admin_user"},
		{"azure no admin client id", string(types.CloudProviderAzure), azureFull, "azure_db_admin_client_id", "azure_db_admin_client_id"},
		{"azure no app oid", string(types.CloudProviderAzure), azureFull, "azure_db_app_oid", "azure_db_app_oid"},
	}
	tgt := types.ServiceBindingTarget{Kind: "database", Name: "orders"}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			outs := map[string]string{}
			for k, v := range tt.outs {
				if k == tt.drop {
					continue
				}
				outs[k] = v
			}
			_, err := RenderBootstrapJob(Options{Provider: tt.provider, Outputs: outs, RunnerImage: "runner:1"}, tgt)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("RenderBootstrapJob error = %v, want %q", err, tt.want)
			}
		})
	}
}

// TestTail_AzureMySQLBootstrapNeedsTheAppClientID covers the MySQL arm's app-bind gate: without
// the app UAMI's client id there is no Entra login to CREATE AADUSER for.
func TestTail_AzureMySQLBootstrapNeedsTheAppClientID(t *testing.T) {
	opts := Options{
		Provider:    string(types.CloudProviderAzure),
		RunnerImage: "runner:1",
		Databases:   []types.ProjectDatabaseConfig{{Name: "orders", EngineFamily: engineMySQL, IamAuth: tailBoolPtr(true)}},
		Outputs: map[string]string{
			endpointOutputKey(string(types.CloudProviderAzure), "database"): "db.mysql.database.azure.com",
			"azure_db_name":            "appdb",
			"azure_db_admin_user":      "alethia-admin",
			"azure_db_admin_client_id": "00000000-0000-0000-0000-000000000001",
		},
	}
	tgt := types.ServiceBindingTarget{Kind: "database", Name: "orders"}
	_, err := RenderBootstrapJob(opts, tgt)
	if err == nil || !strings.Contains(err.Error(), "azure_db_client_id") {
		t.Fatalf("RenderBootstrapJob error = %v, want the app-client-id refusal", err)
	}
}

// TestTail_RenderAdminExternalSecretArms covers the no-store refusal (a cloud with no
// ClusterSecretStore cannot materialize the Job's admin credential) and the namespace default.
func TestTail_RenderAdminExternalSecretArms(t *testing.T) {
	if _, err := renderAdminExternalSecret("job-admin", "ns", providerHetzner, "remote"); err == nil ||
		!strings.Contains(err.Error(), "no ClusterSecretStore") {
		t.Fatalf("renderAdminExternalSecret error = %v, want the no-store refusal", err)
	}

	got, err := renderAdminExternalSecret("job-admin", "", string(types.CloudProviderAws), "remote")
	if err != nil {
		t.Fatalf("renderAdminExternalSecret: %v", err)
	}
	if !strings.Contains(got, "namespace: "+keylessKSANamespace) {
		t.Fatalf("an empty namespace did not default to %q:\n%s", keylessKSANamespace, got)
	}
}

// ── externalsecret.go ────────────────────────────────────────────────────────────

// TestTail_RenderExternalSecretIgnoresNonCredentialFacets covers the defensive skip and the
// resulting empty-data arm: a request carrying only non-secret facets renders NOTHING (those are
// the render-bindings lane's job), rather than an ExternalSecret with no data.
func TestTail_RenderExternalSecretIgnoresNonCredentialFacets(t *testing.T) {
	yaml, skipped, err := RenderExternalSecret(ExternalSecretParams{
		ServiceName: "api",
		Target:      types.ServiceBindingTarget{Kind: "database", Name: "orders"},
		Provider:    string(types.CloudProviderAws),
		RemoteKey:   "alethia/rds/master",
		Facets:      []string{"endpoint", "port"},
	})
	if err != nil {
		t.Fatalf("RenderExternalSecret: %v", err)
	}
	if yaml != "" {
		t.Fatalf("a non-credential-only request rendered an ExternalSecret:\n%s", yaml)
	}
	if len(skipped) != 0 {
		t.Fatalf("non-credential facets should be ignored silently, got %v", skipped)
	}
}

// TestTail_RenderExternalSecretSortsExtraLabels covers the label sort: two labels must render in a
// deterministic order, or the same binding produces a different manifest run to run.
func TestTail_RenderExternalSecretSortsExtraLabels(t *testing.T) {
	got, _, err := RenderExternalSecret(ExternalSecretParams{
		ServiceName: "api",
		Target:      types.ServiceBindingTarget{Kind: "database", Name: "orders"},
		Provider:    string(types.CloudProviderAws),
		RemoteKey:   "alethia/rds/master",
		Facets:      []string{"username", "password"},
		Labels:      map[string]string{"zeta": "2", "alpha": "1"},
	})
	if err != nil {
		t.Fatalf("RenderExternalSecret: %v", err)
	}
	if strings.Index(got, "alpha") > strings.Index(got, "zeta") {
		t.Fatalf("extra labels are not sorted:\n%s", got)
	}
}

// TestTail_RenderSecretBindingExternalSecretDefaultsAndSorts covers the namespace default and the
// label collection + sort on the project-secret lane.
func TestTail_RenderSecretBindingExternalSecretDefaultsAndSorts(t *testing.T) {
	got, err := RenderSecretBindingExternalSecret(SecretBindingExternalSecretParams{
		ServiceName: "api",
		Target:      types.ServiceBindingTarget{Kind: types.ServiceBindingKindSecret, Name: "stripe-key"},
		StoreName:   "secretstore-vault",
		RemoteKey:   "stripe-key",
		Property:    "value",
		Labels:      map[string]string{"zeta": "2", "alpha": "1"},
	})
	if err != nil {
		t.Fatalf("RenderSecretBindingExternalSecret: %v", err)
	}
	if !strings.Contains(got, "namespace: default") {
		t.Fatalf("an empty namespace did not default to `default`:\n%s", got)
	}
	if strings.Index(got, "alpha") > strings.Index(got, "zeta") {
		t.Fatalf("extra labels are not sorted:\n%s", got)
	}
}

// ── chart_bindings.go ────────────────────────────────────────────────────────────

// TestTail_ChartCredentialSecretOutputKeyIsEmptyForUnprovisionedKinds covers the default arm: a
// kind with no provisioned master secret has no remote key, so its credential facet is
// unsatisfiable rather than pointed at a secret that does not exist.
func TestTail_ChartCredentialSecretOutputKeyIsEmptyForUnprovisionedKinds(t *testing.T) {
	if got := chartCredentialSecretOutputKey("cache"); got != "" {
		t.Fatalf("chartCredentialSecretOutputKey(cache) = %q, want \"\"", got)
	}
}

// TestTail_ResolveChartWorkloadBindingsReportsEmptyValues covers the non-credential arm's
// fail-closed branch: an endpoint the outputs do not carry is reported UNSATISFIED, never patched
// in as an empty string the chart would then connect to.
func TestTail_ResolveChartWorkloadBindingsReportsEmptyValues(t *testing.T) {
	knob := ChartBindingKnob("database", "orders", "endpoint")
	res := ResolveChartWorkloadBindings(
		"api",
		[]types.ServiceBinding{{
			Target: types.ServiceBindingTarget{Kind: "database", Name: "orders"},
			Inject: []types.ServiceBindingInjection{{From: "endpoint", Env: "DATABASE_HOST"}},
		}},
		map[string]string{knob: "db.host"},
		map[string]string{}, // no endpoint output at all
		string(types.CloudProviderAws),
		"default",
		nil,
	)
	if len(res.Unsatisfied) != 1 || res.Unsatisfied[0] != knob {
		t.Fatalf("Unsatisfied = %v, want exactly %q", res.Unsatisfied, knob)
	}
	if _, patched := res.Patches["db.host"]; patched {
		t.Fatal("an unresolvable endpoint was patched into the chart values")
	}
}

// ── helm_keyless.go / registry_keyless.go ────────────────────────────────────────

// TestTail_RenderHelmRepoRefreshersRequiresPerRepoFields covers the per-refresher gate: a
// refresher missing its Secret name or repo URL cannot be rendered.
func TestTail_RenderHelmRepoRefreshersRequiresPerRepoFields(t *testing.T) {
	_, err := RenderHelmRepoRefreshers(
		[]HelmRepoRefresher{{RepoURL: "oci://123.dkr.ecr.us-east-1.amazonaws.com"}},
		"arn:aws:iam::123:role/helm", "runner:1")
	if err == nil || !strings.Contains(err.Error(), "secret name and repo URL are required") {
		t.Fatalf("RenderHelmRepoRefreshers error = %v, want the per-repo refusal", err)
	}
}

// TestTail_RenderRegistryRefresherSortsServiceAccountKeys covers sortedKV's comparator: two
// annotations must render in a deterministic order so a re-deploy is not a spurious diff.
func TestTail_RenderRegistryRefresherSortsServiceAccountKeys(t *testing.T) {
	got, err := RenderRegistryRefresher(RegistryRefresher{
		Provider: "aws", Namespace: "default", SecretName: "acme-pull",
		RegistryHost: "123.dkr.ecr.us-east-1.amazonaws.com", Region: "us-east-1",
		TargetRoleArn: "arn:aws:iam::456:role/pull", RunnerImage: "runner:1",
		SAAnnotations: map[string]string{"zeta.io/b": "2", "alpha.io/a": "1"},
	})
	if err != nil {
		t.Fatalf("RenderRegistryRefresher: %v", err)
	}
	if strings.Index(got, "alpha.io/a") > strings.Index(got, "zeta.io/b") {
		t.Fatalf("service-account annotations are not sorted:\n%s", got)
	}
}

// ── generate.go ──────────────────────────────────────────────────────────────────

// TestTail_AppNormalizeDefaults covers the name fallback (a name that sanitizes away becomes
// "app") and the probe-port default (a probe with no port inherits the container port).
func TestTail_AppNormalizeDefaults(t *testing.T) {
	a := App{Name: "!!!", Port: 9000, Probe: &types.ServiceProbe{Path: "/healthz"}}.normalize()
	if a.Name != "app" {
		t.Fatalf("Name = %q, want the \"app\" fallback", a.Name)
	}
	if a.Probe == nil || a.Probe.Port != 9000 {
		t.Fatalf("Probe = %+v, want the port defaulted to the container port", a.Probe)
	}
}

// TestTail_RenderPathsRefuseAnUnbuiltService covers RenderApp's image gate through
// GenerateManifests and WriteManifests: a repo-sourced service that was never BUILT has no
// resolved image, and every lane must refuse it rather than emit a Deployment with no image.
func TestTail_RenderPathsRefuseAnUnbuiltService(t *testing.T) {
	apps := []App{{Name: "api"}}
	if _, err := GenerateManifests(apps); err == nil ||
		!strings.Contains(err.Error(), "no container image") {
		t.Fatalf("GenerateManifests error = %v, want the missing-image refusal", err)
	}
	if _, err := WriteManifests(t.TempDir(), apps); err == nil ||
		!strings.Contains(err.Error(), "no container image") {
		t.Fatalf("WriteManifests error = %v, want the missing-image refusal", err)
	}
}

// TestTail_WriteManifestsFilesystemFailureArms covers the mkdir and write arms.
func TestTail_WriteManifestsFilesystemFailureArms(t *testing.T) {
	apps := []App{{Name: "api", Image: "ghcr.io/acme/api:1"}}

	t.Run("unusable output dir", func(t *testing.T) {
		blocker := filepath.Join(t.TempDir(), "not-a-dir")
		if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := WriteManifests(filepath.Join(blocker, "out"), apps); err == nil ||
			!strings.Contains(err.Error(), "mkdir") {
			t.Fatalf("WriteManifests error = %v, want the mkdir failure", err)
		}
	})

	t.Run("destination occupied by a directory", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dir, "api.yaml"), 0o755); err != nil {
			t.Fatal(err)
		}
		if _, err := WriteManifests(dir, apps); err == nil ||
			!strings.Contains(err.Error(), "write") {
			t.Fatalf("WriteManifests error = %v, want the write failure", err)
		}
	})
}

// TestTail_OutputKeyHelpersFailClosed covers the "" arms of the key/port helpers: an unknown
// provider-kind pair, an unknown backing kind, and a FIRST-CLASS target (no Address) asked for a
// BYO-IaC output name. Each returns "" so the facet resolves fail-closed.
func TestTail_OutputKeyHelpersFailClosed(t *testing.T) {
	if got := endpointOutputKey("tailcloud", "database"); got != "" {
		t.Fatalf("endpointOutputKey(tailcloud) = %q, want \"\"", got)
	}
	if got := defaultPort("blob", ""); got != "" {
		t.Fatalf("defaultPort(blob) = %q, want \"\"", got)
	}
	firstClass := types.ServiceBindingTarget{Kind: "database", Name: "orders"}
	if got := byoEndpointKey(firstClass); got != "" {
		t.Fatalf("byoEndpointKey(first-class) = %q, want \"\"", got)
	}
	if got := ByoCredentialOutputKey(firstClass); got != "" {
		t.Fatalf("ByoCredentialOutputKey(first-class) = %q, want \"\"", got)
	}
}

// TestTail_ByoCredentialSatisfiableNeedsAStore covers the ESO-store arm: a declared, resolving
// credential output is still unsatisfiable on a cloud with no ClusterSecretStore — mirroring
// RenderExternalSecret exactly, so the two lanes never disagree.
func TestTail_ByoCredentialSatisfiableNeedsAStore(t *testing.T) {
	tgt := types.ServiceBindingTarget{
		Kind: "database", Name: "orders", Address: "module.db.aws_db_instance.main",
		OutputKeys: &types.ServiceBindingOutputKeys{CredentialSecret: "db_master_secret"},
	}
	opts := Options{Provider: providerHetzner, Outputs: map[string]string{"db_master_secret": "alethia/db"}}
	if byoCredentialSatisfiable(opts, tgt, "username") {
		t.Fatal("a BYO credential was reported satisfiable on a cloud with no ClusterSecretStore")
	}
}

// TestTail_CellStateForIsEmptyForAnUnknownCell covers the error arm: an unknown cell is named ""
// rather than guessed, so the decision record cannot read as a live cell.
func TestTail_CellStateForIsEmptyForAnUnknownCell(t *testing.T) {
	if got := cellStateFor("tailcloud", enginePostgres); got != "" {
		t.Fatalf("cellStateFor(tailcloud) = %q, want \"\"", got)
	}
}

// TestTail_ResolveBindingsKeylessUsernameFailureIsReported covers the keyless username arm: the
// proxy wires fine, but GCP's IAM-user output is missing, so the username env is OMITTED and
// reported — never injected empty.
func TestTail_ResolveBindingsKeylessUsernameFailureIsReported(t *testing.T) {
	opts := Options{
		Provider:      providerGCP,
		KeylessDBAuth: true,
		Databases:     []types.ProjectDatabaseConfig{{Name: "orders", IamAuth: tailBoolPtr(true)}},
		Outputs: map[string]string{
			"cloud_sql_connection_name": "p:us-central1:inst",
			"cloud_sql_app_gsa_email":   "app@p.iam.gserviceaccount.com",
			// cloud_sql_iam_user deliberately absent.
		},
	}
	r := resolveBindings("api", opts, []types.ServiceBinding{{
		Target: types.ServiceBindingTarget{Kind: "database", Name: "orders"},
		Inject: []types.ServiceBindingInjection{{From: "username", Env: "DATABASE_USER"}},
	}})
	if len(r.env) != 0 {
		t.Fatalf("env = %+v, want no username injected when the identity output is missing", r.env)
	}
	if len(r.unresolved) == 0 || !strings.Contains(strings.Join(r.unresolved, " "), "cloud_sql_iam_user") {
		t.Fatalf("unresolved = %v, want the missing-identity report", r.unresolved)
	}
}

// TestTail_ResolveBindingsRejectsUnsupportedSecretFacets covers the secret-binding facet gate:
// only `value` is supported, and anything else is reported rather than pointed at a Secret key no
// ExternalSecret will ever write.
func TestTail_ResolveBindingsRejectsUnsupportedSecretFacets(t *testing.T) {
	opts := Options{
		Provider:     string(types.CloudProviderAws),
		SecretStores: map[string]SecretStoreRef{"stripe-key": {StoreName: "secretstore-vault", ValueProperty: "value"}},
	}
	r := resolveBindings("api", opts, []types.ServiceBinding{{
		Target: types.ServiceBindingTarget{Kind: types.ServiceBindingKindSecret, Name: "stripe-key"},
		Inject: []types.ServiceBindingInjection{{From: "password", Env: "STRIPE_KEY"}},
	}})
	if len(r.secretEnv) != 0 {
		t.Fatalf("secretEnv = %+v, want no reference for an unsupported facet", r.secretEnv)
	}
	if len(r.unresolved) == 0 || !strings.Contains(strings.Join(r.unresolved, " "), "only the `value` facet is supported") {
		t.Fatalf("unresolved = %v, want the unsupported-facet report", r.unresolved)
	}
}

// TestTail_ResolveBindingsReadsADeclaredByoPortOutput covers the BYO port arm: a customer module
// that exported a port output is read from it rather than defaulted to the kind's conventional
// port, which is the whole point of declaring one.
func TestTail_ResolveBindingsReadsADeclaredByoPortOutput(t *testing.T) {
	opts := Options{
		Provider: string(types.CloudProviderAws),
		Outputs:  map[string]string{"db_port": "15432"},
	}
	r := resolveBindings("api", opts, []types.ServiceBinding{{
		Target: types.ServiceBindingTarget{
			Kind: "database", Name: "orders", Address: "module.db.aws_db_instance.main",
			OutputKeys: &types.ServiceBindingOutputKeys{Port: "db_port"},
		},
		Inject: []types.ServiceBindingInjection{{From: "port", Env: "DATABASE_PORT"}},
	}})
	if len(r.env) != 1 || r.env[0].Value != "15432" {
		t.Fatalf("env = %+v, want the declared BYO port output (15432)", r.env)
	}
}
