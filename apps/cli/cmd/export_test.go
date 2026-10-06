// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
)

// `alethia export` (#5531), driven at the exportClient seam with the SAME fake the plan and apply
// tests use — addonFake over diffFake — so the round trip is export and plan reading one server.

// exportFake is addonFake plus the reads export needs and plan does not already have.
type exportFake struct {
	addonFake
	settings   *api.ProjectSettings
	identities []api.CloudIdentity
	schema     *api.ComponentSchemaDocument
	charts     map[string][]api.ByoChart
	iac        map[string]*api.IacSource
	byoErr     error
	// fail makes the named read return its error, so every read's failure arm is reachable.
	fail map[string]error
}

// failed returns the injected error for a read, or nil.
func (f *exportFake) failed(name string) error { return f.fail[name] }

func (f *exportFake) GetConfigurations() ([]types.ConfigurationSummary, error) {
	if err := f.failed("configs"); err != nil {
		return nil, err
	}
	return f.diffFake.GetConfigurations()
}
func (f *exportFake) ListEnvironments(p string) ([]api.Environment, error) {
	if err := f.failed("envs"); err != nil {
		return nil, err
	}
	return f.diffFake.ListEnvironments(p)
}
func (f *exportFake) ListComponents(p, k, env string) ([]api.Component, error) {
	if err := f.failed("components"); err != nil {
		return nil, err
	}
	return f.diffFake.ListComponents(p, k, env)
}
func (f *exportFake) GetProjectAddons(p, env string) (*api.ProjectAddons, error) {
	if err := f.failed("addons"); err != nil {
		return nil, err
	}
	return f.addonFake.GetProjectAddons(p, env)
}
func (f *exportFake) GetAddonCatalog() (*api.AddonCatalogDocument, error) {
	if err := f.failed("catalog"); err != nil {
		return nil, err
	}
	return f.addonFake.GetAddonCatalog()
}

func (f *exportFake) GetProjectSettings(string) (*api.ProjectSettings, error) {
	return f.settings, f.failed("settings")
}
func (f *exportFake) GetCloudIdentities() ([]api.CloudIdentity, error) {
	return f.identities, f.failed("identities")
}
func (f *exportFake) GetComponentSchema() (*api.ComponentSchemaDocument, error) {
	return f.schema, f.failed("schema")
}
func (f *exportFake) GetProjectByoCharts(_, env string) (*api.ProjectByoCharts, error) {
	if f.byoErr != nil {
		return nil, f.byoErr
	}
	return &api.ProjectByoCharts{Environment: env, Charts: f.charts[env]}, nil
}
func (f *exportFake) GetProjectIacSource(_, env string) (*api.IacSource, error) {
	if f.byoErr != nil {
		return nil, f.byoErr
	}
	return f.iac[env], nil
}

// publishedSchema is the real published component registry, the fixture packages/core/api pins
// against the console's own builder — so the round trip validates against the kinds and fields the
// server actually publishes, not a composed copy.
func publishedSchema(t *testing.T) *api.ComponentSchemaDocument {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "core", "api", "testdata", "component_schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc api.ComponentSchemaDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return &doc
}

// The secrets every export test plants on the server. None may ever reach the file.
var exportPlantedSecrets = []string{"hunter2", "s3cr3t-value", "tok-from-row", "pg-admin-pw", "legacy-db-pw"}

