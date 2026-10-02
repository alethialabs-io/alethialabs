// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The kubeconfig mint's RUNNER channel, served by the harness control plane (#5287), and the seeding
// the runner-channel driver uses.
//
// The console serves the channel at apps/console/app/api/jobs/[id]/kubeconfig-mint/route.ts
// (lib/kubeconfig-mint/runner.ts). This stand-in did not, so on every T2 leg a MINT_KUBECONFIG job —
// whoever queued it, the CLI through the cli-demo console included — got the mux's 404 on its spec
// read and failed "not found" before minting anything. The runner talks to the shim, never to the
// console, so the console's copy of these two routes is unreachable from a T2 run by construction.
//
// FIDELITY BOUNDARY (deliberate), as for the talosconfig and add-on secret channels:
//   - The gate mirrors gateMintJob + readMintSpec + recordMintResult: the job exists, this runner holds
//     it, it is a MINT_KUBECONFIG job, it is executing (CLAIMED/PROCESSING); the request row is the one
//     THAT job serves, pending, inside its window; a result names that row's mint_id. The status codes
//     are the console route's (404/403/410/409).
//   - The result lands in ONE transaction with the job's completion through the real
//     update_job_status, as recordMintResult does.
//   - A failure reason is stored as the runner sent it, bounded by the wire validator. The console
//     additionally maps a sentence outside its fixed list (lib/kubeconfig-mint/reasons.ts) to a generic
//     one; the runner's sentences are pinned to that list byte for byte by its own
//     TestMintFailureReasons_MatchTheConsoleList, so the mapping is not re-implemented here.
//   - STATE. The console keys tofu state per ENVIRONMENT; the shim keys it per job. A mint whose
//     snapshot does not name its cluster reads the environment's tofu outputs (the runner's
//     mintClusterName fallback), so the spec read aliases the mint job's state slot onto the latest
//     successful DEPLOY of the same environment — the shim's analogue of the console's key. The spec
//     read is the runner's FIRST call for the job, so the alias is in place before the outputs read.
package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// mintRequestWindow mirrors KUBECONFIG_MINT_REQUEST_WINDOW_SECONDS: how long a request row lives to
// be served and polled.
const mintRequestWindow = 600 * time.Second

// mintResultMaxBytes bounds the result body the shim reads: a sealed blob is at most 64 KiB.
const mintResultMaxBytes = 80 << 10

// mintJobGate is what the channel's gate reads for one job.
type mintJobGate struct {
	runnerID      string
	jobType       string
	status        string
	environmentID string
}

// mintGateRefusal is the console route's answer to a job that may not use the channel, or 0 when it may.
func mintGateRefusal(job *mintJobGate, runnerID string) (int, string) {
	switch {
	case job == nil:
		return http.StatusNotFound, "Job not found"
	case job.runnerID != runnerID:
		return http.StatusForbidden, "Runner does not own this job"
	case job.jobType != "MINT_KUBECONFIG":
		return http.StatusForbidden, "Job is not a kubeconfig mint"
	case job.status != "CLAIMED" && job.status != "PROCESSING":
		return http.StatusForbidden, "Job is not executing"
	}
	return 0, ""
}

// mintRequestRow is the request row a job serves, as the shim reads it.
type mintRequestRow struct {
	ID              string
	OrgID           string
	ClusterID       string
	JobID           string
	Tier            string
	Shape           string
	TTLSeconds      int
	ClientPublicKey string
	Status          string
	Sealed          string
	FailureReason   string
	PrivateEndpoint *bool
	ExpiredNow      bool
	CreatedAt       time.Time
}

// mintRowRefusal is readMintSpec/recordMintResult's answer for the row a job serves, or 0 when it may be served.
func mintRowRefusal(row *mintRequestRow) (int, string) {
	switch {
	case row == nil:
		return http.StatusNotFound, "Kubeconfig mint not found for this job"
	case row.ExpiredNow || row.Status == "expired":
		return http.StatusGone, "The kubeconfig mint's window has closed"
	case row.Status != "pending":
		return http.StatusConflict, "The kubeconfig mint already has a result"
	}
	return 0, ""
}

