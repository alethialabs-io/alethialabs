// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomBytes } from "crypto";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServiceDb } from "@/lib/db";
import { cloudProvider, runners } from "@/lib/db/schema";

// Self-registration for scaler-provisioned VMs (ADR 08). A fresh Hetzner runner has
// no credentials: it presents the shared ALETHIA_RUNNER_BOOTSTRAP_TOKEN (lower-
// privilege than RELEASE_API_SECRET — it ships on every VM) and gets a runner id +
// token. Dedup is by the per-VM instance id (encoded in the unique managed name), so
// a reboot reuses the same runner row rather than leaking an orphan.

const bodySchema = z.object({
	providers: z.array(z.enum(cloudProvider.enumValues)).optional(),
	instanceId: z.string().min(1).max(200).optional(),
});

/** Bearer-auth against the dedicated bootstrap token. */
function verifyBootstrapToken(req: Request): NextResponse | null {
	const auth = req.headers.get("authorization");
	const expected = process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN;
	if (!expected || auth !== `Bearer ${expected}`) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	return null;
}

export async function POST(req: Request) {
	const unauthorized = verifyBootstrapToken(req);
	if (unauthorized) return unauthorized;

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

	const runnerToken = randomBytes(32).toString("hex");
	const tokenHash = createHash("sha256").update(runnerToken).digest("hex");
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