// exportServer is "web" as the console holds it: two environments, components with server-managed
// and null fields, provider_config holding a credential stored before #5571, a secret component with
// its value in provider_config, a destroyed cache, and add-ons with a pin, a secret setting, an
// Advanced override carrying a password, and a disabled one.
func exportServer(t *testing.T) *exportFake {
	t.Helper()
	ci := "ci1"
	other := "ci2"
	rev := "2026-10-01T10:00:00.000Z"
	ns := "web-staging"
	return &exportFake{
		addonFake: addonFake{
			diffFake: diffFake{
				envs: []api.Environment{
					// Listed staging-first: the export puts the DEFAULT environment first regardless.
					{ID: "e2", Name: "staging", Stage: "staging", PlacementMode: "namespace", Namespace: &ns},
					{ID: "e1", Name: "prod", Stage: "production", PlacementMode: "dedicated", IsDefault: true},
				},
				comps: map[string][]api.Component{
					"prod": {
						{ID: "c1", Kind: "databases", Name: "orders", Status: "ACTIVE", UpdatedAt: &rev, Config: map[string]any{
							"engine": "postgres", "engine_version": "15", "max_capacity": float64(4), "min_capacity": 0.5,
							"port": float64(5432), "iam_auth": nil, "status": "ACTIVE", "endpoint": "orders.internal",
							"provider_config": map[string]any{
								"rds_backup_retention_period": float64(7),
								"rds_extra_credentials":       map[string]any{"username": "u", "password": "legacy-db-pw"},
								"rds_performance_insights":    nil,
							},
						}},
						{ID: "c0", Kind: "cluster", Name: "cluster", Status: "ACTIVE", CloudIdentityID: &ci, UpdatedAt: &rev, Config: map[string]any{
							"node_min_size": float64(1), "node_max_size": float64(3), "node_desired_size": nil,
							"instance_types": []any{"t3.large", "t3.xlarge"}, "cluster_endpoint": "https://k8s.internal",
							"provider_config": map[string]any{"eks_log_retention_days": float64(30), "hcloud_token": "hunter2"},
						}},
						{ID: "c2", Kind: "databases", Name: "carts", Status: "ACTIVE", CloudIdentityID: &other, Config: map[string]any{"engine": "postgres"}},
						{ID: "c3", Kind: "caches", Name: "old", Status: "DESTROYED", Config: map[string]any{"engine": "redis"}},
					},
					"staging": {
						{ID: "c4", Kind: "databases", Name: "orders", Status: "ACTIVE", Config: map[string]any{"engine": "postgres", "max_capacity": float64(1)}},
						{ID: "c5", Kind: "secrets", Name: "api-key", Status: "ACTIVE", Config: map[string]any{
							"provider": "aws", "generate": false, "provider_config": map[string]any{"value": "s3cr3t-value"},
						}},
						{ID: "c6", Kind: "repositories", Name: "repositories", Status: "ACTIVE", Config: map[string]any{
							"apps_destination_repo": "https://github.com/acme/apps", "apps_path": "overlays/staging",
						}},
					},
				},
			},
			catalog: addonCatalog(),
			addons: map[string][]api.Addon{
				"prod": {
					{AddonID: "loki", Enabled: false, Mode: "managed", Version: sptr("6.0.0")},
					{AddonID: "kube-prometheus-stack", Enabled: true, Mode: "managed", Version: sptr("58.2.1"),
						SecretKeys: []string{"grafanaAdminPassword"}, Settings: map[string]any{"retention": "10d"},
						ValuesYAML: sptr("grafana:\n  adminPassword: hunter2\n")},
					{AddonID: "external-dns", Enabled: true, Mode: "gitops", Version: sptr("1.15.0"), VersionPinned: true,
						SecretKeys: []string{"apiToken"},
						// A server that leaked a secret into the read: the export must still drop it.
						Settings: map[string]any{"provider": "cloudflare", "policy": "sync", "apiToken": "tok-from-row", "txtOwnerId": nil}},
					{AddonID: "cert-manager", Enabled: true, Mode: "managed", Version: sptr("1.14.4"), Settings: map[string]any{"installCRDs": true}},
				},
				"staging": {
					{AddonID: "cert-manager", Enabled: true, Mode: "managed", Version: sptr("1.14.4")},
				},
			},
		},
		settings:   &api.ProjectSettings{ID: "p1", ProjectName: "web", Region: "eu-west-1", IacVersion: "1.8.0", CloudIdentityID: &ci},
		identities: []api.CloudIdentity{{ID: "ci1", Provider: "aws", Label: "prod-account"}, {ID: "ci2", Provider: "aws", Label: "other"}},
		schema:     publishedSchema(t),
		charts:     map[string][]api.ByoChart{"prod": {{ChartPath: "charts/shop", Ref: "main", RepoURL: "https://user:pg-admin-pw@git.example.com/shop.git"}}},
		iac:        map[string]*api.IacSource{},
	}
}

// exportBytes runs the export and returns the file and what it said on stderr.
func exportBytes(t *testing.T, f exportClient, o exportOptions) ([]byte, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	if err := runExport(f, &out, &errOut, o, refusePick); err != nil {
		t.Fatalf("export: %v", err)
	}
	return out.Bytes(), errOut.String()
}

// refusePick is the picker under --no-input: the refusal promptExportEnvironment gives.
func refusePick(project string, envNames []string) (string, error) {
	return "", errors.New("several environments — pass --env or --all")
}

// planExported writes the exported file to a fresh directory and runs plan's own entry point on it —
// Load, Normalize, the schema and catalog Validate, computePlan — against the same fake server.
func planExported(t *testing.T, f *exportFake, data []byte) *ApplyPlan {
	t.Helper()
	path := filepath.Join(t.TempDir(), manifest.FileName)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	plan, err := planFromFile(f, path)
	if err != nil {
		t.Fatalf("plan refused the exported file: %v\n%s", err, data)
	}
	return plan
}

