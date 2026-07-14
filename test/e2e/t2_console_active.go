// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Console→ACTIVE + snapshot fidelity (BYOC A0.5) — the PURE, reusable half. Deliberately
// UNTAGGED (like controlplane.go / t2_providers.go / t2_soak.go) so `go mod tidy` sees its
// deps and the pure helpers are unit-testable WITHOUT a cloud, a token, or the e2e_t2 tag.
//
// # What A0.5 closes (gap G11 / finding #4)
//
// The T2 harness drives the real runner against a Go control plane that runs the SAME
// authoritative SQL the console does (claim_next_job / update_job_status / insert_job_log) — but
// it STOPS at that SQL SSOT. It never ran the large TypeScript the real status route layers on a
// successful DEPLOY: finalizeDeployment (env → ACTIVE via the set_env_status CAS + persisted
// add-on health / security-posture rows). So a green T2 never proved "the console marks the env
// ACTIVE" — the FIDELITY BOUNDARY documented on controlplane.go's handleStatus. A0.5 closes it two
// ways, both WITHOUT re-implementing the console divergently in Go:
//
//   - SNAPSHOT FIDELITY: the T2 DEPLOY snapshot is checked against a shared fixture frozen by the
//     REAL buildConfigSnapshot (apps/console/tests/e2e-fixtures/t2-config-snapshot.test.ts →
//     test/e2e/fixtures/t2_config_snapshot.hetzner.json). This kills finding #4's synthetic-drift
//     risk: the seeded snapshot's keys are asserted key-for-key against the console-produced shape.
//     With ALETHIA_E2E_A05_REAL_SNAPSHOT the harness SEEDS that real console shape (cheap 1+1
//     Hetzner) instead of the lean map — full substitution, opt-in to protect the billable apply.
//
//   - CONSOLE → ACTIVE: after the runner reports SUCCESS, the harness replays the REAL
//     finalizeDeployment (via the tsx shim scripts/e2e/finalize-deployment.ts, the ACTUAL exported
//     console action, against the same Postgres) and asserts the env is ACTIVE with the persisted
//     add-on health row the finalize wrote from the runner's real execution_metadata.
//
// Everything A0.5 adds is WARN-ONLY until it has proven itself; ALETHIA_E2E_A05_ENFORCE flips the
// new assertions to HARD failures (per the spec: warn-only → hard-fail after 3 green nights), with
// no code change needed to enforce.
package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"
)

// a05Truthy reports whether an env flag is set to an on-value (1/true/yes/on, case-insensitive).
func a05Truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// a05EnforceEnabled: when set, A0.5's new ACTIVE/health/fidelity assertions HARD-FAIL instead of
// warning. Left unset for the first nights so a shim/seed hiccup can't red the expensive real-apply
// nightly before the path has gone green ≥3 times (the spec's warn-only → enforce ramp).
func a05EnforceEnabled() bool { return a05Truthy(os.Getenv("ALETHIA_E2E_A05_ENFORCE")) }

// a05RealSnapshotEnabled: when set, the DEPLOY job is seeded with the FULL console-produced snapshot
// (the fixture, cheap-shaped) instead of the lean synthetic map — the true "use the real
// buildConfigSnapshot output" substitution. Gated (default off) because it changes what the runner
// provisions; the cheap 1+1 fixture is cost-equivalent to the lean default (both → 1 control-plane +
// 1 worker), so flipping it on is safe once a maintainer has eyeballed the fixture.
func a05RealSnapshotEnabled() bool { return a05Truthy(os.Getenv("ALETHIA_E2E_A05_REAL_SNAPSHOT")) }

// a05Graph is the seeded console object graph the finalize path drives: a project + a QUEUED
// environment + a reloader add-on row, all owned by one synthetic community org (org_id = user_id).
type a05Graph struct {
	orgID, userID, projectID, envID string
}

