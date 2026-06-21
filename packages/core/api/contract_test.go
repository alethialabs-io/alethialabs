// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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

func TestContract_Zones(t *testing.T) {
	var resp struct {
		Zones []ZoneWithSpecs `json:"zones"`
	}
	strictDecode(t, "zones.json", &resp)
	if len(resp.Zones) != 1 || len(resp.Zones[0].Specs) != 1 {
		t.Fatalf("unexpected zones shape: %+v", resp)
	}
}

func TestContract_Clusters(t *testing.T) {
	var resp struct {
		Clusters []SpecCluster `json:"clusters"`
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
