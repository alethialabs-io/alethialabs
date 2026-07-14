// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// Console→ACTIVE + snapshot fidelity (BYOC A0.5) — the ORCHESTRATION half, driven via *testing.T.
// Compiled only under the e2e_t2 tag (like t2_provision_test.go / t2_soak_run_test.go); the pure
// helpers it calls live in the untagged t2_console_active.go so they stay unit-testable without a
// cloud. See that file's header for what A0.5 closes (gap G11 / finding #4).
//
// Every step here is WARN-ONLY by default (a05Soft logs) and becomes a HARD failure only under
// ALETHIA_E2E_A05_ENFORCE — the spec's warn-only → hard-fail-after-3-green-nights ramp, flippable
// with no code change. If A0.5 setup fails (or the fixture is missing) the whole feature disables
// itself and the base T2 proof runs exactly as before.
package e2e

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
)

// a05Session carries the A0.5 run state: whether it is active (graph seeded + fixture loaded),
// whether assertions enforce, the seeded console graph, and the fidelity fixture.
type a05Session struct {
	enabled bool
	enforce bool
	graph   *a05Graph
	fixture map[string]any
}

// jobGraph returns the graph to LINK the DEPLOY job to, or nil when A0.5 is disabled (so the job is
// seeded unlinked and provisioning is untouched).
func (s *a05Session) jobGraph() *a05Graph {
	if s == nil || !s.enabled {
		return nil
	}
	return s.graph
}

// a05Soft is the warn-vs-enforce gate: a HARD t.Fatalf under ALETHIA_E2E_A05_ENFORCE, else a logged
// warning that lets the test continue (and the base T2 proof stand).
func a05Soft(t *testing.T, s *a05Session, msg string) {
	t.Helper()
	if s.enforce {
		t.Fatalf("A0.5 (ENFORCE): %s", msg)
	}
	t.Logf("A0.5 WARN (set ALETHIA_E2E_A05_ENFORCE to hard-fail): %s", msg)
}

// setupA05 loads the fidelity fixture and seeds the console object graph. Best-effort: any failure
// disables A0.5 (base T2 unaffected) with a warning, or hard-fails under enforce.
func setupA05(t *testing.T, ctx context.Context, cp *ControlPlane, root, project, env, region string) *a05Session {
	t.Helper()
	s := &a05Session{enforce: a05EnforceEnabled()}
	fx, err := loadA05Fixture(root)
	if err != nil {
		a05Soft(t, s, fmt.Sprintf("load fidelity fixture: %v", err))
		return s
	}
	g, err := cp.SeedA05Graph(ctx, project, env, region)
	if err != nil {
		a05Soft(t, s, fmt.Sprintf("seed console graph: %v", err))
		return s
	}
	s.fixture, s.graph, s.enabled = fx, g, true
	t.Logf("A0.5: seeded console graph (project=%s env=%s) + loaded fidelity fixture; enforce=%v real_snapshot=%v",
		g.projectID, g.envID, s.enforce, a05RealSnapshotEnabled())
	return s
}

// t2DeploySnapshot builds the DEPLOY snapshot. `base` is the pre-repos/pre-cluster-json snapshot the
// fidelity check runs against: the lean synthetic map by default, or the REAL console fixture shape
// (with per-run dynamic overrides) under ALETHIA_E2E_A05_REAL_SNAPSHOT. `full` clones `base` and
// layers the A0.6 apps/BYO repo wiring + the per-cloud cluster-json override — the exact snapshot
// the runner consumes. Cloning keeps `base` pristine so fidelity is judged on the un-mutated shape.
func t2DeploySnapshot(t *testing.T, project, env, provider, region string, repos t2ArgoRepos, reposEnabled bool, s *a05Session) (base, full map[string]any, err error) {
	t.Helper()
	if s.enabled && a05RealSnapshotEnabled() {
		envID := ""
		if s.graph != nil {
			envID = s.graph.envID
		}
		base, err = a05RealSnapshotFromFixture(s.fixture, project, env, provider, region, envID)
		if err != nil {
			return nil, nil, err
		}
		t.Log("A0.5: seeding the DEPLOY job with the REAL console buildConfigSnapshot shape (ALETHIA_E2E_A05_REAL_SNAPSHOT)")
	} else {
		base = t2BaseSnapshot(project, env, provider, region)
	}
	// full = deep copy of base (never mutate the fidelity target) + repos + cluster-json override.
	full, err = a05NormalizeSnapshot(base)
	if err != nil {
		return nil, nil, err
	}
	// A0.6: wire the apps-destination repo + append the BYO chart add-on when enabled. The git token
	// is NOT written into the snapshot — it crosses via the control plane's git-token handler.
	if reposEnabled {
		repos.applyToSnapshot(full)
	}
	// Merge the per-cloud cluster shape override into the `cluster` block. Malformed JSON is a loud
	// failure — a workflow typo must not silently provision the wrong shape.
	if err := t2MergeClusterJSON(full); err != nil {
		return nil, nil, err
	}
	// A2.2: append the Azure AKS admin-group object id (self-admin) into cluster.provider_config
	// when ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID is set (azure only) — AFTER the cluster-json
	// merge so it augments, never clobbers, any id supplied there. On `full` ONLY (never `base`,
	// the A0.5 fidelity target).
	t2MergeAzureAdminGroup(full, provider)
	// Merge the per-cloud network override into the `network` block (AWS: single_nat_gateway). On
	// `full` ONLY — never `base`, the fidelity target — so A0.5's key-for-key fixture check stays
	// intact while the real DEPLOY provisions the cheaper single-NAT shape.
	if err := t2MergeNetworkJSON(full); err != nil {
		return nil, nil, err
	}
	return base, full, nil
}