// SeedA05Graph inserts the minimal real console rows finalizeDeployment needs: a project, a
// project_environment in QUEUED (so the real deploySuccess CAS QUEUED→ACTIVE applies), and an
// enabled `reloader` project_addons row (so recordAddonHealth has a row to write the real ArgoCD
// health onto — the persisted "health row" A0.5 asserts). The runner never reads these; only the
// replayed finalizeDeployment does. Returns the graph so the DEPLOY job can be linked to it.
func (cp *ControlPlane) SeedA05Graph(ctx context.Context, project, env, region string) (*a05Graph, error) {
	g := &a05Graph{
		userID:    newUUID(),
		projectID: newUUID(),
		envID:     newUUID(),
	}
	g.orgID = g.userID // community tenancy: org_id == user_id
	if _, err := cp.pool.Exec(ctx, `
		INSERT INTO public.projects (id, user_id, org_id, project_name, slug, region, iac_version)
		VALUES ($1, $2, $2, $3, $4, $5, '1.0.0')`,
		g.projectID, g.userID, project, "a05-"+env, region); err != nil {
		return nil, fmt.Errorf("seed project: %w", err)
	}
	if _, err := cp.pool.Exec(ctx, `
		INSERT INTO public.project_environments
		  (id, project_id, user_id, org_id, name, stage, status, is_default)
		VALUES ($1, $2, $3, $3, $4, 'development', 'QUEUED', true)`,
		g.envID, g.projectID, g.userID, env); err != nil {
		return nil, fmt.Errorf("seed environment: %w", err)
	}
	if _, err := cp.pool.Exec(ctx, `
		INSERT INTO public.project_addons
		  (id, project_id, environment_id, addon_id, source, enabled, mode, status)
		VALUES ($1, $2, $3, 'reloader', 'catalog', true, 'managed', 'PENDING')`,
		newUUID(), g.projectID, g.envID); err != nil {
		return nil, fmt.Errorf("seed addon: %w", err)
	}
	return g, nil
}

// EnvStatus reads the seeded environment's current provisioning status straight from the row the
// replayed finalizeDeployment transitions.
func (cp *ControlPlane) EnvStatus(ctx context.Context, envID string) (string, error) {
	var status string
	err := cp.pool.QueryRow(ctx,
		`SELECT status::text FROM public.project_environments WHERE id = $1`, envID).Scan(&status)
	return status, err
}

// AddonHealth reads the add-on health row finalizeDeployment wrote from the runner's real
// execution_metadata.addon_status. ok=false when the row is absent. A non-empty `health` +
// status=ACTIVE proves recordAddonHealth ran off genuine post-apply ArgoCD health, not a stub.
func (cp *ControlPlane) AddonHealth(ctx context.Context, projectID, envID, addonID string) (health, status string, ok bool, err error) {
	var h *string
	err = cp.pool.QueryRow(ctx, `
		SELECT health, status::text FROM public.project_addons
		WHERE project_id = $1 AND environment_id = $2 AND addon_id = $3`,
		projectID, envID, addonID).Scan(&h, &status)
	if err != nil {
		if strings.Contains(err.Error(), "no rows") {
			return "", "", false, nil
		}
		return "", "", false, err
	}
	if h != nil {
		health = *h
	}
	return health, status, true, nil
}

// SecurityRowExists reports whether finalizeDeployment persisted a Trivy security-posture row for
// the environment. Only written when the runner posted a security_report (Trivy-Operator installed),
// so its absence is not a failure — A0.5 treats it as a soft/bonus signal.
func (cp *ControlPlane) SecurityRowExists(ctx context.Context, projectID, envID string) (bool, error) {
	var n int
	err := cp.pool.QueryRow(ctx, `
		SELECT count(*) FROM public.environment_security
		WHERE project_id = $1 AND environment_id = $2`, projectID, envID).Scan(&n)
	return n > 0, err
}

// runFinalizeDeploymentShim replays the REAL console finalizeDeployment for a job by shelling the
// tsx shim against the same Postgres. NODE_PATH points at the committed server-only/client-only
// no-op stubs so the console's server modules load under a plain Node process (React stays on its
// normal build — a react-server condition would instead break next-runtime-env). Returns the shim's
// error; the caller decides warn vs fail.
func runFinalizeDeploymentShim(ctx context.Context, root, dbURL, jobID string, out io.Writer) error {
	cctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(cctx, "pnpm", "-F", "console", "exec", "tsx",
		"scripts/e2e/finalize-deployment.ts", jobID)
	cmd.Dir = root
	cmd.Env = append(os.Environ(),
		"ALETHIA_DATABASE_URL="+dbURL,
		"NODE_PATH="+filepath.Join(root, "apps", "console", "scripts", "e2e", "node-stubs"),
	)
	cmd.Stdout = out
	cmd.Stderr = out
	return cmd.Run()
}

