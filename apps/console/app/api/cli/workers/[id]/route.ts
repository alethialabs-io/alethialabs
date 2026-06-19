// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

/** Deletes a worker record owned by the CLI user (no cloud teardown). */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id: workerId } = await params;

	const auth = await authorizeCli(req, "destroy", { type: "runner", id: workerId });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const db = getServiceDb();

		const [worker] = await db
			.select({ id: runners.id, org_id: runners.org_id })
			.from(runners)
			.where(eq(runners.id, workerId))
			.limit(1);

		if (!worker) {
			return NextResponse.json({ error: "Worker not found" }, { status: 404 });
		}

		if (worker.org_id !== actor.orgId) {
			return NextResponse.json(
				{ error: "Unauthorized: you do not own this worker" },
				{ status: 403 },
			);
		}

		await db.delete(runners).where(eq(runners.id, workerId));

		return NextResponse.json({ success: true });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
