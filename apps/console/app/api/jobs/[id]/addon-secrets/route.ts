// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W4.5 (#640): the runner-facing channel for add-on secret knobs — the git-token pattern.
// Secret values never ride the DEPLOY job's config snapshot (the spec carries only a
// `secretRef`); the runner that OWNS the job fetches the plaintext here at execution time
// and seeds the per-add-on k8s Secret in-cluster, so no credential lands in the DB, the
// rendered Application manifest, or the customer's gitops repo.

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getServiceDb } from "@/lib/db";
import { jobs, projectAddons } from "@/lib/db/schema";
import { getAddOn } from "@/lib/addons/catalog";
import {
	decryptAddonSecrets,
	hasStoredSecret,
	secretFieldKeys,
} from "@/lib/addons/secrets";
import { verifyRunnerToken } from "@/lib/runners/auth";

/**
 * Returns the decrypted secret-knob values for every enabled add-on of the job's
 * environment, keyed `{ [addonId]: { [fieldKey]: plaintext } }`. Only the runner that owns
 * the job may call this, and only for a job kind that actually installs add-ons (DEPLOY).
 * Values are returned over the authenticated runner channel and are never logged.
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { runnerId, error: authError } = await verifyRunnerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	try {
		const db = getServiceDb();

		const [job] = await db
			.select({
				runner_id: jobs.runner_id,
				job_type: jobs.job_type,
				status: jobs.status,
				project_id: jobs.project_id,
				environment_id: jobs.environment_id,
			})
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);

		if (!job) {
			return NextResponse.json({ error: "Job not found" }, { status: 404 });
		}
		if (job.runner_id !== runnerId) {
			return NextResponse.json(
				{ error: "Runner does not own this job" },
				{ status: 403 },
			);
		}
		// Only a DEPLOY installs add-ons; a runner holding, say, a DETECT_DRIFT job has no
		// business reading credentials (least privilege — same posture as the git-token route's
		// authorized-repos check).
		if (job.job_type !== "DEPLOY") {
			return NextResponse.json(
				{ error: "Job kind does not install add-ons" },
				{ status: 403 },
			);
		}
		// And only while the job is actually executing — a terminal job's runner has no
		// further use for credentials (narrows the replay window of a leaked runner token).
		if (job.status !== "CLAIMED" && job.status !== "PROCESSING") {
			return NextResponse.json({ error: "Job is not executing" }, { status: 403 });
		}
		if (!job.project_id || !job.environment_id) {
			return NextResponse.json({ secrets: {} });
		}

		const rows = await db
			.select({
				addon_id: projectAddons.addon_id,
				values: projectAddons.values,
			})
			.from(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, job.project_id),
					eq(projectAddons.environment_id, job.environment_id),
					eq(projectAddons.enabled, true),
				),
			);

		const secrets: Record<string, Record<string, string>> = {};
		for (const row of rows) {
			const def = getAddOn(row.addon_id);
			if (!def) continue;
			const stored = row.values ?? {};
			const keys = secretFieldKeys(def).filter((k) => hasStoredSecret(stored[k]));
			if (keys.length === 0) continue;
			const decrypted = decryptAddonSecrets(def, stored);
			const entry: Record<string, string> = {};
			for (const key of keys) {
				const v = decrypted[key];
				if (typeof v === "string" && v.length > 0) entry[key] = v;
			}
			if (Object.keys(entry).length > 0) secrets[row.addon_id] = entry;
		}

		return NextResponse.json({ secrets });
	} catch (err: unknown) {
		// Deliberately generic: never echo decryption errors (they can reference key material).
		console.error("Addon secrets fetch error for job", jobId, "-", (err as Error)?.name);
		return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
	}
}