// mintStore is the database half of the runner channel, an interface so both handlers — every
// refusal, the alias and the landing — are testable without Postgres; pgMintStore is the real one.
type mintStore interface {
	// job reads the gate's view of one job; nil when it does not exist.
	job(ctx context.Context, jobID string) (*mintJobGate, error)
	// rowForJob reads the request row a job serves; nil when there is none.
	rowForJob(ctx context.Context, jobID string) (*mintRequestRow, error)
	// latestDeploy is the newest successful DEPLOY of an environment, "" when there is none.
	latestDeploy(ctx context.Context, environmentID string) (string, error)
	// land is recordMintResult's transaction; it answers the route's status code.
	land(ctx context.Context, runnerID, tokenHash, jobID, mintID string, result types.RunnerKubeconfigMintResult) (int, string)
}

// pgMintStore is mintStore over the run's Postgres.
type pgMintStore struct{ cp *ControlPlane }

// mintDB returns the channel's store: the test seam when set, else Postgres.
func (cp *ControlPlane) mintDB() mintStore {
	if cp.mintStore != nil {
		return cp.mintStore
	}
	return pgMintStore{cp: cp}
}

// rowForJob reads the request row a job serves.
func (s pgMintStore) rowForJob(ctx context.Context, jobID string) (*mintRequestRow, error) {
	return scanMintRow(s.cp.pool.QueryRow(ctx, mintRowSelect+` WHERE job_id::text = $1 LIMIT 1`, jobID))
}

