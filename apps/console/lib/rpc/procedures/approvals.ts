// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// THE APPROVALS READS (AGT-L2, gap G2 and G14). `list` backs the approvals list at
// `/[org]/~/approvals`, one keyset page at a time with the facets on the first page; `get` backs the
// decision sheet (`?approval=<id>`), and carries whether the viewer may decide and, if Approve is
// unavailable, why — computed with the same functions `decideApproval` re-checks with.
//
// Visibility: an approval is listed when its project is one the viewer may `view` (the PDP's answer,
// `viewableProjectIds`), in the org the read router resolved for the request's address. Deciding is
// `deploy` / `destroy` on the project, as `decideApproval` asks.

import { z } from "zod";
import { readApproveBlock, type ApproveBlock } from "@/lib/approvals/decidable";
import { getPdp } from "@/lib/authz";
import { authorizeQuiet } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { viewableProjectIds } from "@/lib/jobs/visibility";
import {
	type ApprovalDetail,
	type ApprovalPage,
	queryApprovalsPage,
	readApprovalDetail,
} from "@/lib/queries/approvals";
import { type KeysetPageRequest, keysetPageInput } from "@/lib/queries/keyset";
import { query } from "@/lib/rpc/base";

/** A facet's selected values, as the URL carries them. */
const facetValues = z.array(z.string().max(64)).max(20).optional();

/** The decision sheet's answer: the approval, and what the viewer may do with it. */
export interface ApprovalSheet {
	approval: ApprovalDetail;
	/** The viewer may decide this request (a console person with deploy/destroy on its project). */
	canDecide: boolean;
	/** Why Approve is unavailable, or null. Only meaningful while the request is waiting. */
	approveBlock: ApproveBlock | null;
}

/** One page of the approvals list for the request's actor. */
async function readApprovalsPage(
	filter: Parameters<typeof queryApprovalsPage>[3],
	page: KeysetPageRequest,
): Promise<ApprovalPage> {
	const actor = await authorizeQuiet("view", { type: "org" });
	const projectIds = await viewableProjectIds(actor);
	return withActorScope(actor, (tx) =>
		queryApprovalsPage(tx, actor.orgId, projectIds, filter, page),
	);
}

/** The decision sheet's read for approval `id`, or null when the viewer cannot see it. */
async function readApprovalSheet(id: string): Promise<ApprovalSheet | null> {
	const actor = await authorizeQuiet("view", { type: "org" });
	const projectIds = await viewableProjectIds(actor);
	const approval = await withActorScope(actor, (tx) => readApprovalDetail(tx, actor.orgId, projectIds, id));
	if (!approval) return null;
	const verb = approval.operation === "deploy" ? "deploy" : "destroy";
	const allowed = await getPdp().can(actor, verb, { type: "project", id: approval.project_id });
	const canDecide = allowed.allowed && actor.credential === "session" && !actor.ceiling;
	const approveBlock =
		approval.status === "pending"
			? await withActorScope(actor, (tx) =>
					readApproveBlock(
						tx,
						{
							org_id: actor.orgId,
							project_id: approval.project_id,
							environment_id: approval.environment_id,
							operation: approval.operation,
							requester_credential: approval.requester_credential,
							requester_credential_ref: approval.requester_credential_ref,
							requester_user_id: approval.requester_user_id,
						},
						actor.userId,
					),
				)
			: null;
	return { approval, canDecide, approveBlock };
}

/**
 * The approvals domain's reads. `list` pages with no `cursor` for the first page and the previous
 * page's `nextCursor` after that; its filters are applied in the query, and the first page carries
 * the facet counts over the viewer's unfiltered approvals. `get` answers NOT_FOUND — never an empty
 * value — for an approval the viewer cannot see, so the sheet can show "not available" distinctly
 * from an error.
 */
export const approvalsRouter = {
	list: query
		.input(
			z.object({
				status: facetValues,
				operation: facetValues,
				credential: facetValues,
				environment: facetValues,
				search: z.string().max(200).optional(),
				...keysetPageInput(),
			}),
		)
		.handler(({ input }) =>
			readApprovalsPage(
				{
					status: input.status,
					operation: input.operation,
					credential: input.credential,
					environment: input.environment,
					search: input.search,
				},
				{ cursor: input.cursor, limit: input.limit },
			),
		),
	get: query.input(z.object({ id: z.string().uuid() })).handler(async ({ input, errors }) => {
		const sheet = await readApprovalSheet(input.id);
		if (!sheet) throw errors.NOT_FOUND({ message: "This approval isn't available to you." });
		return sheet;
	}),
};