// assertNothingToDo fails on any create, update or problem anywhere in the plan.
func assertNothingToDo(t *testing.T, plan *ApplyPlan, data []byte) {
	t.Helper()
	if plan.ProjectID == "" {
		t.Errorf("plan would create the project")
	}
	envs, comps, updates := plan.counts()
	enable, change := plan.addonCounts()
	if envs+comps+updates+enable+change != 0 {
		t.Errorf("plan is not empty: %d envs, %d components to create, %d to update, %d add-ons to enable, %d to change", envs, comps, updates, enable, change)
	}
	for _, e := range plan.Environments {
		if e.Action != ActionUnchanged || len(e.Problems) > 0 {
			t.Errorf("%s: %s %v", e.Name, e.Action, e.Problems)
		}
		for _, c := range e.Components {
			if c.Action != ActionUnchanged {
				t.Errorf("%s %s: %s %+v", e.Name, componentLabel(c), c.Action, c.Changes)
			}
		}
		for _, a := range e.Addons {
			if a.Action != ActionUnchanged {
				t.Errorf("%s add-on %s: %s %+v", e.Name, a.ID, a.Action, a.Changes)
			}
		}
	}
	if t.Failed() {
		t.Logf("exported file:\n%s", data)
	}
}

// ── item 3: the round trip ────────────────────────────────────────────────────────────────

// TestExport_RoundTripPlansNoChanges is the acceptance test: export a project, run plan on the file
// against the same server, and plan has nothing to do — no create, no update, no problem, for every
// environment, component and add-on.
func TestExport_RoundTripPlansNoChanges(t *testing.T) {
	f := exportServer(t)
	data, _ := exportBytes(t, f, exportOptions{project: "web", all: true})
	plan := planExported(t, f, data)
	assertNothingToDo(t, plan, data)
	if len(plan.Environments) != 2 || len(plan.Unmanaged) != 0 {
		t.Errorf("plan covered %d environments (unmanaged %v), want both", len(plan.Environments), plan.Unmanaged)
	}
	// Plan did read what the file declares — a vacuous round trip over an empty file proves nothing.
	if n := len(plan.Environments[0].Components) + len(plan.Environments[1].Components); n != 6 {
		t.Errorf("plan compared %d components, want 6 (cluster, 2 databases in prod; database, secret, repositories in staging)", n)
	}
	if n := len(plan.Environments[0].Addons); n != 3 {
		t.Errorf("plan compared %d add-ons in prod, want 3 (loki is disabled)", n)
	}
	// The disabled add-on is unmanaged — listed by plan, not a change.
	if got := plan.Environments[0].UnmanagedAddons; len(got) != 1 || got[0] != "loki" {
		t.Errorf("unmanaged add-ons = %v, want [loki]", got)
	}
}

// One environment exported on its own round-trips too, and the others are left as unmanaged.
func TestExport_OneEnvironmentRoundTrips(t *testing.T) {
	f := exportServer(t)
	data, stderr := exportBytes(t, f, exportOptions{project: "web", env: "staging"})
	plan := planExported(t, f, data)
	assertNothingToDo(t, plan, data)
	if len(plan.Environments) != 1 || plan.Environments[0].Name != "staging" {
		t.Fatalf("exported %+v, want staging alone", plan.Environments)
	}
	if len(plan.Unmanaged) != 1 || plan.Unmanaged[0] != "prod" {
		t.Errorf("unmanaged = %v, want [prod]", plan.Unmanaged)
	}
	if !strings.Contains(string(data), "environments prod — not exported") || !strings.Contains(stderr, "environments prod") {
		t.Errorf("the environment left out is not named:\n%s\nstderr:\n%s", data, stderr)
	}
}

// ── item 4: no secrets ────────────────────────────────────────────────────────────────────

func TestExport_NeverWritesASecret(t *testing.T) {
	f := exportServer(t)
	data, stderr := exportBytes(t, f, exportOptions{project: "web", all: true})
	out := string(data)
	for _, s := range exportPlantedSecrets {
		if strings.Contains(out, s) || strings.Contains(stderr, s) {
			t.Errorf("the export carries the planted secret %q", s)
		}
	}
	// The keys holding them are absent as keys: a credential provider_config key, a secret setting,
	// the Advanced override, a component's credential reference, a secret component's value.
	m, err := manifest.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range m.Environments {
		for _, k := range e.Components {
			for _, c := range k.Entries {
				if _, ok := c.Fields["cloud_identity_id"]; ok {
					t.Errorf("%s %s carries cloud_identity_id", e.Name, k.Kind)
				}
				pc, _ := c.Fields["provider_config"].(map[string]any)
				for key := range pc {
					if isCredentialKeyName(key) || key == "value" {
						t.Errorf("%s %s provider_config carries %s", e.Name, k.Kind, key)
					}
				}
			}
		}
		for _, a := range e.Addons {
			if a.Values != nil || a.ValuesFile != nil {
				t.Errorf("%s add-on %s carries an override", e.Name, a.ID)
			}
			if _, ok := a.Settings["apiToken"]; ok {
				t.Errorf("%s external-dns carries its secret setting", e.Name)
			}
		}
	}
	// What was left out is SAID, by name only.
	for _, want := range []string{
		"provider_config hcloud_token: a credential",
		"provider_config rds_extra_credentials: a credential",
		"provider_config value: a credential",
		"secret settings (apiToken)",
		"kube-prometheus-stack — its Advanced values override is not written",
		"prod databases/carts — uses its own cloud account",
		"prod caches/old — destroyed",
		"prod add-on loki — disabled",
		"prod BYO chart charts/shop@main",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("the header does not say %q:\n%s", want, out)
		}
	}
}