// latestDeploy reads the newest successful DEPLOY of an environment.
func (s pgMintStore) latestDeploy(ctx context.Context, environmentID string) (string, error) {
	var id string
	err := s.cp.pool.QueryRow(ctx, `
		SELECT id::text FROM public.jobs
		WHERE environment_id::text = $1 AND job_type = 'DEPLOY' AND status = 'SUCCESS'
		ORDER BY created_at DESC LIMIT 1`, environmentID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// land delegates to landMintResult.
func (s pgMintStore) land(ctx context.Context, runnerID, tokenHash, jobID, mintID string, result types.RunnerKubeconfigMintResult) (int, string) {
	return s.cp.landMintResult(ctx, runnerID, tokenHash, jobID, mintID, result)
}

// job reads the gate's view of one job; nil when it does not exist.
func (s pgMintStore) job(ctx context.Context, jobID string) (*mintJobGate, error) {
	var (
		runnerID, envID *string
		g               mintJobGate
	)
	err := s.cp.pool.QueryRow(ctx, `
		SELECT runner_id::text, job_type::text, status::text, environment_id::text
		FROM public.jobs WHERE id::text = $1`, jobID).Scan(&runnerID, &g.jobType, &g.status, &envID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if runnerID != nil {
		g.runnerID = *runnerID
	}
	if envID != nil {
		g.environmentID = *envID
	}
	return &g, nil
}

// mintRowSelect is the column list every row read uses, in scanMintRow's order.
const mintRowSelect = `
	SELECT id::text, org_id::text, cluster_id::text, coalesce(job_id::text, ''), tier::text, shape::text,
	       ttl_seconds, client_public_key, status::text, coalesce(sealed_result, ''),
	       coalesce(failure_reason, ''), private_endpoint, expires_at <= now(), created_at
	FROM public.kubeconfig_mint_requests`

// scanMintRow scans one mintRowSelect row; nil when there is none.
func scanMintRow(row pgx.Row) (*mintRequestRow, error) {
	var r mintRequestRow
	err := row.Scan(&r.ID, &r.OrgID, &r.ClusterID, &r.JobID, &r.Tier, &r.Shape, &r.TTLSeconds,
		&r.ClientPublicKey, &r.Status, &r.Sealed, &r.FailureReason, &r.PrivateEndpoint, &r.ExpiredNow, &r.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// mintRunner authenticates the runner the way the talosconfig channel does: id + token hash against
// the runners row.
func (cp *ControlPlane) mintRunner(w http.ResponseWriter, r *http.Request) (runnerID, tokenHash string, ok bool) {
	runnerID, tokenHash, ok = cp.authHash(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return "", "", false
	}
	authed, err := cp.talosDB().runnerAuthenticated(r.Context(), runnerID, tokenHash)
	if err != nil || !authed {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return "", "", false
	}
	return runnerID, tokenHash, true
}

// gatedMint runs the job gate and the row read shared by both routes, writing the refusal itself.
func (cp *ControlPlane) gatedMint(w http.ResponseWriter, r *http.Request, runnerID string) (*mintJobGate, *mintRequestRow, bool) {
	jobID := r.PathValue("id")
	job, err := cp.mintDB().job(r.Context(), jobID)
	if err != nil {
		http.Error(w, "could not read job", http.StatusInternalServerError)
		return nil, nil, false
	}
	if code, msg := mintGateRefusal(job, runnerID); code != 0 {
		writeJSON(w, code, map[string]any{"error": msg})
		return nil, nil, false
	}
	row, err := cp.mintDB().rowForJob(r.Context(), jobID)
	if err != nil {
		http.Error(w, "could not read the mint", http.StatusInternalServerError)
		return nil, nil, false
	}
	if code, msg := mintRowRefusal(row); code != 0 {
		writeJSON(w, code, map[string]any{"error": msg})
		return nil, nil, false
	}
	return job, row, true
}

// handleGetKubeconfigMint serves the owning runner the spec of the mint its job serves.
func (cp *ControlPlane) handleGetKubeconfigMint(w http.ResponseWriter, r *http.Request) {
	runnerID, _, ok := cp.mintRunner(w, r)
	if !ok {
		return
	}
	job, row, ok := cp.gatedMint(w, r, runnerID)
	if !ok {
		return
	}
	cp.aliasMintStateToEnvironmentDeploy(r.Context(), r.PathValue("id"), job.environmentID)
	writeJSON(w, http.StatusOK, types.RunnerKubeconfigMintSpec{
		MintID: row.ID, ClusterID: row.ClusterID, Tier: types.KubeconfigMintTier(row.Tier),
		Shape: types.KubeconfigMintShape(row.Shape), TTLSeconds: row.TTLSeconds, ClientPublicKey: row.ClientPublicKey,
	})
}

// aliasMintStateToEnvironmentDeploy points the mint job's state slot at the latest successful DEPLOY
// of its environment, unless the caller already aliased it (the runner-channel driver does, before the
// row exists). Best-effort: with no environment or no deploy there is nothing to alias, and the runner
// then reports the cluster as not found — which is the honest answer.
func (cp *ControlPlane) aliasMintStateToEnvironmentDeploy(ctx context.Context, mintJobID, environmentID string) {
	cp.mu.Lock()
	_, done := cp.stateAlias[mintJobID]
	cp.mu.Unlock()
	if done || environmentID == "" {
		return
	}
	deployID, err := cp.mintDB().latestDeploy(ctx, environmentID)
	if err != nil || deployID == "" {
		return
	}
	cp.AliasStateToJob(mintJobID, cp.resolveStateKey(deployID))
}

// resolveStateKey follows an existing alias, so a mint aliased onto a deploy that was itself aliased
// lands on the slot that holds the state.
func (cp *ControlPlane) resolveStateKey(jobID string) string {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return cp.resolveStateKeyLocked(jobID)
}

// handlePostKubeconfigMint lands the owning runner's result on the mint its job serves and completes
// the job, in one transaction. The body is never echoed or logged.
func (cp *ControlPlane) handlePostKubeconfigMint(w http.ResponseWriter, r *http.Request) {
	runnerID, tokenHash, ok := cp.mintRunner(w, r)
	if !ok {
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, mintResultMaxBytes+1))
	var result types.RunnerKubeconfigMintResult
	if err != nil || len(raw) > mintResultMaxBytes || json.Unmarshal(raw, &result) != nil || result.Validate() != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid kubeconfig mint result"})
		return
	}
	_, row, ok := cp.gatedMint(w, r, runnerID)
	if !ok {
		return
	}
	if row.ID != result.MintID {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "mint_id is not the mint this job serves"})
		return
	}
	code, msg := cp.mintDB().land(r.Context(), runnerID, tokenHash, r.PathValue("id"), row.ID, result)
	if code != http.StatusOK {
		writeJSON(w, code, map[string]any{"error": msg})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// landMintResult is recordMintResult's transaction: the row moves pending → ready/failed only while it
// is still pending and inside its window, and the job completes through update_job_status with the
// runner's own credentials. Nothing is written when either half refuses.
func (cp *ControlPlane) landMintResult(ctx context.Context, runnerID, tokenHash, jobID, mintID string, result types.RunnerKubeconfigMintResult) (int, string) {
	tx, err := cp.pool.Begin(ctx)
	if err != nil {
		return http.StatusInternalServerError, "Internal Server Error"
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		sealed, reason *string
		jobStatus      = "SUCCESS"
	)
	if result.Status == types.KubeconfigMintStatusReady {
		s := result.Sealed
		sealed = &s
	} else {
		s := result.Reason
		reason = &s
		jobStatus = "FAILED"
	}
	var moved string
	err = tx.QueryRow(ctx, `
		UPDATE public.kubeconfig_mint_requests
		SET status = $1::public.kubeconfig_mint_status, sealed_result = $2, failure_reason = $3, private_endpoint = $4
		WHERE id::text = $5 AND job_id::text = $6 AND status = 'pending' AND expires_at > now()
		RETURNING id::text`,
		string(result.Status), sealed, reason, result.PrivateEndpoint, mintID, jobID).Scan(&moved)
	if errors.Is(err, pgx.ErrNoRows) {
		return http.StatusConflict, "The kubeconfig mint already has a result"
	}
	if err != nil {
		return http.StatusInternalServerError, "Internal Server Error"
	}
	if _, err := tx.Exec(ctx, `SELECT public.update_job_status($1::uuid, $2, $3::uuid, $4, $5, NULL::jsonb)`,
		runnerID, tokenHash, jobID, jobStatus, reason); err != nil {
		return http.StatusConflict, "Job not found or not owned by this runner"
	}
	if err := tx.Commit(ctx); err != nil {
		return http.StatusInternalServerError, "Internal Server Error"
	}
	return http.StatusOK, ""
}

// ─────────────────────────── seeding for the runner-channel driver ───────────────────────────

// ensureMintCluster returns the project_cluster row the mint names, creating what is missing: the
// actor's profile (the request row's FK), a project when the run has no A0.5 graph, and the cluster
// row itself. An existing row for (project, environment) is reused — the console's per-env uniqueness
// — so a graph whose replayed finalize already wrote one is not duplicated.
func (cp *ControlPlane) ensureMintCluster(ctx context.Context, owner, projectID, envID, clusterName, region string) (clusterID, outProjectID string, err error) {
	if _, err := cp.pool.Exec(ctx, `INSERT INTO public.profiles (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, owner); err != nil {
		return "", "", fmt.Errorf("seed profile: %w", err)
	}
	if projectID == "" {
		projectID = newUUID()
		if _, err := cp.pool.Exec(ctx, `
			INSERT INTO public.projects (id, user_id, org_id, project_name, slug, region, iac_version)
			VALUES ($1, $2, $2, $3, $4, $5, '1.0.0')`,
			projectID, owner, "kc-mint-"+projectID[:8], "kc-mint-"+projectID[:8], region); err != nil {
			return "", "", fmt.Errorf("seed project: %w", err)
		}
	}
	var env any
	if envID != "" {
		env = envID
		err := cp.pool.QueryRow(ctx, `
			SELECT id::text FROM public.project_cluster
			WHERE project_id::text = $1 AND environment_id::text = $2 AND org_id::text = $3 LIMIT 1`,
			projectID, envID, owner).Scan(&clusterID)
		if err == nil {
			return clusterID, projectID, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", "", fmt.Errorf("read cluster row: %w", err)
		}
	}
	clusterID = newUUID()
	var name any
	if strings.TrimSpace(clusterName) != "" {
		name = clusterName
	}
	if _, err := cp.pool.Exec(ctx, `
		INSERT INTO public.project_cluster (id, project_id, org_id, environment_id, cluster_name)
		VALUES ($1, $2, $3, $4, $5)`, clusterID, projectID, owner, env, name); err != nil {
		return "", "", fmt.Errorf("seed cluster row: %w", err)
	}
	return clusterID, projectID, nil
}

// mintEnqueue is one mint the runner-channel driver queues, as the console's request route would.
type mintEnqueue struct {
	JobID           string // chosen by the caller, so the state alias exists before the row does
	Owner           string // user = org (community tenancy), and the runner's org
	ProjectID       string
	EnvironmentID   string // "" when the run has no A0.5 graph
	ClusterID       string
	Snapshot        []byte // the deploy's config_snapshot, verbatim — what the console copies
	Tier            string
	Shape           string
	TTLSeconds      int
	ClientPublicKey string
}

// enqueueKubeconfigMint writes the MINT_KUBECONFIG job and its request row in ONE transaction, as
// requestKubeconfigMint does, so the runner can never claim a job whose row does not exist yet.
// Returns the mint id.
func (cp *ControlPlane) enqueueKubeconfigMint(ctx context.Context, in mintEnqueue) (string, error) {
	tx, err := cp.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var env any
	if in.EnvironmentID != "" {
		env = in.EnvironmentID
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO public.jobs
		  (id, user_id, org_id, project_id, environment_id, job_type, config_snapshot, status, provider)
		VALUES ($1, $2, $2, $3, $4, 'MINT_KUBECONFIG', $5::jsonb, 'QUEUED', NULL)`,
		in.JobID, in.Owner, in.ProjectID, env, string(in.Snapshot)); err != nil {
		return "", fmt.Errorf("seed mint job: %w", err)
	}
	var mintID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO public.kubeconfig_mint_requests
		  (org_id, cluster_id, job_id, actor_user_id, tier, ttl_seconds, shape, client_public_key, expires_at)
		VALUES ($1, $2, $3, $1, $4::public.kubeconfig_mint_tier, $5, $6::public.kubeconfig_mint_shape, $7,
		        now() + make_interval(secs => $8))
		RETURNING id::text`,
		in.Owner, in.ClusterID, in.JobID, in.Tier, in.TTLSeconds, in.Shape, in.ClientPublicKey,
		int(mintRequestWindow.Seconds())).Scan(&mintID); err != nil {
		return "", fmt.Errorf("seed mint request: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return mintID, nil
}

// KubeconfigMintRow reads one request row by mint id; nil when it does not exist.
func (cp *ControlPlane) KubeconfigMintRow(ctx context.Context, mintID string) (*mintRequestRow, error) {
	return scanMintRow(cp.pool.QueryRow(ctx, mintRowSelect+` WHERE id::text = $1`, mintID))
}

// LatestKubeconfigMint reads the newest request row an org made for a tier and shape since a time —
// how the CLI driver finds the mint the CLI just made (the CLI prints no mint id), so the summary can
// carry its status, failure reason and endpoint privacy from the row rather than from CLI text.
func (cp *ControlPlane) LatestKubeconfigMint(ctx context.Context, orgID, tier, shape string, since time.Time) (*mintRequestRow, error) {
	return scanMintRow(cp.pool.QueryRow(ctx, mintRowSelect+`
		WHERE org_id::text = $1 AND tier::text = $2 AND shape::text = $3 AND created_at >= $4
		ORDER BY created_at DESC LIMIT 1`, orgID, tier, shape, since))
}
