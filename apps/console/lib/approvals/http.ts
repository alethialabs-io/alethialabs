// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the approvals routes (app/api/approvals/**) share: the actor a CLI bearer is, and how an
// approval refusal is answered.

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { CliAuthorization } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { applyApprovals, member, organization } from "@/lib/db/schema";
import { SELECTION_PARAM } from "@/lib/query/view-url-params";
import { ApprovalError } from "./refusal";

/**
 * The actor a verified CLI bearer is, labelled with its credential kind. `authorizeCli` binds a device
 * login as `session`; for an approval that is the wrong kind, because an approval is bound to the
 * credential that requested it and `POST /api/jobs` sees the same login as `cli_session`.
 */
export function cliApprovalActor(auth: CliAuthorization): Actor {
	switch (auth.credential) {
		case "session":
			return { ...auth.actor, credential: "cli_session" };
		case "service_token":
			return { ...auth.actor, credential: "service_token", credentialRef: auth.serviceTokenId };
	}
}

/** The response for an {@link ApprovalError}, or null for anything else (which the route rethrows). */
export function approvalErrorResponse(err: unknown): NextResponse | null {
	if (!(err instanceof ApprovalError)) return null;
	return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
}

/**
 * The LEGACY console path for approval `id`, with no org in it: what the CLI and the MCP tools printed
 * before AGT-L2 (gap G1). It still works — `app/(private)/approvals/[id]/route.ts` redirects it to
 * {@link approvalsPath} for a member — and it is the fallback when an org has no slug to address.
 */
export function approvePath(id: string): string {
	return `/approvals/${id}`;
}

/**
 * The console path a person opens to decide approval `id` in org `orgSlug`: the approvals list with
 * that approval's decision sheet open (`?selected=<id>`, the list standard's selected-row param). The
 * org is in the path, so the link lands in the right org whichever one the person last used (G1).
 * With no `id`, the list itself.
 */
export function approvalsPath(orgSlug: string, id?: string): string {
	const base = `/${encodeURIComponent(orgSlug)}/~/approvals`;
	return id ? `${base}?${SELECTION_PARAM}=${encodeURIComponent(id)}` : base;
}

/** The slug of org `orgId`, or null when it has none (or does not exist). */
async function orgSlugOf(orgId: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ slug: organization.slug })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);
	return row?.slug ?? null;
}

/**
 * The path the approvals API answers as `approve_path` for approval `id` in org `orgId`: the org's
 * {@link approvalsPath}, or the {@link approvePath legacy path} (which redirects) when the org has no
 * slug. The caller already passed the org scope for this approval, so naming its slug discloses
 * nothing new.
 */
export async function approvePathForOrg(orgId: string, id: string): Promise<string> {
	const slug = await orgSlugOf(orgId);
	return slug ? approvalsPath(slug, id) : approvePath(id);
}

/**
 * Where a legacy `/approvals/<id>` link sends signed-in person `userId`: the approval's org's
 * {@link approvalsPath} when they are an active member of that org, else null (the caller sends them
 * to the console root, which names nothing about the approval). Read on the service role because the
 * link carries no org to scope a read by; it answers only a path the person could reach anyway, and
 * whether they may SEE the approval is still the sheet's own read, under their scope.
 */
export async function legacyApprovalTarget(id: string, userId: string): Promise<string | null> {
	const db = getServiceDb();
	const [row] = await db
		.select({ slug: organization.slug })
		.from(applyApprovals)
		.innerJoin(organization, eq(organization.id, applyApprovals.org_id))
		.innerJoin(
			member,
			and(eq(member.organizationId, applyApprovals.org_id), eq(member.userId, userId), eq(member.status, "active")),
		)
		.where(eq(applyApprovals.id, id))
		.limit(1);
	return row?.slug ? approvalsPath(row.slug, id) : null;
}