// A component field the published schema marks `writeOnly` is a secret field, and is not written.
func TestExport_SchemaSecretFieldIsNotWritten(t *testing.T) {
	f := exportServer(t)
	for i, k := range f.schema.Kinds {
		if k.Kind != "databases" {
			continue
		}
		f.schema.Kinds[i].Fields = append(k.Fields, "master_secret")
		props, _ := stringKeyed(k.Schema["properties"])
		props["master_secret"] = map[string]any{"type": "string", "writeOnly": true}
	}
	f.comps["prod"][0].Config["master_secret"] = "pg-admin-pw"
	data, _ := exportBytes(t, f, exportOptions{project: "web", env: "prod"})
	if strings.Contains(string(data), "pg-admin-pw") {
		t.Fatalf("a writeOnly field reached the file:\n%s", data)
	}
	if !strings.Contains(string(data), "master_secret is a secret field") {
		t.Errorf("the left-out secret field is not named:\n%s", data)
	}
	assertNothingToDo(t, planExported(t, f, data), data)
}

func TestIsCredentialKeyName(t *testing.T) {
	for name, want := range map[string]bool{
		"hcloud_token": true, "dbPassword": true, "APIKey": true, "DB_PASSWORD": true, "db.password": true,
		"rds_extra_credentials": true, "client-secret": true, "private_key_pem": true, "Rds_Extra_Credentials ": true,
		"password_encryption": true, "eks_log_retention_days": false, "tokenizer": false, "apps_path": false,
		"keyring": false, "secret_name": false,
	} {
		if got := isCredentialKeyName(name); got != want {
			t.Errorf("isCredentialKeyName(%q) = %v, want %v (normalized %q)", name, got, want, normalizeKeyName(name))
		}
	}
}

// ── item 2: the file itself ───────────────────────────────────────────────────────────────

// The YAML, byte for byte, for one environment: the account by LABEL, the default-environment rules,
// schema field filtering (no endpoint, no status, no nulls), whole numbers as ints, the pin, the
// mode, the non-secret settings.
func TestExport_WritesTheManifest(t *testing.T) {
	f := exportServer(t)
	data, _ := exportBytes(t, f, exportOptions{project: "web", env: "prod"})
	body := string(data)
	i := strings.Index(body, "\nproject:")
	if i < 0 {
		t.Fatalf("no manifest after the header:\n%s", body)
	}
	const want = `project: web
cloud:
  account: prod-account
  region: eu-west-1
iac:
  version: 1.8.0
environments:
  - name: prod
    stage: production
    placement: dedicated
    components:
      cluster:
        instance_types:
          - t3.large
          - t3.xlarge
        node_max_size: 3
        node_min_size: 1
        provider_config:
          eks_log_retention_days: 30
      databases:
        - engine: postgres
          name: carts
        - engine: postgres
          engine_version: "15"
          max_capacity: 4
          min_capacity: 0.5
          name: orders
          port: 5432
          provider_config:
            rds_backup_retention_period: 7
    addons:
      - id: cert-manager
        mode: managed
        settings:
          installCRDs: true
      - id: external-dns
        version: 1.15.0
        mode: gitops
        settings:
          policy: sync
          provider: cloudflare
      - id: kube-prometheus-stack
        mode: managed
        settings:
          retention: 10d
`
	if got := body[i+1:]; got != want {
		t.Errorf("manifest =\n%s\nwant\n%s", got, want)
	}
	if !strings.HasPrefix(body, "# alethia.yaml for project web, written by `alethia export`.") {
		t.Errorf("header:\n%s", body)
	}
}

