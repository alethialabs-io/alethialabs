// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/cli/projects/:id/byo-charts/scan — queue a scan of one attached BYO Helm chart. The scan
// renders the chart and records the verdict the plan-time gate reads, so it is what makes an attached
// chart deployable. Separate from the attach for the same reason as the IaC scan: you re-scan a chart
// you already attached whenever its repository moves.

import { NextResponse } from "next/server";
import { z } from "zod";
import { scanByoChart } from "@/app/server/actions/byo-charts";
import { runWithActor } from "@/lib/authz/actor-context";
import { authorizeCli } from "@/lib/authz/guard";
import { byoWriteError, resolveByoScope } from "@/lib/cli/byo-write";
import { cliJson } from "@/lib/cli/respond";
import { cliByoScanResponse } from "@/lib/validations/cli-contract";

const scanChartBody = z.object({ id: z.string().trim().min(1) });

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const parsed = scanChartBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid request body: id is required" },
			{ status: 400 },
		);
	}

	try {
		const scope = await resolveByoScope(actor.orgId, id, req);
		if ("error" in scope) return scope.error;

		const result = await runWithActor(actor, () =>
			scanByoChart({
				projectId: scope.projectId,
				environmentId: scope.environmentId,
				id: parsed.data.id,
			}),
		);
		// 200, not 202. Semantically a queued job is "accepted", but every CLI route answers 200/201
		// and the Go client's doPost accepts only those — a 202 here would be read as a transport
		// failure. Consistency with the surface beats REST purism when the surface is the contract.
		return cliJson(cliByoScanResponse, { ok: true, job_id: result.jobId });
	} catch (err: unknown) {
		return byoWriteError(err);
	}
}
