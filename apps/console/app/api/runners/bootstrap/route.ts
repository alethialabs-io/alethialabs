// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from "crypto";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServiceDb } from "@/lib/db";
import { cloudProvider, runners } from "@/lib/db/schema";
import { generateRunnerToken, hashRunnerToken } from "@/lib/runners/auth";
import {
	linkBootstrapToken,
	redeemBootstrapToken,
} from "@/lib/runners/bootstrap-token";
import { timingSafeStrEqual } from "@/lib/auth/internal-auth";

// Self-registration for scaler-provisioned VMs (ADR 08). A fresh Hetzner runner has no
// credentials: it presents its PER-VM bootstrap token (E0 0b — minted by the scaler at VM
// create, short-TTL, instance-bound) and gets a runner id + token. A leaked per-VM token is
// bounded to that one VM and dead once its TTL passes. Legacy shared-env token still accepted
// as a fallback for local `pnpm dev:runner` (self-hosted runners use /api/runners/register).
// Dedup is by the per-VM instance id (encoded in the unique managed name), so a reboot reuses
// the same runner row rather than leaking an orphan.

const bodySchema = z.object({
	providers: z.array(z.enum(cloudProvider.enumValues)).optional(),
	instanceId: z.string().min(1).max(200).optional(),
});

/** The presented bootstrap token from the Authorization: Bearer header, or null. */
function bearerToken(req: Request): string | null {
	const auth = req.headers.get("authorization") || "";
	const [scheme, token] = auth.split(" ");
	if (scheme?.toLowerCase() !== "bearer" || !token) return null;
	return token;
}

export async function POST(req: Request) {
	const presented = bearerToken(req);
	if (!presented) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
	}
	const parsed = bodySchema.safeParse(raw ?? {});
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid body (providers must be cloud_provider values)" },
			{ status: 400 },
		);
	}
	const { providers, instanceId } = parsed.data;

	// Authorize: the per-VM table token (atomic validate + instance-bind), else the legacy
	// shared-env token (dev / non-fleet). The shared token is NO LONGER injected into fleet VMs.
	const presentedHash = hashRunnerToken(presented);
	const redeemed = await redeemBootstrapToken(presentedHash, instanceId ?? null);
	if (!redeemed.ok) {
		const shared = process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN;
		if (!timingSafeStrEqual(presented, shared)) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
	}

	const { token: runnerToken, hash: tokenHash } = generateRunnerToken();
	// The instance id is the dedup key (encoded in the unique managed name); without
	// one we fall back to a random name (new runner each boot).
	const name = `fleet-${instanceId ?? randomBytes(6).toString("hex")}`;
	const supported = providers && providers.length > 0 ? providers : null;

	try {
		const db = getServiceDb();
		const [row] = await db
			.insert(runners)
			.values({
				name,
				operator: "managed",
				token_hash: tokenHash,
				supported_providers: supported,
				metadata: instanceId ? { cloud_instance_id: instanceId } : {},
			})
			.onConflictDoUpdate({
				target: runners.name,
				targetWhere: sql`operator = 'managed'`,
				// Reboot of the same VM: rotate the token, keep the row + its metadata.
				set: { token_hash: tokenHash, supported_providers: supported },
			})
			.returning({ id: runners.id });

		// Link the per-VM token to the runner it created (self-heals a lost-response retry).
		if (redeemed.ok) await linkBootstrapToken(presentedHash, row.id);

		return NextResponse.json({ runner_id: row.id, runner_token: runnerToken });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json(
			{ error: "Failed to bootstrap runner: " + message },
			{ status: 500 },
		);
	}
}
