// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import type { CloudProvider } from "@/lib/db/schema/enums";
import { verifyRunnerToken } from "@/lib/runners/auth";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

/** The provisionable clouds whose token-mint routes are per-job-bound — a subset of the
 * generated `cloud_provider` enum (derived so it can't drift). */
export type MintProvider = Extract<
	CloudProvider,
	"aws" | "gcp" | "azure" | "alibaba"
>;

/**
 * Authorizes a per-job cloud-token mint. A runner token alone is not enough: the caller
 * must be minting for a job it OWNS, that is actively running (PROCESSING), and whose
 * provider matches the route — so a stolen runner token cannot mint arbitrary cloud
 * credentials for other tenants' jobs (the token routes were previously runner-token-only,
 * with no job binding).
 *
 * Managed runners MUST send `{ job_id }` (their image is auto-updated). Self-hosted runners
 * (own creds, own blast radius) may omit it for one release — a warned back-compat window —
 * so an older self-hosted binary keeps working until it upgrades.
 *
 * The binding is on AUTHORIZATION, not the token claims: the minted assertion keeps its
 * pinned subject (alethia-connector) that every customer's cloud trust policy references,
 * so this cannot be expressed as a per-job subject/audience.
 *
 * Returns `{ error }` — a NextResponse to return as-is, or null when the mint is authorized.
 */
export async function authorizeTokenMint(
	req: Request,
	provider: MintProvider,
): Promise<{ error: NextResponse | null }> {
	const { runnerId, operator, error } = await verifyRunnerToken(req);
	if (error) return { error };

	// Old runners POST an empty body; new runners send { job_id }. Never throw on either.
	const body = (await req.json().catch(() => null)) as {
		job_id?: unknown;
	} | null;
	const jobId = typeof body?.job_id === "string" ? body.job_id : null;

	if (!jobId) {
		if (operator === "managed") {
			return {
				error: NextResponse.json(
					{ error: "job_id is required for managed runners" },
					{ status: 400 },
				),
			};
		}
		console.warn(
			`[token-mint] ${provider} token minted without job_id by self-runner ${runnerId} (deprecated — will be required)`,
		);
		return { error: null };
	}

	const db = getServiceDb();
	const [job] = await db
		.select({
			runner_id: jobs.runner_id,
			status: jobs.status,
			provider: jobs.provider,
		})
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);

	if (!job) {
		return {
			error: NextResponse.json({ error: "Job not found" }, { status: 404 }),
		};
	}
	if (job.runner_id !== runnerId) {
		return {
			error: NextResponse.json(
				{ error: "Runner does not own this job" },
				{ status: 403 },
			),
		};
	}
	if (job.status !== "PROCESSING") {
		return {
			error: NextResponse.json(
				{ error: "Job is not currently running" },
				{ status: 409 },
			),
		};
	}
	if (job.provider !== provider) {
		return {
			error: NextResponse.json(
				{ error: `Job provider does not match ${provider}` },
				{ status: 403 },
			),
		};
	}
	return { error: null };
}
