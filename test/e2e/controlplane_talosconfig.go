// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The hetzner-talos placement credential channel (#1389), served by the harness control plane.
//
// The console serves it at apps/console/app/api/jobs/[id]/talosconfig/route.ts. This stand-in did not,
// so in every T2 run the runner's write-back after the dedicated apply and its fetch before a hetzner
// namespace/vcluster placement both got the mux's 404 — and no hetzner placement could ever mint kube
// access to its Fabric (#845, run 36626677124). Nothing had caught it because no hetzner placement had
// ever run end-to-end.
//
// FIDELITY BOUNDARY (deliberate), as for the add-on secrets:
//   - The gate mirrors the console's: a runner that owns an executing hetzner DEPLOY job — or the
//     DESTROY of a namespace/vcluster placement, which may only read — and only the Fabric-owning
//     DEDICATED deploy may write. The job's provider comes from its config_snapshot, because
//     the harness seeds jobs with no cloud identity (the console reads it from cloud_identities).
//   - The console resolves a job's Fabric through project_environments.fabric_id. Harness jobs carry no
//     environment, so a placement resolves its Fabric by the cluster name it targets
//     (config_snapshot.cluster.cluster_name) against the cluster name the writing job reported
//     (execution_metadata.cluster_name) — the same link the scenarios already assert on.
//   - The value is held in memory, not encrypted: encryption at rest is the console's (encryptSecret,
//     with its own unit tests) and no keyring exists here. It is never logged and never echoed in an
//     error.

// maxHarnessTalosconfigBytes mirrors the console route's MAX_TALOSCONFIG_BYTES.
const maxHarnessTalosconfigBytes = 128 * 1024

// heldTalosconfig is one Fabric admin talosconfig, keyed by the dedicated DEPLOY job that wrote it.
type heldTalosconfig struct {
	fabricJobID string
	talosconfig string
}

// talosJobRow is what the talosconfig gate reads for one job.
type talosJobRow struct {
	runnerID string // "" when the job is unclaimed
	jobType  string
	status   string
	snapshot []byte
}

// talosSnapshot is the slice of a job's config_snapshot the gate reads.
type talosSnapshot struct {
	Provider      string `json:"provider"`
	PlacementMode string `json:"placement_mode"`
	Cluster       struct {
		ClusterName string `json:"cluster_name"`
	} `json:"cluster"`
}

// talosGateResult is the gate's verdict: a non-zero code is the refusal to return verbatim.
type talosGateResult struct {
	code    int
	message string
	// placementCluster is the Fabric cluster a read resolves against (reads only).
	placementCluster string
}

// gateTalosconfigJob decides whether runnerID may read (write=false) or write (write=true) the Fabric
// talosconfig through this job, mirroring the console route's gateHetznerJob plus its PUT's
// dedicated-only rule. Pure, so every refusal is testable without a database. Fail-closed at each step.
func gateTalosconfigJob(row *talosJobRow, runnerID string, write bool) talosGateResult {
	if row == nil {
		return talosGateResult{code: http.StatusNotFound, message: "Job not found"}
	}
	if row.runnerID == "" || row.runnerID != runnerID {
		return talosGateResult{code: http.StatusForbidden, message: "Runner does not own this job"}
	}
	// A DEPLOY reads or writes; a DESTROY may only read, and only as a placement (checked below once the
	// snapshot is decoded) — its teardown mints from the credential exactly as its deploy did.
	if row.jobType != "DEPLOY" && (row.jobType != "DESTROY" || write) {
		return talosGateResult{code: http.StatusForbidden, message: "Job kind has no talosconfig"}
	}
	if row.status != "CLAIMED" && row.status != "PROCESSING" {
		return talosGateResult{code: http.StatusForbidden, message: "Job is not executing"}
	}
	var snap talosSnapshot
	if err := json.Unmarshal(row.snapshot, &snap); err != nil {
		return talosGateResult{code: http.StatusConflict, message: "Job has an unreadable config_snapshot"}
	}
	if snap.Provider != "hetzner" {
		return talosGateResult{code: http.StatusForbidden, message: "Provider has no talosconfig"}
	}
	dedicated := snap.PlacementMode == "" || snap.PlacementMode == "dedicated"
	if write {
		if !dedicated {
			return talosGateResult{code: http.StatusForbidden, message: "Only the Fabric-owning dedicated deploy may write the talosconfig"}
		}
		return talosGateResult{}
	}
	// A placement DESTROY deregisters what its deploy put on the shared Fabric, so it needs the Fabric's
	// credential; a dedicated DESTROY runs tofu against its own state and never does (#845, run
	// 36646962419 — the vcluster deregister 404'd here, then failed for want of a minter).
	if row.jobType == "DESTROY" && dedicated {
		return talosGateResult{code: http.StatusForbidden, message: "Job kind has no talosconfig"}
	}
	cluster := strings.TrimSpace(snap.Cluster.ClusterName)
	if cluster == "" {
		return talosGateResult{code: http.StatusConflict, message: "Environment is not placed on a Fabric"}
	}
	return talosGateResult{placementCluster: cluster}
}

