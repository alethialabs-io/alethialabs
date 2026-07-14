// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Gated dev→staging promotion (BYOC B6.1) — the PURE, reusable half. Deliberately UNTAGGED (like
// controlplane.go / t2_console_active.go) so `go mod tidy` sees its deps and the pure helpers are
// unit-testable WITHOUT Postgres, a cloud, or a build tag.
//
// # What B6.1 closes (gap G14: "Promotion/classification gates never driven to a real apply")
//
// The T1/T2 Go control plane executes the authoritative provisioning SQL, but STOPS at that SSOT — it
// never runs the TypeScript the real status route layers on top when a promotion's jobs complete:
// advancePromotionOnPlan (evaluate the target env's classification-enforced gates after the PLAN),
// applyPromotionApproval (satisfy the approval gate + enqueue the DEPLOY), and finalizePromotionOnDeploy
// (mark the promotion SUCCEEDED after the DEPLOY). So no green run ever proved the GATED-PROMOTION chain.
//
// B6.1 drives the whole chain against a real migrated Postgres, WITHOUT re-implementing any gate logic
// in Go: it seeds the console object graph (project + dev/staging envs + a plan job + a promotion +,
// on the target, a classification value whose enforcement forces approval + verify), then shells out
// to the tsx shim (scripts/e2e/promotion-gate.ts) that runs the ACTUAL exported console actions:
//
//	1. GATE BLOCKS      advancePromotionOnPlan(planJob) → PENDING_APPROVAL (approval slot materialized).
//	2. APPROVAL CLEARS  applyPromotionApproval(promotion, approver) → DEPLOYING + a QUEUED DEPLOY job.
//	3. DEPLOY APPLIES   the enqueued DEPLOY job → SUCCESS through the REAL update_job_status SSOT.
//	4. FINALIZE         finalizeDeployment (env→ACTIVE) + finalizePromotionOnDeploy (promotion→SUCCEEDED).
//
// Non-vacuity is asserted at every step (see t2_b6_promotion_run_test.go): the env's own protection
// rules are ALL OFF, so a REFUTER promotion WITHOUT the classification tag sails straight to DEPLOYING —
// proving the tag is genuinely what blocked; an un-approved promotion never gets a deploy_job_id so it
// can never finalize; and a verify report with an unwaived hard failure BLOCKS (never DEPLOYs).
package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// runPromotionGateShim replays a step of the REAL console promotion chain by shelling the tsx shim
// (scripts/e2e/promotion-gate.ts) against the same Postgres — the sibling of A0.5's
// runFinalizeDeploymentShim. NODE_PATH points at the committed server-only/client-only no-op stubs so
// the console's server modules load under a plain Node process. `args` is the subcommand + its
// operands (e.g. "advance-plan", planJobID). Returns the shim's error; the caller decides warn vs fail.
func runPromotionGateShim(ctx context.Context, root, dbURL string, out io.Writer, args ...string) error {
	cctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	argv := append([]string{"-F", "console", "exec", "tsx", "scripts/e2e/promotion-gate.ts"}, args...)
	cmd := exec.CommandContext(cctx, "pnpm", argv...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(),
		"ALETHIA_DATABASE_URL="+dbURL,
		"NODE_PATH="+filepath.Join(root, "apps", "console", "scripts", "e2e", "node-stubs"),
	)
	cmd.Stdout = out
	cmd.Stderr = out
	return cmd.Run()
}

// b6Truthy reports whether an env flag is set to an on-value (1/true/yes/on, case-insensitive).
// (Local copy so this file's helpers don't depend on the a05*/isTruthy definitions' build tags.)
func b6Truthy(v string) bool {
	switch v {
	case "1", "true", "TRUE", "True", "yes", "YES", "on", "ON":
		return true
	}
	return false
}

// b6Graph is the seeded console object graph the promotion chain drives.
type b6Graph struct {
	orgID, userID, projectID string
	sourceEnvID, targetEnvID string
	planJobID, promotionID   string
	candidateHash            string
	// enforced records whether a classification value forcing approval+verify was pinned on the
	// target env (the thing that must BLOCK the promotion). A refuter graph leaves it false.
	enforced bool
}