// a05CheckFidelity asserts the seeded (base) snapshot is key-for-key faithful to the console
// buildConfigSnapshot fixture — the guard against finding #4's synthetic drift. Warn-only unless
// enforce; a no-op when A0.5 is disabled.
func a05CheckFidelity(t *testing.T, s *a05Session, base map[string]any) {
	t.Helper()
	if !s.enabled {
		return
	}
	norm, err := a05NormalizeSnapshot(base)
	if err != nil {
		a05Soft(t, s, fmt.Sprintf("normalize seeded snapshot: %v", err))
		return
	}
	diffs := a05SnapshotFidelity(norm, s.fixture)
	if len(diffs) == 0 {
		t.Log("A0.5: seeded snapshot is key-for-key faithful to the console buildConfigSnapshot fixture")
		return
	}
	a05Soft(t, s, fmt.Sprintf("snapshot fidelity — %d divergence(s) from the console shape: %s",
		len(diffs), strings.Join(diffs, "; ")))
}

// runA05ConsoleActive replays the REAL finalizeDeployment and asserts the env reached ACTIVE with a
// persisted add-on health row (the console→ACTIVE proof that closes gap G11). Warn-only unless
// enforce; a no-op when A0.5 is disabled.
func runA05ConsoleActive(t *testing.T, ctx context.Context, cp *ControlPlane, s *a05Session, root, jobID string) {
	t.Helper()
	if !s.enabled {
		return
	}
	dbURL := os.Getenv("ALETHIA_DATABASE_URL")
	var out bytes.Buffer
	if err := runFinalizeDeploymentShim(ctx, root, dbURL, jobID, &out); err != nil {
		a05Soft(t, s, fmt.Sprintf("replay finalizeDeployment shim: %v\n──── shim output ────\n%s",
			err, t2Truncate(out.String(), 2000)))
		return
	}
	t.Logf("A0.5: replayed real finalizeDeployment; shim: %s", strings.TrimSpace(out.String()))

	// (a) env → ACTIVE via the REAL set_env_status deploySuccess CAS inside finalizeDeployment.
	status, err := cp.EnvStatus(ctx, s.graph.envID)
	if err != nil {
		a05Soft(t, s, fmt.Sprintf("read env status: %v", err))
	} else if status != "ACTIVE" {
		a05Soft(t, s, fmt.Sprintf("env status = %q, want ACTIVE — finalizeDeployment's deploySuccess CAS did not move it", status))
	} else {
		t.Logf("A0.5: env %s is ACTIVE (real finalizeDeployment)", s.graph.envID)
	}

	// (b) persisted health row: the reloader add-on's ArgoCD health, written by recordAddonHealth
	//     from the runner's REAL execution_metadata.addon_status. Empty/absent ⇒ the writeback the
	//     console UI depends on never happened.
	health, addonStatus, ok, err := cp.AddonHealth(ctx, s.graph.projectID, s.graph.envID, "reloader")
	if err != nil {
		a05Soft(t, s, fmt.Sprintf("read add-on health row: %v", err))
	} else if !ok || health == "" {
		a05Soft(t, s, "reloader add-on health row absent/empty — finalizeDeployment.recordAddonHealth did not persist real ArgoCD health")
	} else {
		t.Logf("A0.5: persisted reloader health row: health=%q status=%q", health, addonStatus)
	}

	// (c) bonus — the Trivy security-posture row, only written when the runner posted a report.
	//     Absence is not a failure (Trivy-Operator may not be installed), so this only logs.
	if secOK, serr := cp.SecurityRowExists(ctx, s.graph.projectID, s.graph.envID); serr == nil && secOK {
		t.Log("A0.5: persisted Trivy security-posture row present (bonus)")
	}
}