// latestHeldFor returns the most recently written talosconfig whose writing job is in fabricJobs — the
// jobs that reported the placement's Fabric cluster. A Fabric redeployed within one run is written
// twice; the later write is the live credential.
func latestHeldFor(held []heldTalosconfig, fabricJobs map[string]bool) (string, bool) {
	for i := len(held) - 1; i >= 0; i-- {
		if fabricJobs[held[i].fabricJobID] {
			return held[i].talosconfig, true
		}
	}
	return "", false
}

// talosStore is the database half of the talosconfig channel: runner authentication, the gate's view of
// a job, and which writing jobs reported a given Fabric cluster. An interface so the handlers — every
// refusal and both success shapes — are testable without Postgres; pgTalosStore is the real one.
type talosStore interface {
	runnerAuthenticated(ctx context.Context, runnerID, tokenHash string) (bool, error)
	job(ctx context.Context, jobID string) (*talosJobRow, error)
	jobsReportingCluster(ctx context.Context, jobIDs []string, cluster string) (map[string]bool, error)
}

// pgTalosStore answers talosStore from the migrated Postgres the control plane runs over.
type pgTalosStore struct{ pool *pgxpool.Pool }

// runnerAuthenticated reports whether the id/token-hash pair matches a real runner row. The SQL-backed
// handlers leave this to their SECURITY DEFINER functions; this route has none, so it checks the token
// itself — a credential must not be served on the headers' mere presence.
func (s pgTalosStore) runnerAuthenticated(ctx context.Context, runnerID, tokenHash string) (bool, error) {
	var n int
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM public.runners WHERE id::text = $1 AND token_hash = $2`, runnerID, tokenHash).
		Scan(&n)
	return n == 1, err
}

// job reads the gate's view of a job; (nil, nil) when it does not exist.
func (s pgTalosStore) job(ctx context.Context, jobID string) (*talosJobRow, error) {
	var (
		runnerID *string
		row      talosJobRow
	)
	err := s.pool.QueryRow(ctx, `
		SELECT runner_id::text, job_type::text, status::text, config_snapshot
		FROM public.jobs WHERE id::text = $1`, jobID).
		Scan(&runnerID, &row.jobType, &row.status, &row.snapshot)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if runnerID != nil {
		row.runnerID = *runnerID
	}
	return &row, nil
}

// jobsReportingCluster returns which of jobIDs reported `cluster` as their cluster_name.
func (s pgTalosStore) jobsReportingCluster(ctx context.Context, jobIDs []string, cluster string) (map[string]bool, error) {
	out := map[string]bool{}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text FROM public.jobs
		WHERE id::text = ANY($1) AND execution_metadata->>'cluster_name' = $2`, jobIDs, cluster)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// talosDB returns the injected store, or the Postgres one.
