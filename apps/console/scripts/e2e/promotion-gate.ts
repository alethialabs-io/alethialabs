// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E shim (BYOC B6.1): replay the REAL console promotion gate/approval/finalize actions against the
// migrated control-plane Postgres, from OUTSIDE Next.js — the sibling of scripts/e2e/finalize-deployment.ts.
//
// # Why this exists
//
// The T1/T2 Go control plane runs the authoritative provisioning SQL (claim_next_job /
// update_job_status / insert_job_log) but deliberately STOPS at that SSOT — it never runs the large
// TypeScript the real status route layers on top: `advancePromotionOnPlan` (evaluate a promotion's
// classification-enforced gates after its PLAN), `applyPromotionApproval` (satisfy the approval gate,
// enqueue the DEPLOY), and `finalizePromotionOnDeploy` (mark the promotion SUCCEEDED after its DEPLOY).
// So a green provisioning run never proved the GATED-PROMOTION chain (gap G14). Rather than
// re-implement the gate/approval/finalize logic divergently in Go, the B6.1 harness shells out to THIS
// shim, which imports and runs the ACTUAL exported console actions — the exact code the production
// status route (PLAN SUCCESS → advancePromotionOnPlan; DEPLOY SUCCESS → finalizeDeployment +
// finalizePromotionOnDeploy) and the approve action call. It connects via the same getServiceDb() the
// console uses (ALETHIA_DATABASE_URL), so every gate evaluation + CAS is byte-for-byte the real thing.
//
// # Usage (the Go harness invokes each subcommand with an ABSOLUTE NODE_PATH)
//
//	NODE_PATH=scripts/e2e/node-stubs tsx scripts/e2e/promotion-gate.ts advance-plan   <planJobId>
//	NODE_PATH=scripts/e2e/node-stubs tsx scripts/e2e/promotion-gate.ts approve        <promotionId> <approverUserId>
//	NODE_PATH=scripts/e2e/node-stubs tsx scripts/e2e/promotion-gate.ts finalize-deploy <deployJobId>
//
// `advance-plan`   → advancePromotionOnPlan(planJobId): evaluate the gates once the PLAN succeeded
//                    (blocks / parks for approval / enqueues DEPLOY).
// `approve`        → applyPromotionApproval(promotionId, approverUserId): satisfy one approval slot
//                    via the real race-safe CAS + re-evaluate; enqueues DEPLOY once every gate clears.
// `finalize-deploy`→ mirrors the status route's DEPLOY-SUCCESS branch: finalizeDeployment(deployJobId)
//                    (env → ACTIVE via the set_env_status CAS) THEN finalizePromotionOnDeploy(deployJobId)
//                    (promotion → SUCCEEDED). Order + both calls match app/api/jobs/[id]/status/route.ts.
//
// The transitive `import "server-only"` (pulled in via lib/addons/inspection-persistence) is not
// resolvable outside Next's bundler, so NODE_PATH points at the committed no-op stubs (server-only /
// client-only) — React stays on its normal build. Exit 0 on success, non-zero on any error.

import { finalizeDeployment } from "@/app/server/actions/deployments";
import {
	advancePromotionOnPlan,
	applyPromotionApproval,
	finalizePromotionOnDeploy,
} from "@/app/server/actions/promotions";

/** Dispatches the requested promotion-chain step against the real console actions. */
async function main(): Promise<void> {
	if (!process.env.ALETHIA_DATABASE_URL) {
		throw new Error("ALETHIA_DATABASE_URL is unset (the migrated control-plane DB)");
	}
	const [cmd, ...args] = process.argv.slice(2);
	switch (cmd) {
		case "advance-plan": {
			const planJobId = requireArg(args[0], "advance-plan <planJobId>");
			await advancePromotionOnPlan(planJobId);
			console.log(`advancePromotionOnPlan(${planJobId}) completed`);
			return;
		}
		case "approve": {
			const promotionId = requireArg(args[0], "approve <promotionId> <approverUserId>");
			const approverUserId = requireArg(args[1], "approve <promotionId> <approverUserId>");
			await applyPromotionApproval(promotionId, approverUserId, "e2e approval (BYOC B6.1)");
			console.log(`applyPromotionApproval(${promotionId}) completed`);
			return;
		}
		case "finalize-deploy": {
			const deployJobId = requireArg(args[0], "finalize-deploy <deployJobId>");
			// Exactly the status route's DEPLOY-SUCCESS ordering: env → ACTIVE first, then the
			// promotion → SUCCEEDED. finalizeDeployment no-ops unless the job is a SUCCESS DEPLOY with
			// an environment; finalizePromotionOnDeploy no-ops unless the job backs a promotion.
			await finalizeDeployment(deployJobId);
			await finalizePromotionOnDeploy(deployJobId);
			console.log(`finalizeDeployment + finalizePromotionOnDeploy(${deployJobId}) completed`);
			return;
		}
		default:
			throw new Error(
				`unknown subcommand ${cmd ?? "(none)"} — expected advance-plan | approve | finalize-deploy`,
			);
	}
}

/** Returns `v` or throws a usage error naming the expected form. */
function requireArg(v: string | undefined, usage: string): string {
	if (!v) throw new Error(`usage: promotion-gate.ts ${usage}`);
	return v;
}

main()
	// postgres-js keeps the event loop alive via its pool; exit explicitly so the shim returns.
	.then(() => process.exit(0))
	.catch((err: unknown) => {
		console.error(
			`promotion-gate failed: ${err instanceof Error ? err.stack || err.message : String(err)}`,
		);
		process.exit(1);
	});
