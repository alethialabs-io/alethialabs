// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_b6

// Gated dev→staging promotion (BYOC B6.1) — the ORCHESTRATION half, driven via *testing.T. Compiled
// only under the e2e_b6 tag (like t2_provision_test.go under e2e_t2); the pure helpers it calls live
// in the untagged t2_b6_promotion.go so they stay unit-testable without Postgres. See that file's
// header for what B6.1 closes (gap G14).
//
// Run it against a migrated control-plane Postgres (no cloud, no kind — the whole gate→approval→
// finalize chain is console + DB logic):
//
//	cd test/e2e
//	ALETHIA_DATABASE_URL=postgres://… GOWORK=off go test -tags=e2e_b6 ./... -run TestB6GatedPromotion -v
//
// # How each way this could go VACUOUS is defeated
//
//   - the gate "blocks" without really being enforced → the env's own protection rules are ALL OFF,
//     and a REFUTER promotion seeded WITHOUT the classification tag is asserted to sail straight to
//     DEPLOYING. So the block can only come from the classification enforcement (the label is the policy).
//   - the approval is faked → we drive the REAL applyPromotionApproval (the shared body of the
//     approve action) through the shim; it claims a real slot via the race-safe CAS and re-runs the
//     REAL gate engine. We assert a slot was materialized AND filled AND the gate cleared to DEPLOYING.
//   - "deploy applied" is asserted without a real transition → the enqueued DEPLOY job is driven to
//     SUCCESS through the REAL update_job_status SSOT (asserted applied), not a bare UPDATE.
//   - finalize is asserted without the real transition → we replay the REAL finalizeDeployment +
//     finalizePromotionOnDeploy; the promotion must reach SUCCEEDED and the target env ACTIVE.
//   - an un-approved promotion could finalize → a NEGATIVE case proves a PENDING_APPROVAL promotion
//     never gets a deploy_job_id, and a verify-hard-failure promotion is BLOCKED, never DEPLOYed.
package e2e

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// b6RequireOrSkip skips (or, under ALETHIA_E2E_B6_REQUIRE, HARD-FAILS) when a prerequisite is missing
// — so a merge-queue run can't hollow out to a green no-op, while a dev laptop skips cleanly.
func b6RequireOrSkip(t *testing.T, cond bool, msg string) {
	t.Helper()
	if cond {
		return
	}
	if b6Truthy(strings.TrimSpace(os.Getenv("ALETHIA_E2E_B6_REQUIRE"))) {
		t.Fatalf("B6.1 prerequisite missing (ALETHIA_E2E_B6_REQUIRE set): %s", msg)
	}
	t.Skipf("B6.1 prerequisite missing: %s", msg)
}

// b6HaveBin reports whether a binary is on PATH.
func b6HaveBin(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// b6RepoRoot resolves the repository root relative to THIS file (test/e2e/<file>).
func b6RepoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root, err := filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	return root
}