// ─────────────────────────── snapshot fidelity ───────────────────────────

// a05FixturePath is the committed fixture the console vitest freezes from the REAL
// buildConfigSnapshot for a canonical cheap Hetzner env.
func a05FixturePath(root string) string {
	return filepath.Join(root, "test", "e2e", "fixtures", "t2_config_snapshot.hetzner.json")
}

// loadA05Fixture reads + parses the shared config-snapshot fixture.
func loadA05Fixture(root string) (map[string]any, error) {
	b, err := os.ReadFile(a05FixturePath(root))
	if err != nil {
		return nil, fmt.Errorf("read fixture: %w", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("parse fixture: %w", err)
	}
	return m, nil
}

// a05DynamicSnapshotKeys are the per-run INPUTS that legitimately differ between the harness's
// seeded snapshot and the fixture (identity/tenancy/naming/region). They are excluded from the
// fidelity comparison — fidelity is about the FROZEN SHAPE, not the run-specific inputs.
var a05DynamicSnapshotKeys = map[string]bool{
	"id":                true,
	"user_id":           true,
	"org_id":            true,
	"cloud_identity_id": true,
	"project_name":      true,
	"slug":              true,
	"region":            true,
	"environment_stage": true,
	"environment_id":    true,
}

// a05NormalizeSnapshot JSON round-trips a snapshot so every value is a plain JSON type
// (types.AddOnInstall → map, ints → float64), matching the parsed fixture for reflect.DeepEqual.
func a05NormalizeSnapshot(snap map[string]any) (map[string]any, error) {
	b, err := json.Marshal(snap)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// a05SnapshotFidelity returns the list of divergences between a seeded snapshot and the
// console-produced fixture: for every NON-dynamic key the seed carries, the key must exist in the
// fixture AND its value must deep-equal the fixture's. An empty result ⇒ the seeded snapshot is
// key-for-key faithful to what buildConfigSnapshot would freeze (finding #4's exact guard). `seeded`
// must already be normalized (a05NormalizeSnapshot). This catches a divergent key/value the console
// would never produce — e.g. an add-on install spec that drifted from the catalog.
func a05SnapshotFidelity(seeded, fixture map[string]any) []string {
	var diffs []string
	keys := make([]string, 0, len(seeded))
	for k := range seeded {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if a05DynamicSnapshotKeys[k] {
			continue
		}
		fv, ok := fixture[k]
		if !ok {
			diffs = append(diffs, fmt.Sprintf("key %q is not in the console-produced fixture (synthetic key?)", k))
			continue
		}
		if !reflect.DeepEqual(seeded[k], fv) {
			diffs = append(diffs, fmt.Sprintf("key %q diverges from the console shape: seeded=%v fixture=%v", k, seeded[k], fv))
		}
	}
	return diffs
}

// a05RealSnapshotFromFixture builds the FULL console-shape snapshot to seed when
// ALETHIA_E2E_A05_REAL_SNAPSHOT is on: a deep copy of the fixture with the per-run dynamic fields
// overridden to this run's identity. The cluster block stays the fixture's cheap 1+1 shape (the
// caller still applies t2MergeClusterJSON on top for any per-cloud override), so the runner
// provisions exactly the cheap cluster the lean path does — just from the real console config.
func a05RealSnapshotFromFixture(fixture map[string]any, project, env, provider, region, envID string) (map[string]any, error) {
	snap, err := a05NormalizeSnapshot(fixture) // deep copy via round-trip
	if err != nil {
		return nil, err
	}
	snap["id"] = "e2e-" + env
	snap["project_name"] = project
	snap["environment_stage"] = env
	snap["provider"] = provider
	snap["region"] = region
	if envID != "" {
		snap["environment_id"] = envID
	}
	return snap, nil
}
