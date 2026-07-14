// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E shim (BYOC A0.5): replay the REAL console finalizeDeployment against the migrated
// control-plane Postgres, from OUTSIDE Next.js.
//
// # Why this exists
//
// The T2 real-cloud harness (test/e2e) drives the real runner against a Go control plane that
// speaks the runner API and executes the SAME authoritative SQL the console does (claim_next_job /
// update_job_status / insert_job_log). But that Go control plane deliberately STOPS at the SQL
// SSOT — it does NOT run the large TypeScript orchestration the real status route layers on top:
// finalizeDeployment (env → ACTIVE via the set_env_status CAS + persisted add-on health / security
// posture rows). That gap is exactly why a green T2 never proved "console marks the env ACTIVE"
// (gap G11 / the FIDELITY BOUNDARY comment in controlplane.go).
//
// Rather than RE-IMPLEMENT finalizeDeployment in Go (the divergence trap that made the synthetic
// snapshot a liability), the harness shells out to THIS shim, which imports and runs the ACTUAL
// exported `finalizeDeployment` — the same code path the production status route calls on a
// successful DEPLOY. It connects to ALETHIA_DATABASE_URL via the same getServiceDb() the console
// uses, so the env transition + health-row writes are byte-for-byte the real thing.
//
// # Usage
//
//	ALETHIA_DATABASE_URL=… tsx scripts/e2e/finalize-deployment.ts <jobId>
//
// The transitive `import "server-only"` (pulled in via lib/addons/inspection-persistence) is not
// resolvable outside Next's bundler, so point NODE_PATH at the committed no-op stubs so it (and
// `client-only`) resolve — with React left on its NORMAL build (a `--conditions=react-server` would
// instead break react/next-runtime-env in the config chain):
//
//	NODE_PATH=scripts/e2e/node-stubs pnpm -F console exec tsx scripts/e2e/finalize-deployment.ts <jobId>
//
// The Go T2 harness (runFinalizeDeploymentShim) invokes it exactly this way with an ABSOLUTE
// NODE_PATH.
//
// Exit 0 on success (the finalize ran to completion), non-zero on any error — the Go harness treats
// a non-zero exit as WARN unless ALETHIA_E2E_A05_ENFORCE is set, so a shim hiccup can never red the
// expensive nightly before the assertion has proven itself over 3 green nights.

import { finalizeDeployment } from "@/app/server/actions/deployments";

async function main(): Promise<void> {
	const jobId = process.argv[2];
	if (!jobId) {
		throw new Error("usage: finalize-deployment.ts <jobId>");
	}
	if (!process.env.ALETHIA_DATABASE_URL) {
		throw new Error("ALETHIA_DATABASE_URL is unset (the migrated control-plane DB)");
	}
	// The real console action: env → ACTIVE through the set_env_status CAS, plus the persisted
	// cluster/add-on/security writeback. A no-op for a job that isn't a SUCCESS DEPLOY with an
	// environment — the harness only invokes it after asserting the job reached SUCCESS.
	await finalizeDeployment(jobId);
	console.log(`finalizeDeployment(${jobId}) completed`);
}

main()
	// postgres-js keeps the event loop alive via its pool; exit explicitly so the shim returns.
	.then(() => process.exit(0))
	.catch((err: unknown) => {
		console.error(
			`finalizeDeployment failed: ${err instanceof Error ? err.stack || err.message : String(err)}`,
		);
		process.exit(1);
	});