func TestB6GatedPromotion(t *testing.T) {
	// Prereqs: the migrated control-plane DB + pnpm (to run the tsx shim). No cloud, no kind.
	dbURL := strings.TrimSpace(os.Getenv("ALETHIA_DATABASE_URL"))
	b6RequireOrSkip(t, dbURL != "", "ALETHIA_DATABASE_URL is unset (the migrated control-plane DB)")
	b6RequireOrSkip(t, b6HaveBin("pnpm"), "pnpm not on PATH (needed to run the promotion-gate shim)")

	root := b6RepoRoot(t)
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()

	cp, err := NewControlPlane(ctx, dbURL)
	if err != nil {
		t.Fatalf("control plane: %v", err)
	}
	t.Cleanup(cp.Close)
	// A seeded runner so the enqueued DEPLOY can reach SUCCESS through the REAL update_job_status SSOT.
	// B6 drives the job via MarkDeployJobSucceeded (a direct SSOT transition), not by claiming it, so
	// the runner's org need not match the job's — a fresh owner is fine.
	runnerOwner := newUUID()
	if _, _, err := cp.SeedRunner(ctx, runnerOwner, runnerOwner); err != nil {
		t.Fatalf("seed runner: %v", err)
	}

	// shim runs a promotion-chain step, failing the test loudly (with shim output) on any error.
	shim := func(label string, args ...string) {
		t.Helper()
		var out bytes.Buffer
		if err := runPromotionGateShim(ctx, root, dbURL, &out, args...); err != nil {
			t.Fatalf("%s shim failed: %v\n──── shim output ────\n%s", label, err, out.String())
		}
		t.Logf("%s: %s", label, strings.TrimSpace(out.String()))
	}

	// ─────────────────────────── the happy chain (the 4 steps) ───────────────────────────

	g, err := cp.SeedPromotionGraph(ctx, b6SeedOpts{
		Project:      "b6-gated-" + newUUID()[:8],
		Enforce:      true, // classification value forces approval + verify on the target
		MinApprovals: 1,
		VerifyFails:  false, // a CLEAN verify report → the verify gate passes; approval is what parks it
	})
	if err != nil {
		t.Fatalf("seed promotion graph: %v", err)
	}
	t.Logf("seeded gated promotion %s (dev %s → staging %s), plan job %s",
		g.promotionID, g.sourceEnvID, g.targetEnvID, g.planJobID)

	// STEP 1 — GATE BLOCKS: evaluate the gates after the PLAN succeeded. The classification tag forces
	// approval, so the promotion must PARK at PENDING_APPROVAL with a real approval slot — it CANNOT
	// proceed to a DEPLOY.
	shim("step 1 advance-plan", "advance-plan", g.planJobID)
	status, deployJobID, gateRaw, err := cp.PromotionState(ctx, g.promotionID)
	if err != nil {
		t.Fatalf("read promotion after advance-plan: %v", err)
	}
	if status != "PENDING_APPROVAL" {
		t.Fatalf("step 1: promotion status = %q, want PENDING_APPROVAL (the classification-forced approval gate must block)", status)
	}
	if deployJobID != "" {
		t.Fatalf("step 1: a DEPLOY job (%s) was enqueued while the gate should still block", deployJobID)
	}
	eval, err := b6ParseGateEvaluation(gateRaw)
	if err != nil {
		t.Fatalf("parse gate evaluation: %v", err)
	}
	if eval == nil || eval.Overall != "pending_approval" {
		t.Fatalf("step 1: gate evaluation overall = %v, want pending_approval; raw=%s", eval, gateRaw)
	}
	if s := eval.ByType["manual_approval"]; s != "pending" {
		t.Fatalf("step 1: manual_approval gate = %q, want pending (the forced approval); raw=%s", s, gateRaw)
	}
	if s := eval.ByType["verify_pass"]; s != "pass" {
		t.Fatalf("step 1: verify_pass gate = %q, want pass (clean report, but the gate WAS forced+evaluated); raw=%s", s, gateRaw)
	}
	total, approved, err := cp.ApprovalSlotCounts(ctx, g.promotionID)
	if err != nil {
		t.Fatalf("read approval slots: %v", err)
	}
	if total != 1 || approved != 0 {
		t.Fatalf("step 1: approval slots = %d total / %d approved, want 1 / 0 (classification min_approvals materialized a real, unfilled slot)", total, approved)
	}
	t.Logf("step 1 ✓ GATE BLOCKS: PENDING_APPROVAL, 1 unfilled approval slot, verify gate forced+passed")

	// STEP 2 — APPROVAL SATISFIES: satisfy the required approval through the REAL approval CAS +
	// gate re-evaluation. Every gate now clears → the promotion enqueues a real DEPLOY job.
	shim("step 2 approve", "approve", g.promotionID, g.userID)
	status, deployJobID, gateRaw, err = cp.PromotionState(ctx, g.promotionID)
	if err != nil {
		t.Fatalf("read promotion after approve: %v", err)
	}
	if status != "DEPLOYING" {
		t.Fatalf("step 2: promotion status = %q, want DEPLOYING (approval should clear the gate and enqueue the DEPLOY)", status)
	}
	if deployJobID == "" {
		t.Fatal("step 2: no deploy_job_id — the cleared gate did not enqueue a DEPLOY job")
	}
	if _, a, err := cp.ApprovalSlotCounts(ctx, g.promotionID); err != nil {
		t.Fatalf("read approval slots after approve: %v", err)
	} else if a != 1 {
		t.Fatalf("step 2: approved slots = %d, want 1 (the CAS must have filled the slot)", a)
	}
	if eval, _ := b6ParseGateEvaluation(gateRaw); eval == nil || eval.Overall != "pass" {
		t.Fatalf("step 2: gate evaluation overall = %v, want pass; raw=%s", eval, gateRaw)
	}
	if djs, err := cp.JobStatus(ctx, deployJobID); err != nil {
		t.Fatalf("read deploy job: %v", err)
	} else if djs != "QUEUED" {
		t.Fatalf("step 2: enqueued DEPLOY job status = %q, want QUEUED", djs)
	}
	t.Logf("step 2 ✓ APPROVAL SATISFIES: DEPLOYING, slot filled, DEPLOY job %s QUEUED", deployJobID)

	// STEP 3 — DEPLOY APPLIES: drive the enqueued DEPLOY job to SUCCESS through the REAL
	// update_job_status SSOT (the authoritative terminal transition, not a bare UPDATE).
	if err := cp.MarkDeployJobSucceeded(ctx, deployJobID); err != nil {
		t.Fatalf("step 3: drive DEPLOY to SUCCESS via update_job_status: %v", err)
	}
	if djs, err := cp.JobStatus(ctx, deployJobID); err != nil {
		t.Fatalf("read deploy job status: %v", err)
	} else if djs != "SUCCESS" {
		t.Fatalf("step 3: DEPLOY job status = %q, want SUCCESS", djs)
	}
	t.Logf("step 3 ✓ DEPLOY APPLIES: DEPLOY job %s reached SUCCESS via the real SSOT", deployJobID)

	// STEP 4 — FINALIZE: replay the status route's DEPLOY-SUCCESS branch (finalizeDeployment then
	// finalizePromotionOnDeploy). The promotion must reach SUCCEEDED and the target env ACTIVE.
	shim("step 4 finalize-deploy", "finalize-deploy", deployJobID)
	status, _, _, err = cp.PromotionState(ctx, g.promotionID)
	if err != nil {
		t.Fatalf("read promotion after finalize: %v", err)
	}
	if status != "SUCCEEDED" {
		t.Fatalf("step 4: promotion status = %q, want SUCCEEDED (finalizePromotionOnDeploy did not transition it)", status)
	}
	if envStatus, err := cp.EnvStatus(ctx, g.targetEnvID); err != nil {
		t.Fatalf("read target env status: %v", err)
	} else if envStatus != "ACTIVE" {
		t.Fatalf("step 4: target env status = %q, want ACTIVE (finalizeDeployment's deploySuccess CAS did not move it)", envStatus)
	}
	t.Logf("step 4 ✓ FINALIZE: promotion SUCCEEDED, target env %s ACTIVE", g.targetEnvID)

	// ─────────────────────────── refuters (non-vacuity) ───────────────────────────
	t.Run("refuter_untagged_promotes_freely", func(t *testing.T) {
		// IDENTICAL setup but WITHOUT the classification tag: with every protection rule off and no
		// enforcing value, the gates all pass → the promotion goes straight to DEPLOYING. This proves
		// the classification tag is genuinely what blocked the happy-path promotion (not some ambient
		// default). If this refuter ALSO parked at PENDING_APPROVAL, step 1's block would be vacuous.
		rg, err := cp.SeedPromotionGraph(ctx, b6SeedOpts{
			Project: "b6-refuterA-" + newUUID()[:8],
			Enforce: false, // NO classification enforcement
		})
		if err != nil {
			t.Fatalf("seed refuter graph: %v", err)
		}
		shim("refuterA advance-plan", "advance-plan", rg.planJobID)
		st, dj, _, err := cp.PromotionState(ctx, rg.promotionID)
		if err != nil {
			t.Fatalf("read refuter promotion: %v", err)
		}
		if st != "DEPLOYING" {
			t.Fatalf("refuterA: status = %q, want DEPLOYING — an UNTAGGED promotion (rules all off) must NOT block; the happy-path block would be vacuous", st)
		}
		if dj == "" {
			t.Fatal("refuterA: no deploy_job_id — an unblocked promotion should have enqueued a DEPLOY")
		}
		if _, a, _ := cp.ApprovalSlotCounts(ctx, rg.promotionID); a != 0 {
			// (No approval slots should exist at all; belt-and-braces.)
			total, _, _ := cp.ApprovalSlotCounts(ctx, rg.promotionID)
			t.Fatalf("refuterA: %d approval slots on an untagged promotion, want 0", total)
		}
		t.Logf("refuterA ✓ untagged promotion went straight to DEPLOYING — the tag is what blocks")
	})

	t.Run("refuter_verify_hardfail_blocks_and_never_finalizes", func(t *testing.T) {
		// A tagged promotion whose plan carries an UNWAIVED HARD verify failure must be BLOCKED (a
		// hard gate failure), never DEPLOYed — and because it never gets a deploy_job_id, it can never
		// be finalized. This proves the verify gate has teeth AND that finalize can't fire on an
		// un-approved/blocked promotion (the "un-approved must NOT finalize" negative).
		bg, err := cp.SeedPromotionGraph(ctx, b6SeedOpts{
			Project:      "b6-refuterB-" + newUUID()[:8],
			Enforce:      true,
			MinApprovals: 1,
			VerifyFails:  true, // one unwaived hard control failure
		})
		if err != nil {
			t.Fatalf("seed refuter-B graph: %v", err)
		}
		shim("refuterB advance-plan", "advance-plan", bg.planJobID)
		st, dj, gr, err := cp.PromotionState(ctx, bg.promotionID)
		if err != nil {
			t.Fatalf("read refuter-B promotion: %v", err)
		}
		if st != "BLOCKED" {
			t.Fatalf("refuterB: status = %q, want BLOCKED (an unwaived hard verify failure is a hard gate fail)", st)
		}
		if dj != "" {
			t.Fatalf("refuterB: a DEPLOY job (%s) was enqueued despite a hard verify failure", dj)
		}
		if eval, _ := b6ParseGateEvaluation(gr); eval == nil || eval.ByType["verify_pass"] != "fail" {
			t.Fatalf("refuterB: verify_pass gate = %v, want fail; raw=%s", eval, gr)
		}
		// The un-approved-must-not-finalize negative: replay finalize against THIS blocked promotion's
		// plan job id (it has no deploy job). finalizePromotionOnDeploy keys on deploy_job_id, so it is
		// a no-op — the promotion must stay BLOCKED, never flip to SUCCEEDED.
		shim("refuterB finalize-attempt", "finalize-deploy", bg.planJobID)
		st2, _, _, err := cp.PromotionState(ctx, bg.promotionID)
		if err != nil {
			t.Fatalf("re-read refuter-B promotion: %v", err)
		}
		if st2 != "BLOCKED" {
			t.Fatalf("refuterB: status after a finalize attempt = %q, want BLOCKED — a blocked/un-approved promotion must NEVER finalize", st2)
		}
		t.Logf("refuterB ✓ hard verify failure BLOCKED and did not finalize")
	})
}