// b6SeedOpts parameterizes a seeded promotion graph.
type b6SeedOpts struct {
	// Project name (also used to derive the env slugs). Distinct per call keeps parallel/leftover
	// rows from colliding.
	Project string
	// Enforce pins a classification value with enforcement {require_approval, require_verify_pass} on
	// the TARGET env, so a promotion into it inherits the approval + verify gates. Left false for the
	// refuter graph that proves the tag is what blocks.
	Enforce bool
	// MinApprovals is the enforcement.min_approvals (>=1) when Enforce; ignored otherwise.
	MinApprovals int
	// VerifyFails seeds the plan job's verify_result with ONE unwaived hard control failure, so the
	// verify gate FAILS (→ the promotion must be BLOCKED, never DEPLOYed). Left false → a clean report.
	VerifyFails bool
}

// b6VerifyResultMetadata returns the plan job's execution_metadata JSON carrying a verify_result the
// gate engine reads (report.controls[].status/id). fail=false → a clean report (no hard failures, the
// verify gate passes); fail=true → one unwaived hard control failure (the verify gate fails). PURE.
func b6VerifyResultMetadata(fail bool) string {
	controls := "[]"
	if fail {
		// The gate only reads .id + .status; the extra fields mirror a real verify.Control for realism.
		controls = `[{"id":"KEYLESS-001","title":"No long-lived cloud keys","status":"fail","severity":"hard","detail":"static access key present"}]`
	}
	return fmt.Sprintf(`{"verify_result":{"controls":%s}}`, controls)
}

// b6Enforcement returns the classification value's enforcement jsonb (label drives policy): force both
// the approval gate (with minApprovals) and the verify gate. PURE.
func b6Enforcement(minApprovals int) string {
	if minApprovals < 1 {
		minApprovals = 1
	}
	return fmt.Sprintf(`{"require_approval":true,"require_verify_pass":true,"min_approvals":%d}`, minApprovals)
}

// b6GateEvaluation is the parsed shape of environment_promotions.gate_evaluations (mirrors the TS
// GateEvaluation): the overall decision + each gate's status keyed by its type.
type b6GateEvaluation struct {
	Overall string            // "pass" | "blocked" | "pending_approval"
	ByType  map[string]string // gate type ("manual_approval"/"verify_pass"/…) → status
}