func (cp *ControlPlane) talosDB() talosStore {
	if cp.talosStore != nil {
		return cp.talosStore
	}
	return pgTalosStore{pool: cp.pool}
}

// talosRunner authenticates the calling runner, writing the refusal itself when it cannot.
func (cp *ControlPlane) talosRunner(w http.ResponseWriter, r *http.Request) (string, bool) {
	runnerID, tokenHash, ok := cp.authHash(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return "", false
	}
	authed, err := cp.talosDB().runnerAuthenticated(r.Context(), runnerID, tokenHash)
	if err != nil || !authed {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return "", false
	}
	return runnerID, true
}

// talosGate reads the job and applies gateTalosconfigJob, writing the refusal itself when it refuses.
func (cp *ControlPlane) talosGate(w http.ResponseWriter, r *http.Request, runnerID string, write bool) (talosGateResult, bool) {
	row, err := cp.talosDB().job(r.Context(), r.PathValue("id"))
	if err != nil {
		http.Error(w, "could not read job", http.StatusInternalServerError)
		return talosGateResult{}, false
	}
	gate := gateTalosconfigJob(row, runnerID, write)
	if gate.code != 0 {
		writeJSON(w, gate.code, map[string]any{"error": gate.message})
		return gate, false
	}
	return gate, true
}

// handlePutTalosconfig holds the Fabric's admin talosconfig written back by its dedicated deploy.
func (cp *ControlPlane) handlePutTalosconfig(w http.ResponseWriter, r *http.Request) {
	runnerID, ok := cp.talosRunner(w, r)
	if !ok {
		return
	}
	if _, ok := cp.talosGate(w, r, runnerID, true); !ok {
		return
	}
	// Read one byte past the envelope bound so an oversized body is refused as too large rather than
	// truncated into invalid JSON.
	const envelope = maxHarnessTalosconfigBytes + 1024
	raw, err := io.ReadAll(io.LimitReader(r.Body, envelope+1))
	if err != nil {
		http.Error(w, "could not read body", http.StatusBadRequest)
		return
	}
	var body struct {
		Talosconfig string `json:"talosconfig"`
	}
	if len(raw) > envelope {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "talosconfig too large"})
		return
	}
	if json.Unmarshal(raw, &body) != nil || strings.TrimSpace(body.Talosconfig) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Missing talosconfig"})
		return
	}
	if len(body.Talosconfig) > maxHarnessTalosconfigBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "talosconfig too large"})
		return
	}
	cp.talosMu.Lock()
	cp.talosHeld = append(cp.talosHeld, heldTalosconfig{fabricJobID: r.PathValue("id"), talosconfig: body.Talosconfig})
	cp.talosMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleGetTalosconfig returns the placement's Fabric talosconfig, or {talosconfig: null} when the
// Fabric has none — exactly the console's two success shapes.
func (cp *ControlPlane) handleGetTalosconfig(w http.ResponseWriter, r *http.Request) {
	runnerID, ok := cp.talosRunner(w, r)
	if !ok {
		return
	}
	gate, ok := cp.talosGate(w, r, runnerID, false)
	if !ok {
		return
	}
	cp.talosMu.Lock()
	held := append([]heldTalosconfig(nil), cp.talosHeld...)
	cp.talosMu.Unlock()
	fabricJobs := map[string]bool{}
	if len(held) > 0 {
		ids := make([]string, 0, len(held))
		for _, h := range held {
			ids = append(ids, h.fabricJobID)
		}
		var err error
		if fabricJobs, err = cp.talosDB().jobsReportingCluster(r.Context(), ids, gate.placementCluster); err != nil {
			http.Error(w, "could not resolve the Fabric", http.StatusInternalServerError)
			return
		}
	}
	if tc, found := latestHeldFor(held, fabricJobs); found {
		writeJSON(w, http.StatusOK, map[string]any{"talosconfig": tc})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"talosconfig": nil})
}
