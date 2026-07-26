// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hetzner-talos placement credential channel (#1389) — the addon-secrets/git-token pattern for the
// Fabric's admin talosconfig. Talos has no cloud API to re-mint kube access, so a namespace/vcluster
// placement mints a fresh kubeconfig from the Fabric's PERSISTED talosconfig via the Talos machine API.
//
//   PUT  — write-back: the runner POSTs the talosconfig captured at the Fabric's dedicated apply; the
//          console `encryptSecret`s it into project_fabrics.talos_admin_config (AES-256-GCM). Server-side
//          crypto — the runner holds no key (same discipline as cloud_identities.credentials).
//   GET  — claim: the placement runner fetches the `decryptSecret`ed plaintext over the authenticated job
//          channel to mint the kubeconfig. Never returned to the browser.
//
// Both are gated to the runner that OWNS an executing hetzner DEPLOY job; the write-back additionally
// requires the job to be the Fabric-owning `dedicated` placement (so a runner holding a namespace/vcluster
// job on a shared Fabric can't overwrite the Fabric's talosconfig).

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { errorName } from "@/lib/errors";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	projectEnvironments,
	projectFabrics,
} from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { verifyRunnerToken } from "@/lib/runners/auth";

// Talos admin talosconfigs are small YAML docs (~a few KB); bound the write-back to reject an absurd body.
const MAX_TALOSCONFIG_BYTES = 128 * 1024;

/** Narrows an unknown JSON body to an indexable record without an `as` cast. */
function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

type GatedJob = {
	fabricId: string;
	placementMode: string;
};

/**
 * Verifies the runner owns an executing hetzner DEPLOY job and resolves its Fabric. Returns either the
 * gated job context or a NextResponse to return verbatim. Fail-closed at every step.
 */
async function gateHetznerJob(
	req: Request,
	jobId: string,
): Promise<{ ok: true; job: GatedJob } | { ok: false; res: NextResponse }> {
	const { runnerId, error: authError } = await verifyRunnerToken(req);
	if (authError) return { ok: false, res: authError };

	const db = getServiceDb();
	const [job] = await db
		.select({
			runner_id: jobs.runner_id,
			job_type: jobs.job_type,
			status: jobs.status,
			environment_id: jobs.environment_id,
			provider: cloudIdentities.provider,
		})
		.from(jobs)
		.leftJoin(cloudIdentities, eq(jobs.cloud_identity_id, cloudIdentities.id))
		.where(eq(jobs.id, jobId))
		.limit(1);

	if (!job) {
		return { ok: false, res: NextResponse.json({ error: "Job not found" }, { status: 404 }) };
	}
	if (job.runner_id !== runnerId) {
		return {
			ok: false,
			res: NextResponse.json({ error: "Runner does not own this job" }, { status: 403 }),
		};
	}
	if (job.job_type !== "DEPLOY") {
		return {
			ok: false,
			res: NextResponse.json({ error: "Job kind has no talosconfig" }, { status: 403 }),
		};
	}
	// Only while executing — narrows the replay window of a leaked runner token (mirrors addon-secrets).
	if (job.status !== "CLAIMED" && job.status !== "PROCESSING") {
		return {
			ok: false,
			res: NextResponse.json({ error: "Job is not executing" }, { status: 403 }),
		};
	}
	// The talosconfig channel is hetzner-talos only (defense-in-depth: no other provider persists one).
	if (job.provider !== "hetzner") {
		return {
			ok: false,
			res: NextResponse.json({ error: "Provider has no talosconfig" }, { status: 403 }),
		};
	}
	if (!job.environment_id) {
		return {
			ok: false,
			res: NextResponse.json({ error: "Job has no environment" }, { status: 409 }),
		};
	}

	const [env] = await db
		.select({ fabric_id: projectEnvironments.fabric_id, placement_mode: projectEnvironments.placement_mode })
		.from(projectEnvironments)
		.where(eq(projectEnvironments.id, job.environment_id))
		.limit(1);
	if (!env?.fabric_id) {
		return {
			ok: false,
			res: NextResponse.json({ error: "Environment is not placed on a Fabric" }, { status: 409 }),
		};
	}
	return { ok: true, job: { fabricId: env.fabric_id, placementMode: env.placement_mode } };
}

/**
 * Write-back: persist the Fabric's admin talosconfig (encrypted) from the runner that just applied the
 * Fabric. Only the Fabric-owning `dedicated` job may write, so a placement runner can't overwrite it.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id: jobId } = await params;
	try {
		const gate = await gateHetznerJob(req, jobId);
		if (!gate.ok) return gate.res;
		if (gate.job.placementMode !== "dedicated") {
			return NextResponse.json(
				{ error: "Only the Fabric-owning dedicated deploy may write the talosconfig" },
				{ status: 403 },
			);
		}

		const body: unknown = await req.json().catch(() => null);
		const talosconfig =
			isRecord(body) && typeof body.talosconfig === "string" ? body.talosconfig : "";
		if (talosconfig.trim().length === 0) {
			return NextResponse.json({ error: "Missing talosconfig" }, { status: 400 });
		}
		if (Buffer.byteLength(talosconfig, "utf8") > MAX_TALOSCONFIG_BYTES) {
			return NextResponse.json({ error: "talosconfig too large" }, { status: 413 });
		}

		const db = getServiceDb();
		await db
			.update(projectFabrics)
			.set({ talos_admin_config: encryptSecret({ talosconfig }), updated_at: new Date() })
			.where(eq(projectFabrics.id, gate.job.fabricId));

		return NextResponse.json({ ok: true });
	} catch (err: unknown) {
		// Generic: never echo encryption errors (they can reference key material).
		console.error("Talosconfig write-back error for job", jobId, "-", errorName(err));
		return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
	}
}

/**
 * Claim: return the Fabric's decrypted admin talosconfig to the owning runner so a placement can mint a
 * kubeconfig. `{ talosconfig: null }` when the Fabric has none yet (the runner fails the placement closed).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id: jobId } = await params;
	try {
		const gate = await gateHetznerJob(req, jobId);
		if (!gate.ok) return gate.res;

		const db = getServiceDb();
		const [fabric] = await db
			.select({ talos_admin_config: projectFabrics.talos_admin_config })
			.from(projectFabrics)
			.where(eq(projectFabrics.id, gate.job.fabricId))
			.limit(1);

		const envelope = fabric?.talos_admin_config;
		if (!envelope) {
			return NextResponse.json({ talosconfig: null });
		}
		const talosconfig = decryptSecret(envelope).talosconfig ?? null;
		return NextResponse.json({ talosconfig });
	} catch (err: unknown) {
		console.error("Talosconfig claim error for job", jobId, "-", errorName(err));
		return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
	}
}