// Deterministic: the server listing environments, components and add-ons in another order gives the
// same bytes, so a re-export diff shows only what changed.
func TestExport_IsDeterministic(t *testing.T) {
	a, _ := exportBytes(t, exportServer(t), exportOptions{project: "web", all: true})
	f := exportServer(t)
	f.envs[0], f.envs[1] = f.envs[1], f.envs[0]
	prod := f.comps["prod"]
	for i, j := 0, len(prod)-1; i < j; i, j = i+1, j-1 {
		prod[i], prod[j] = prod[j], prod[i]
	}
	rows := f.addons["prod"]
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	for i := 0; i < 5; i++ {
		b, _ := exportBytes(t, f, exportOptions{project: "web", all: true})
		if !bytes.Equal(a, b) {
			t.Fatalf("a re-export differs:\n%s\n---\n%s", a, b)
		}
	}
}

// ── --env, --all, --out ───────────────────────────────────────────────────────────────────

func TestExport_SeveralEnvironmentsNeedAChoice(t *testing.T) {
	f := exportServer(t)
	err := runExport(f, &bytes.Buffer{}, &bytes.Buffer{}, exportOptions{project: "web"}, refusePick)
	if err == nil || !strings.Contains(err.Error(), "--env") {
		t.Errorf("several environments and no flag must be refused, got %v", err)
	}
	// The non-terminal refusal names both flags and every environment.
	noInputMode = true
	t.Cleanup(func() { noInputMode = false })
	_, err = promptExportEnvironment("web", []string{"prod", "staging"})
	if err == nil || !strings.Contains(err.Error(), "--env <name>") || !strings.Contains(err.Error(), "--all") || !strings.Contains(err.Error(), "prod, staging") {
		t.Errorf("refusal = %v", err)
	}
	// A picker's answer is honoured, "every environment" included.
	for choice, want := range map[string]int{"staging": 1, exportAllEnvironments: 2} {
		pick := func(string, []string) (string, error) { return choice, nil }
		var out bytes.Buffer
		if err := runExport(f, &out, &bytes.Buffer{}, exportOptions{project: "web"}, pick); err != nil {
			t.Fatal(err)
		}
		m, _ := manifest.Parse(out.Bytes())
		if len(m.Environments) != want {
			t.Errorf("picked %q: exported %d environments, want %d", choice, len(m.Environments), want)
		}
	}
	// A single-environment project needs no choice.
	f.envs = f.envs[1:]
	if _, err := buildExport(f, exportOptions{project: "web"}, refusePick); err != nil {
		t.Errorf("one environment needs no --env: %v", err)
	}
}

func TestExport_UnknownEnvironmentAndProject(t *testing.T) {
	f := exportServer(t)
	_, err := buildExport(f, exportOptions{project: "web", env: "qa"}, refusePick)
	if err == nil || !strings.Contains(err.Error(), `"qa" not found`) || !strings.Contains(err.Error(), "prod, staging") {
		t.Errorf("unknown env: %v", err)
	}
	_, err = buildExport(f, exportOptions{project: "shop", all: true}, refusePick)
	if err == nil || !strings.Contains(err.Error(), `"shop" not found (have: web)`) {
		t.Errorf("unknown project: %v", err)
	}
	if _, err := buildExport(f, exportOptions{project: "p1", env: "e1"}, refusePick); err != nil {
		t.Errorf("a project and an environment by id: %v", err)
	}
	if err := (exportOptions{env: "prod", all: true}).check(); err == nil {
		t.Error("--env with --all must be refused")
	}
}

