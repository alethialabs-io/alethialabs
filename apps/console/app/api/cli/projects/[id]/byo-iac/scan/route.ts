// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/cli/projects/:id/byo-iac/scan — queue a scan of the environment's attached BYO IaC
// source. The scan is what turns an attached repo into something the deploy will accept: it reads the
// module's variables and records the verdict the plan-time gate reads. Its own endpoint rather than a
// query flag on POST .../byo-iac, because attaching and scanning are separate acts — you re-scan a
// source you already attached whenever its module changes.

import { NextResponse } from "next/server";
import { scanIacSource } from "@/app/server/actions/byo-iac";
import { runWithActor } from "@/lib/authz/actor-context";
import { authorizeCli } from "@/lib/authz/guard";
import { byoWriteError, resolveByoScope } from "@/lib/cli/byo-write";
import { cliJson } from "@/lib/cli/respond";
import { cliByoScanResponse } from "@/lib/validations/cli-contract";

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	try {
		const scope = await resolveByoScope(actor.orgId, id, req);
		if ("error" in scope) return scope.error;

		// The job id is returned so the caller can follow it with `alethia jobs logs -f` — a scan is
		// asynchronous, and a bare "ok" would leave a script polling blind.
		const result = await runWithActor(actor, () =>
			scanIacSource({
				projectId: scope.projectId,
				environmentId: scope.environmentId,
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