// b6ParseGateEvaluation parses a stored gate_evaluations blob into the overall decision + a
// type→status map. An empty/absent blob is a nil evaluation (not an error — the promotion may not
// have been evaluated yet). PURE — unit-tested in t2_b6_promotion_pure_test.go.
func b6ParseGateEvaluation(raw []byte) (*b6GateEvaluation, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var doc struct {
		Overall string `json:"overall"`
		Results []struct {
			Type   string `json:"type"`
			Status string `json:"status"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse gate_evaluations: %w", err)
	}
	byType := make(map[string]string, len(doc.Results))
	for _, r := range doc.Results {
		byType[r.Type] = r.Status
	}
	return &b6GateEvaluation{Overall: doc.Overall, ByType: byType}, nil
}

// SeedPromotionGraph inserts the minimal real console rows for a gated dev→staging promotion:
//   - a project + a `development` source env + a `staging` target env (both ACTIVE so the target's
//     enqueueDeploy CAS is legal),
//   - an environment_protection_rules row with EVERY toggle OFF (so the env's own rules cannot be
//     what blocks — only the classification tag can),
//   - a SUCCESS PLAN job carrying a verify_result (clean, or one hard failure under VerifyFails),
//   - a PENDING_PLAN promotion linked to that plan job,
//   - and, under Enforce, a classification dimension + an enforcing value pinned to the TARGET env.
//
// Nothing here runs a real PLAN/apply — the runner never reads these; only the replayed console
// actions (via the shim) do. Returns the graph so the shim + assertions can reference its ids.
func (cp *ControlPlane) SeedPromotionGraph(ctx context.Context, opts b6SeedOpts) (*b6Graph, error) {
	g := &b6Graph{
		userID:        newUUID(),
		projectID:     newUUID(),
		sourceEnvID:   newUUID(),
		targetEnvID:   newUUID(),
		planJobID:     newUUID(),
		promotionID:   newUUID(),
		candidateHash: "b6-" + newUUID(),
		enforced:      opts.Enforce,
	}
	g.orgID = g.userID // community tenancy: org_id == user_id

	if _, err := cp.pool.Exec(ctx, `
		INSERT INTO public.projects (id, user_id, org_id, project_name, slug, region, iac_version)
		VALUES ($1, $2, $2, $3, $4, 'nbg1', '1.0.0')`,
		g.projectID, g.userID, opts.Project, "b6-"+g.projectID[:8]); err != nil {
		return nil, fmt.Errorf("seed project: %w", err)
	}
	// Source = development, target = staging; both ACTIVE (a real promotion into a live staging env).
	for _, e := range []struct {
		id, name, stage string
		isDefault       bool
	}{
		{g.sourceEnvID, "development", "development", true},
		{g.targetEnvID, "staging", "staging", false},
	} {
		if _, err := cp.pool.Exec(ctx, `
			INSERT INTO public.project_environments
			  (id, project_id, user_id, org_id, name, stage, status, is_default)
			VALUES ($1, $2, $3, $3, $4, $5, 'ACTIVE', $6)`,
			e.id, g.projectID, g.userID, e.name, e.stage, e.isDefault); err != nil {
			return nil, fmt.Errorf("seed %s env: %w", e.name, err)
		}
	}
	// Protection rule with EVERY gate OFF — so the ONLY thing that can force approval/verify is the
	// classification tag (the non-vacuity anchor: the refuter graph, no tag, promotes freely).
	if _, err := cp.pool.Exec(ctx, `
		INSERT INTO public.environment_protection_rules
		  (id, project_id, environment_id, user_id, org_id,
		   require_predecessor, require_verify_pass, require_approval)
		VALUES ($1, $2, $3, $4, $4, false, false, false)`,
		newUUID(), g.projectID, g.targetEnvID, g.userID); err != nil {
		return nil, fmt.Errorf("seed protection rule: %w", err)
	}
	// The promotion's PLAN job — already SUCCESS, carrying a verify_result the gate engine reads.
	if _, err := cp.pool.Exec(ctx, `
		INSERT INTO public.jobs
		  (id, user_id, org_id, project_id, environment_id, job_type, config_snapshot, status,
		   provider, execution_metadata)
		VALUES ($1, $2, $2, $3, $4, 'PLAN', $5::jsonb, 'SUCCESS', NULL, $6::jsonb)`,
		g.planJobID, g.userID, g.projectID, g.targetEnvID,
		`{"id":"b6","provider":"hetzner","environment_stage":"staging"}`,
		b6VerifyResultMetadata(opts.VerifyFails)); err != nil {
		return nil, fmt.Errorf("seed plan job: %w", err)
	}
	// The promotion itself — PENDING_PLAN, linked to the plan job (advancePromotionOnPlan finds it by
	// plan_job_id). candidate_hash mirrors the frozen source design.
	if _, err := cp.pool.Exec(ctx, `
		INSERT INTO public.environment_promotions
		  (id, project_id, user_id, org_id, source_environment_id, target_environment_id,
		   status, candidate_hash, plan_job_id)
		VALUES ($1, $2, $3, $3, $4, $5, 'PENDING_PLAN', $6, $7)`,
		g.promotionID, g.projectID, g.userID, g.sourceEnvID, g.targetEnvID,
		g.candidateHash, g.planJobID); err != nil {
		return nil, fmt.Errorf("seed promotion: %w", err)
	}
	// Under Enforce, tag the TARGET env with a classification value whose enforcement forces the
	// approval + verify gates (label drives policy). getEnforcingValuesFor reads exactly this.
	if opts.Enforce {
		dimID, valID := newUUID(), newUUID()
		if _, err := cp.pool.Exec(ctx, `
			INSERT INTO public.classification_dimension (id, org_id, created_by, key, label, multi)
			VALUES ($1, $2, $2, 'environment', 'Environment', false)`,
			dimID, g.orgID); err != nil {
			return nil, fmt.Errorf("seed classification dimension: %w", err)
		}
		if _, err := cp.pool.Exec(ctx, `
			INSERT INTO public.classification_value (id, org_id, dimension_id, value, label, enforcement)
			VALUES ($1, $2, $3, 'production', 'Production', $4::jsonb)`,
			valID, g.orgID, dimID, b6Enforcement(opts.MinApprovals)); err != nil {
			return nil, fmt.Errorf("seed classification value: %w", err)
		}
		if _, err := cp.pool.Exec(ctx, `
			INSERT INTO public.classification_assignment
			  (id, org_id, dimension_id, value_id, resource_kind, resource_id, assigned_by)
			VALUES ($1, $2, $3, $4, 'project_environment', $5, $2)`,
			newUUID(), g.orgID, dimID, valID, g.targetEnvID); err != nil {
			return nil, fmt.Errorf("seed classification assignment: %w", err)
		}
	}
	return g, nil
}

// PromotionState reads a promotion's current status, its deploy_job_id (empty until a DEPLOY was
// enqueued), and its stored gate_evaluations blob — straight from the row the console actions write.
func (cp *ControlPlane) PromotionState(ctx context.Context, promotionID string) (status, deployJobID string, gateEval []byte, err error) {
	var deploy *string
	err = cp.pool.QueryRow(ctx, `
		SELECT status::text, deploy_job_id::text, gate_evaluations
		FROM public.environment_promotions WHERE id = $1`, promotionID).
		Scan(&status, &deploy, &gateEval)
	if deploy != nil {
		deployJobID = *deploy
	}
	return status, deployJobID, gateEval, err
}

// ApprovalSlotCounts returns the total number of approval slots materialized for a promotion and how
// many are approved — proof the classification-forced approval created a real slot the CAS filled.
func (cp *ControlPlane) ApprovalSlotCounts(ctx context.Context, promotionID string) (total, approved int, err error) {
	err = cp.pool.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE status = 'approved')
		FROM public.promotion_approvals WHERE promotion_id = $1`, promotionID).
		Scan(&total, &approved)
	return total, approved, err
}

// JobStatus reads one job's status (the DEPLOY the promotion enqueued reaches SUCCESS through the SSOT).
func (cp *ControlPlane) JobStatus(ctx context.Context, jobID string) (string, error) {
	var status string
	err := cp.pool.QueryRow(ctx, `SELECT status::text FROM public.jobs WHERE id = $1`, jobID).Scan(&status)
	return status, err
}

// MarkDeployJobSucceeded drives the promotion's enqueued DEPLOY job to SUCCESS through the REAL
// authoritative SSOT (update_job_status) — the same RPC the console status route calls on a runner's
// terminal callback. It first assigns the seeded runner to the job (the deterministic analogue of a
// claim, avoiding claim_next_job's SKIP-LOCKED nondeterminism in a shared CI database), then posts
// SUCCESS with an empty execution_metadata blob (so finalizeDeployment's metadata guard passes and it
// moves the env to ACTIVE). Requires SeedRunner to have run. Returns an error if the RPC did not apply.
func (cp *ControlPlane) MarkDeployJobSucceeded(ctx context.Context, deployJobID string) error {
	if cp.runnerID == "" {
		return fmt.Errorf("no seeded runner — call SeedRunner before MarkDeployJobSucceeded")
	}
	if _, err := cp.pool.Exec(ctx, `
		UPDATE public.jobs
		SET runner_id = $2, assigned_runner_id = $2, status = 'PROCESSING',
		    claimed_at = now(), started_at = now()
		WHERE id = $1`, deployJobID, cp.runnerID); err != nil {
		return fmt.Errorf("assign runner to deploy job: %w", err)
	}
	tokenHash := sha256Hex(cp.runnerToken)
	var applied bool
	if err := cp.pool.QueryRow(ctx, `
		SELECT public.update_job_status($1::uuid, $2, $3::uuid, 'SUCCESS', NULL, '{}'::jsonb)`,
		cp.runnerID, tokenHash, deployJobID).Scan(&applied); err != nil {
		return fmt.Errorf("update_job_status(SUCCESS): %w", err)
	}
	if !applied {
		return fmt.Errorf("update_job_status did not apply — the DEPLOY job was already terminal or unowned")
	}
	return nil
}