func TestExport_OutRefusesToOverwriteWithoutForce(t *testing.T) {
	f := exportServer(t)
	path := filepath.Join(t.TempDir(), manifest.FileName)
	if err := os.WriteFile(path, []byte("project: mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	err := runExport(f, &bytes.Buffer{}, &stderr, exportOptions{project: "web", all: true, out: path}, refusePick)
	if err == nil || !strings.Contains(err.Error(), "--force") {
		t.Errorf("an existing --out must be refused without --force: %v", err)
	}
	if raw, _ := os.ReadFile(path); string(raw) != "project: mine\n" {
		t.Errorf("the file was touched: %q", raw)
	}
	var stdout bytes.Buffer
	if err := runExport(f, &stdout, &stderr, exportOptions{project: "web", all: true, out: path, force: true}, refusePick); err != nil {
		t.Fatal(err)
	}
	if stdout.Len() != 0 {
		t.Errorf("with --out, stdout carries nothing: %q", stdout.String())
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "project: web") || !strings.Contains(stderr.String(), "Wrote "+path) {
		t.Errorf("file %q, stderr %q", raw, stderr.String())
	}
}

// A BYO read that fails is said, never read as "nothing attached".
func TestExport_ByoReadFailureIsNoted(t *testing.T) {
	f := exportServer(t)
	f.byoErr = errors.New("402 plan required")
	data, _ := exportBytes(t, f, exportOptions{project: "web", env: "prod"})
	if !strings.Contains(string(data), "prod BYO charts — could not be read (402 plan required)") ||
		!strings.Contains(string(data), "prod BYO IaC — could not be read (402 plan required)") {
		t.Errorf("header:\n%s", data)
	}
	f.byoErr = nil
	f.iac["prod"] = &api.IacSource{Name: "vpc-extras", Path: "infra/extras"}
	data, _ = exportBytes(t, f, exportOptions{project: "web", env: "prod"})
	if !strings.Contains(string(data), "prod BYO IaC vpc-extras (infra/extras) — BYO IaC is not exported yet") {
		t.Errorf("header:\n%s", data)
	}
}

// The account is a label when that names it, an id when the label is shared, and absent when this
// organization cannot see it.
func TestExportAccount(t *testing.T) {
	ids := []api.CloudIdentity{{ID: "a", Label: "prod"}, {ID: "b", Label: "prod"}, {ID: "c", Label: "dev"}, {ID: "d"}}
	for id, want := range map[string]string{"c": "dev", "a": "a", "d": "d", "zz": ""} {
		got, _ := exportAccount(ids, id)
		if got != want {
			t.Errorf("exportAccount(%s) = %q, want %q", id, got, want)
		}
	}
}

// Every read the export makes can fail, and each failure stops it with the read named — an export
// that carried on would write a file missing whatever the failed read held, as if it had nothing.
func TestExport_AReadThatFailsStopsTheExport(t *testing.T) {
	for read, want := range map[string]string{
		"configs":    "list projects: boom",
		"settings":   "boom",
		"identities": "list cloud accounts: boom",
		"envs":       "list environments of web: boom",
		"components": "list components of prod: boom",
		"schema":     "boom",
		"addons":     "list add-ons of prod: boom",
		"catalog":    "boom",
	} {
		f := exportServer(t)
		f.fail = map[string]error{read: errors.New("boom")}
		var out bytes.Buffer
		err := runExport(f, &out, &bytes.Buffer{}, exportOptions{project: "web", env: "prod"}, refusePick)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s failing: err = %v, want %q", read, err, want)
		}
		if out.Len() != 0 {
			t.Errorf("%s failing: a partial file was written", read)
		}
	}
	// A refused flag combination, and an --out that cannot be written.
	f := exportServer(t)
	if err := runExport(f, &bytes.Buffer{}, &bytes.Buffer{}, exportOptions{project: "web", env: "prod", all: true}, refusePick); err == nil {
		t.Error("--env with --all must be refused")
	}
	bad := filepath.Join(t.TempDir(), "missing", manifest.FileName)
	if err := runExport(f, &bytes.Buffer{}, &bytes.Buffer{}, exportOptions{project: "web", env: "prod", out: bad}, refusePick); err == nil || !strings.Contains(err.Error(), "write ") {
		t.Errorf("an unwritable --out: %v", err)
	}
}

func TestMatchExportProject(t *testing.T) {
	if _, err := matchExportProject(nil, "web"); err == nil || !strings.Contains(err.Error(), "no projects") {
		t.Errorf("empty org: %v", err)
	}
	two := []types.ConfigurationSummary{{ID: "p1", ProjectName: "Web"}, {ID: "p2", ProjectName: "web"}}
	if _, err := matchExportProject(two, "WEB"); err == nil || !strings.Contains(err.Error(), "matches 2 projects") {
		t.Errorf("two projects one name: %v", err)
	}
	if got, err := matchExportProject(two, "p2"); err != nil || got.ID != "p2" {
		t.Errorf("by id: %+v %v", got, err)
	}
}

func TestOrderEnvironmentsAndNoEnvironments(t *testing.T) {
	got := orderEnvironments([]api.Environment{{Name: "qa"}, {Name: "dev"}, {Name: "prod", IsDefault: true}})
	if got[0].Name != "prod" || got[1].Name != "dev" || got[2].Name != "qa" {
		t.Errorf("order = %+v, want prod (default), then by name", got)
	}
	if _, err := chooseEnvironments("web", nil, exportOptions{all: true}, refusePick); err == nil {
		t.Error("a project with no environments has nothing to export")
	}
}

// The terminal picker offers every environment and "every environment", and returns the answer.
func TestPromptExportEnvironment_OnATerminal(t *testing.T) {
	projTTY(t)
	prev := runHuhForm
	t.Cleanup(func() { runHuhForm = prev })
	var asked int
	runHuhForm = func(groups ...*huh.Group) error {
		asked = len(groups)
		return nil
	}
	got, err := promptExportEnvironment("web", []string{"prod", "staging"})
	if err != nil || got != "prod" || asked != 1 {
		t.Errorf("picker: %q %v (asked %d groups)", got, err, asked)
	}
}

// The shapes the server can hand back that the file cannot say are noted, not written: an unknown
// kind, two rows of a one-per-environment kind, a provider_config that is not a mapping, an add-on
// the catalog does not publish, and settings the catalog does not declare.
func TestExport_ShapesTheFileCannotSay(t *testing.T) {
	f := exportServer(t)
	f.comps["staging"] = []api.Component{
		{Kind: "lasers", Name: "pew", Status: "ACTIVE", Config: map[string]any{}},
		{Kind: "cluster", Name: "a", Status: "ACTIVE", Config: map[string]any{"node_min_size": float64(1)}},
		{Kind: "cluster", Name: "b", Status: "ACTIVE", Config: map[string]any{"node_min_size": float64(2)}},
		{Kind: "databases", Name: "odd", Status: "ACTIVE", Config: map[string]any{"provider_config": "not-a-map"}},
		{Kind: "databases", Name: "nested", Status: "ACTIVE", Config: map[string]any{
			"provider_config": map[string]any{"rds_parameters": map[string]any{"max_connections": float64(100)}},
		}},
	}
	f.catalog.Addons[0].Settings = []string{"installCRDs"}
	f.addons["staging"] = []api.Addon{
		{AddonID: "cert-manager", Enabled: true, Mode: "managed", Settings: map[string]any{"installCRDs": true, "stale": "x"}},
		{AddonID: "retired", Enabled: true, Mode: "managed"},
	}
	data, _ := exportBytes(t, f, exportOptions{project: "web", env: "staging"})
	out := string(data)
	for _, want := range []string{
		`staging lasers/pew — the published component schema has no kind "lasers"`,
		"staging cluster — the server holds 2 of this one-per-environment kind",
		"staging databases/odd — provider_config is not a mapping",
		"staging add-on retired — not in the published add-on catalog",
		"staging add-on cert-manager — stored settings stale are not ones the catalog declares",
		"max_connections: 100",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q:\n%s", want, out)
		}
	}
	assertNothingToDo(t, planExported(t, f, data), data)
}

