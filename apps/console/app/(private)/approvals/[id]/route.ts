// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /approvals/:id — the org-less link the Alethia CLI and the MCP tools have printed (AGT-L2,
// gap G1). An approval is decided in its sheet over the org's approvals list,
// `/{org}/~/approvals?selected=<id>`, so this route only finds the org and redirects there.
//
// It discloses nothing: a signed-in member of the approval's org is sent to that org's list with the
// sheet open (whether they may SEE the approval is still the sheet's own scoped read — a member
// without access to the project gets its "not available" state); anyone else, and any id that is not
// an approval, goes to the console root, exactly as an unknown id would. A visitor with no session is
// sent to sign in and comes back here. Removable one CLI release after the CLI prints the new link
// (spec O8).

import { NextResponse } from "next/server";
import { z } from "zod";
import { legacyApprovalTarget } from "@/lib/approvals/http";
import { getOwner } from "@/lib/auth/owner";
import { signInHref } from "@/lib/auth/sign-in-href";

/** Redirects a legacy approval link to the approval's sheet in its org, or to the console root. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const userId = await getOwner();
	if (!userId) {
		return NextResponse.redirect(new URL(signInHref(`/approvals/${encodeURIComponent(id)}`), req.url), 307);
	}
	const target = z.uuid().safeParse(id).success ? await legacyApprovalTarget(id, userId) : null;
	return NextResponse.redirect(new URL(target ?? "/", req.url), 307);
}
