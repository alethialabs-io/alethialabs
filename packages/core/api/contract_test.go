// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The fixtures in testdata/ are the shared CLI wire contract: the console side
// validates them against the Zod contract (lib/validations/cli-contract.ts via
// cli-contract.test.ts), and the tests below strict-decode them into the Go
// structs the CLI uses. Together they make Go↔DB type drift a loud failure
// instead of silent zero-filling:
//
//   - DisallowUnknownFields catches ADDITIVE drift (the backend grew a field the
//     Go struct doesn't model — the decode errors on the unknown key).
//   - assertNoExtraStructKeys catches REMOVAL/RENAME drift (the Go struct has a
//     field the wire no longer carries — re-marshaling surfaces the orphan key).
//
// When the DB schema changes, the Zod contract changes, cli-contract.test.ts
// forces the fixture to be regenerated, and the regenerated fixture breaks these
// tests until the Go struct is brought back in sync.

// strictDecode unmarshals a fixture into v, rejecting any unknown JSON field.
func strictDecode(t *testing.T, file string, v any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", file))
	if err != nil {
		t.Fatalf("read fixture %s: %v", file, err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		t.Fatalf("%s drifted from its Go type (unknown/extra wire field): %v", file, err)
	}
}

// assertNoExtraStructKeys re-marshals the decoded struct and fails if it emits a
// top-level key the fixture does not contain — i.e. the Go struct still expects a
// field the wire dropped or renamed. Only runs on object fixtures.
func assertNoExtraStructKeys(t *testing.T, file string, v any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", file))
	if err != nil {
		t.Fatalf("read fixture %s: %v", file, err)
	}
	var wire map[string]json.RawMessage
	if err := json.Unmarshal(raw, &wire); err != nil {
		return // not a top-level object (skip)
	}
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("re-marshal %s: %v", file, err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(out, &got); err != nil {
		return
	}
	for k := range got {
		if _, ok := wire[k]; !ok {
			t.Errorf("%s: Go struct emits key %q absent from the wire fixture (field removed/renamed upstream?)", file, k)
		}
	}
}

func TestContract_Runners(t *testing.T) {
	var resp struct {
		Runners []Runner `json:"runners"`
	}
	strictDecode(t, "runners.json", &resp)
	if len(resp.Runners) != 1 {
		t.Fatalf("expected 1 runner, got %d", len(resp.Runners))
	}
	assertNoExtraStructKeys(t, "runners.json", struct {
		Runners []Runner `json:"runners"`
	}{resp.Runners})
}

func TestContract_Clusters(t *testing.T) {
	var resp struct {
		Clusters []ClusterSummary `json:"clusters"`
	}
	strictDecode(t, "clusters.json", &resp)
}

func TestContract_CloudIdentities(t *testing.T) {
	var resp struct {
		CloudIdentities []CloudIdentity `json:"cloud_identities"`
	}
	strictDecode(t, "cloud_identities.json", &resp)
}

func TestContract_Job(t *testing.T) {
	var job ProvisionJob
	strictDecode(t, "job.json", &job)
	assertNoExtraStructKeys(t, "job.json", job)
}

func TestContract_JobsPage(t *testing.T) {
	var page JobsPage
	strictDecode(t, "jobs_page.json", &page)
	// Values are sampled deterministically (ints → 0), so assert structure only.
	if len(page.Jobs) != 1 {
		t.Fatalf("unexpected jobs page: %+v", page)
	}
}

func TestContract_JobResponse(t *testing.T) {
	var resp struct {
		Job ProvisionJob `json:"job"`
	}
	strictDecode(t, "job_response.json", &resp)
}

func TestContract_InitIdentity(t *testing.T) {
	var resp InitIdentityResponse
	strictDecode(t, "init_identity.json", &resp)
	assertNoExtraStructKeys(t, "init_identity.json", resp)
}

func TestContract_ConnectIdentity(t *testing.T) {
	var resp ConnectIdentityResponse
	strictDecode(t, "connect_identity.json", &resp)
	assertNoExtraStructKeys(t, "connect_identity.json", resp)
}

func TestContract_JobLogs(t *testing.T) {
	var resp struct {
		Logs []JobLog `json:"logs"`
	}
	strictDecode(t, "job_logs.json", &resp)
}

func TestContract_Repositories(t *testing.T) {
	var resp struct {
		Repositories []Repository `json:"repositories"`
	}
	strictDecode(t, "repositories.json", &resp)
}

func TestContract_ProviderStatus(t *testing.T) {
	var status ProviderStatus
	strictDecode(t, "provider_status.json", &status)
	assertNoExtraStructKeys(t, "provider_status.json", status)
}

func TestContract_DeployRunner(t *testing.T) {
	var resp DeployRunnerResponse
	strictDecode(t, "deploy_runner.json", &resp)
	assertNoExtraStructKeys(t, "deploy_runner.json", resp)
}

func TestContract_WhoAmI(t *testing.T) {
	var me WhoAmI
	strictDecode(t, "whoami.json", &me)
	assertNoExtraStructKeys(t, "whoami.json", me)
}

func TestContract_Orgs(t *testing.T) {
	var resp struct {
		Orgs []OrgSummary `json:"orgs"`
	}
	strictDecode(t, "orgs.json", &resp)
	if len(resp.Orgs) != 1 {
		t.Fatalf("expected 1 org, got %d", len(resp.Orgs))
	}
	assertNoExtraStructKeys(t, "orgs.json", resp)
}

func TestContract_Members(t *testing.T) {
	var resp struct {
		Members []Member `json:"members"`
	}
	strictDecode(t, "members.json", &resp)
	if len(resp.Members) != 1 {
		t.Fatalf("expected 1 member, got %d", len(resp.Members))
	}
	assertNoExtraStructKeys(t, "members.json", resp)
}

func TestContract_Teams(t *testing.T) {
	var resp struct {
		Teams []Team `json:"teams"`
	}
	strictDecode(t, "teams.json", &resp)
	if len(resp.Teams) != 1 {
		t.Fatalf("expected 1 team, got %d", len(resp.Teams))
	}
	assertNoExtraStructKeys(t, "teams.json", resp)
}

func TestContract_Channels(t *testing.T) {
	var resp struct {
		Channels []Channel `json:"channels"`
	}
	strictDecode(t, "channels.json", &resp)
	if len(resp.Channels) != 1 {
		t.Fatalf("expected 1 channel, got %d", len(resp.Channels))
	}
	assertNoExtraStructKeys(t, "channels.json", resp)
}

func TestContract_Channel(t *testing.T) {
	var resp struct {
		Channel Channel `json:"channel"`
	}
	strictDecode(t, "channel.json", &resp)
	assertNoExtraStructKeys(t, "channel.json", resp)
}

func TestContract_AlertRules(t *testing.T) {
	var resp struct {
		AlertRules []AlertRule `json:"alert_rules"`
	}
	strictDecode(t, "alert_rules.json", &resp)
	if len(resp.AlertRules) != 1 {
		t.Fatalf("expected 1 alert rule, got %d", len(resp.AlertRules))
	}
	assertNoExtraStructKeys(t, "alert_rules.json", resp)
}

func TestContract_AlertRule(t *testing.T) {
	var resp struct {
		AlertRule AlertRule `json:"alert_rule"`
	}
	strictDecode(t, "alert_rule.json", &resp)
	assertNoExtraStructKeys(t, "alert_rule.json", resp)
}

func TestContract_Activity(t *testing.T) {
	var resp struct {
		Activity []ActivityEntry `json:"activity"`
	}
	strictDecode(t, "activity.json", &resp)
	if len(resp.Activity) != 1 {
		t.Fatalf("expected 1 activity entry, got %d", len(resp.Activity))
	}
	assertNoExtraStructKeys(t, "activity.json", resp)
}

func TestContract_Roles(t *testing.T) {
	var resp struct {
		Roles []Role `json:"roles"`
	}
	strictDecode(t, "roles.json", &resp)
	if len(resp.Roles) != 1 {
		t.Fatalf("expected 1 role, got %d", len(resp.Roles))
	}
	assertNoExtraStructKeys(t, "roles.json", resp)
}

func TestContract_Role(t *testing.T) {
	var resp struct {
		Role Role `json:"role"`
	}
	strictDecode(t, "role.json", &resp)
	assertNoExtraStructKeys(t, "role.json", resp)
}

func TestContract_Grants(t *testing.T) {
	var resp struct {
		Grants []Grant `json:"grants"`
	}
	strictDecode(t, "grants.json", &resp)
	if len(resp.Grants) != 1 {
		t.Fatalf("expected 1 grant, got %d", len(resp.Grants))
	}
	assertNoExtraStructKeys(t, "grants.json", resp)
}

func TestContract_Grant(t *testing.T) {
	var resp struct {
		Grant Grant `json:"grant"`
	}
	strictDecode(t, "grant.json", &resp)
	assertNoExtraStructKeys(t, "grant.json", resp)
}

func TestContract_SsoProviders(t *testing.T) {
	var resp struct {
		SsoProviders []SsoProvider `json:"sso_providers"`
	}
	strictDecode(t, "sso_providers.json", &resp)
	if len(resp.SsoProviders) != 1 {
		t.Fatalf("expected 1 sso provider, got %d", len(resp.SsoProviders))
	}
	assertNoExtraStructKeys(t, "sso_providers.json", resp)
}

func TestContract_SsoProvider(t *testing.T) {
	var resp struct {
		SsoProvider SsoProvider `json:"sso_provider"`
	}
	strictDecode(t, "sso_provider.json", &resp)
	assertNoExtraStructKeys(t, "sso_provider.json", resp)
}

func TestContract_Billing(t *testing.T) {
	var resp struct {
		Billing Billing `json:"billing"`
	}
	strictDecode(t, "billing.json", &resp)
	assertNoExtraStructKeys(t, "billing.json", resp)
}

func TestContract_Usage(t *testing.T) {
	var resp struct {
		Usage Usage `json:"usage"`
	}
	strictDecode(t, "usage.json", &resp)
	assertNoExtraStructKeys(t, "usage.json", resp)
}

func TestContract_FleetPools(t *testing.T) {
	var resp struct {
		Pools []FleetPool `json:"pools"`
	}
	strictDecode(t, "fleet_pools.json", &resp)
	if len(resp.Pools) != 1 {
		t.Fatalf("expected 1 fleet pool, got %d", len(resp.Pools))
	}
	assertNoExtraStructKeys(t, "fleet_pools.json", resp)
}

func TestContract_FleetPool(t *testing.T) {
	var resp struct {
		Pool FleetPool `json:"pool"`
	}
	strictDecode(t, "fleet_pool.json", &resp)
	assertNoExtraStructKeys(t, "fleet_pool.json", resp)
}

func TestContract_Project(t *testing.T) {
	var resp struct {
		Project Project `json:"project"`
	}
	strictDecode(t, "project.json", &resp)
	assertNoExtraStructKeys(t, "project.json", resp)
}

func TestContract_Environments(t *testing.T) {
	var resp struct {
		Environments []Environment `json:"environments"`
	}
	strictDecode(t, "environments.json", &resp)
	if len(resp.Environments) != 1 {
		t.Fatalf("expected 1 environment, got %d", len(resp.Environments))
	}
	assertNoExtraStructKeys(t, "environments.json", resp)
}

func TestContract_Environment(t *testing.T) {
	var resp struct {
		Environment Environment `json:"environment"`
	}
	strictDecode(t, "environment.json", &resp)
	assertNoExtraStructKeys(t, "environment.json", resp)
}

func TestContract_Components(t *testing.T) {
	var resp struct {
		Components []Component `json:"components"`
	}
	strictDecode(t, "components.json", &resp)
	if len(resp.Components) != 1 {
		t.Fatalf("expected 1 component, got %d", len(resp.Components))
	}
	assertNoExtraStructKeys(t, "components.json", resp)
}

func TestContract_Component(t *testing.T) {
	var resp struct {
		Component Component `json:"component"`
	}
	strictDecode(t, "component.json", &resp)
	assertNoExtraStructKeys(t, "component.json", resp)
}