// An environment with no components and no add-ons is declared bare, and a schema property that is
// not described is not a secret.
func TestExport_ABareEnvironment(t *testing.T) {
	f := exportServer(t)
	f.comps["staging"] = nil
	f.addons["staging"] = nil
	data, _ := exportBytes(t, f, exportOptions{project: "web", env: "staging"})
	if !strings.Contains(string(data), "  - name: staging\n    stage: staging\n    placement: namespace\n    namespace: web-staging\n") {
		t.Errorf("bare environment:\n%s", data)
	}
	assertNothingToDo(t, planExported(t, f, data), data)
	if schemaMarksSecret(api.ComponentSchemaKind{}, "x") {
		t.Error("a kind with no properties marks nothing secret")
	}
	if schemaMarksSecret(api.ComponentSchemaKind{Schema: map[string]any{"properties": map[string]any{"x": true}}}, "x") {
		t.Error("a property that is not a schema object marks nothing secret")
	}
}

// exportCLI runs `alethia export` through the real cobra tree against an httptest control plane
// built from exportServer's data — the path the Run function, the flags and the real api.Client take.
func exportCLI(t *testing.T) func(args ...string) (string, bool) {
	t.Helper()
	credsPath := isolatedHome(t)
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: makeToken(t, time.Now().Add(time.Hour)), RefreshToken: "r"}); err != nil {
		t.Fatal(err)
	}
	f := exportServer(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		enc := json.NewEncoder(w)
		p := r.URL.Path
		env := r.URL.Query().Get("env")
		switch {
		case p == "/api/cli/configurations":
			_ = enc.Encode(map[string]any{"configurations": []map[string]any{{"id": "p1", "project_name": "web"}}})
		case strings.HasPrefix(p, "/api/cli/configurations/by-project-name/"):
			_ = enc.Encode(map[string]any{"configuration": f.settings})
		case p == "/api/cli/cloud-identities":
			_ = enc.Encode(map[string]any{"cloud_identities": f.identities})
		case p == "/api/cli/schema/components":
			_ = enc.Encode(f.schema)
		case p == "/api/cli/schema/addons":
			_ = enc.Encode(f.catalog)
		case strings.HasSuffix(p, "/environments"):
			_ = enc.Encode(map[string]any{"environments": f.envs})
		case strings.HasSuffix(p, "/components"):
			_ = enc.Encode(map[string]any{"components": f.comps[env]})
		case strings.HasSuffix(p, "/addons"):
			_ = enc.Encode(map[string]any{"environment": env, "addons": f.addons[env]})
		case strings.HasSuffix(p, "/byo-charts"):
			_ = enc.Encode(map[string]any{"environment": env, "charts": []any{}})
		case strings.HasSuffix(p, "/byo-iac"):
			_ = enc.Encode(map[string]any{"source": nil})
		default:
			w.WriteHeader(http.StatusNotFound)
			_ = enc.Encode(map[string]string{"error": "not found: " + p})
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	resetFlagsAroundTest(t)
	prevExit := exitFunc
	exitFunc = func(code int) { panic(projExit{code}) }
	t.Cleanup(func() { exitFunc = prevExit })
	return func(args ...string) (out string, exited bool) {
		read := projCaptureStdout(t)
		defer func() {
			if r := recover(); r != nil {
				if _, ok := r.(projExit); !ok {
					panic(r)
				}
				exited = true
			}
			out = read()
		}()
		resetAllFlags()
		execRootArgs(args)
		if err := rootCmd.Execute(); err != nil {
			t.Errorf("execute %v: %v", args, err)
		}
		return "", false
	}
}

func TestExportCommand_ThroughTheCobraTree(t *testing.T) {
	run := exportCLI(t)
	out, exited := run("export", "web", "--env", "prod", "--no-input")
	if exited || !strings.Contains(out, "project: web") || !strings.Contains(out, "account: prod-account") {
		t.Fatalf("export to stdout (exited %v):\n%s", exited, out)
	}
	for _, s := range exportPlantedSecrets {
		if strings.Contains(out, s) {
			t.Errorf("planted secret %q in the output", s)
		}
	}
	path := filepath.Join(t.TempDir(), manifest.FileName)
	if _, exited := run("export", "web", "--all", "--out", path, "--no-input"); exited {
		t.Fatal("export --all --out exited")
	}
	if raw, _ := os.ReadFile(path); !strings.Contains(string(raw), "name: staging") {
		t.Errorf("file:\n%s", raw)
	}
	if _, exited := run("export", "web", "--all", "--out", path, "--no-input"); !exited {
		t.Error("an existing --out without --force must exit")
	}
	if _, exited := run("export", "web", "--env", "prod", "--all", "--no-input"); !exited {
		t.Error("--env with --all must exit")
	}
	if _, exited := run("export", "web", "--no-input"); !exited {
		t.Error("several environments without --env under --no-input must exit")
	}
	if _, exited := run("export", "--all", "--no-input"); !exited {
		t.Error("no project under --no-input must exit")
	}
}

// A credential that hides in a VALUE is caught by its shape: a URL with user-info anywhere, or a
// nested key named like a credential inside a provider_config knob or an add-on setting.
func TestExport_CredentialsHiddenInValues(t *testing.T) {
	f := exportServer(t)
	f.comps["staging"] = []api.Component{
		{Kind: "repositories", Name: "repositories", Status: "ACTIVE", Config: map[string]any{
			"apps_destination_repo": "https://x-access-token:ghp_planted@github.com/acme/apps",
			"apps_path":             "overlays/staging",
		}},
		{Kind: "databases", Name: "orders", Status: "ACTIVE", Config: map[string]any{
			"engine": "postgres",
			"provider_config": map[string]any{
				"rds_bootstrap":   map[string]any{"users": []any{map[string]any{"name": "app", "password": "pw_planted"}}},
				"rds_backup_days": float64(7),
			},
		}},
	}
	f.addons["staging"] = []api.Addon{{AddonID: "cert-manager", Enabled: true, Mode: "managed", Settings: map[string]any{
		"installCRDs": true, "webhookToken": "tok_planted", "issuer": "https://acme:pw2_planted@acme.example.com/dir",
	}}}
	data, _ := exportBytes(t, f, exportOptions{project: "web", env: "staging"})
	out := string(data)
	for _, planted := range []string{"ghp_planted", "pw_planted", "tok_planted", "pw2_planted"} {
		if strings.Contains(out, planted) {
			t.Errorf("%q reached the file:\n%s", planted, out)
		}
	}
	for _, want := range []string{
		"staging repositories — apps_destination_repo holds what looks like a credential",
		"staging databases/orders — provider_config rds_bootstrap: a credential",
		"staging add-on cert-manager — settings issuer, webhookToken look like credentials",
		"rds_backup_days: 7",
		"installCRDs: true",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q:\n%s", want, out)
		}
	}
	assertNothingToDo(t, planExported(t, f, data), data)
	for v, want := range map[any]bool{
		"https://github.com/acme/apps": false, "plain": false, "https://u@h/x": true, "http://%zz": true,
	} {
		if got := holdsCredential(v); got != want {
			t.Errorf("holdsCredential(%v) = %v, want %v", v, got, want)
		}
	}
	if holdsCredential([]any{"a", float64(1)}) {
		t.Error("a list of plain values holds no credential")
	}
}
