// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { z } from "zod";
import { authorizeQuiet } from "@/lib/authz/guard";
import {
	CASE_PAGE_SIZE,
	type CaseListFilter,
	type CaseListItem,
	type CasePageRequest,
	type CaseWithThread,
	getCaseWithThread,
	listCasesForOwner,
} from "@/lib/queries/support";
import { query } from "@/lib/rpc/base";
import { withSupportScope } from "@/lib/support/scope";

/** The lifecycle buckets the case list reads by; "all" is the absence of a status filter. */
const caseBucket = z.enum(["all", "active", "resolved"]);

/** A keyset position in the case list — the last row of the previous page (`CaseCursor`). */
const caseCursor = z.object({ at: z.string().datetime({ offset: true }), id: z.string().uuid() });

/**
 * The caller's support cases, newest activity first, optionally bucketed by lifecycle. With `page`,
 * one keyset page of them (see {@link listCasesForOwner}); without, every one.
 *
 * Moved here from `listMyCases` (the `"use server"` support actions, #6130) so the read is a plain
 * function the read router calls in-process, never a queued server-action POST. The visibility rule
 * is unchanged and lives in RLS: `withSupportScope` scopes to the ADDRESSED org (the actor the read
 * router resolved) and sets `app.support_all` only for `manage_support` holders, so a viewer reads
 * the cases they opened and an owner/admin reads the org's.
 */
export async function listSupportCases(
	filter: CaseListFilter = {},
	page?: CasePageRequest,
): Promise<CaseListItem[]> {
	const actor = await authorizeQuiet("view", { type: "support_case" });
	return withSupportScope(actor, (tx) => listCasesForOwner(tx, actor.userId, filter, page));
}

/**
 * One case with its customer-visible thread and attachments, or null when the caller cannot see it
 * — a case that never existed and a case of another org or another requester read the same.
 *
 * A pure read. It used to advance the caller's read watermark as a side effect; a GET must not
 * write, so that is now the `markCaseRead` action the case view fires once it has the case.
 */
async function readSupportCase(id: string): Promise<CaseWithThread | null> {
	const actor = await authorizeQuiet("view", { type: "support_case", id });
	return withSupportScope(actor, (tx) => getCaseWithThread(tx, id));
}

/**
 * The support domain's reads (ADR 0005 D1, #6130). `cases` backs "My cases", one keyset page of
 * {@link CASE_PAGE_SIZE} at a time: no `cursor` is the first page, and the next page's cursor is the
 * last row's (activity, id) — `nextCaseCursor` — so a case is never out of reach (#7389). `case` backs the case
 * view and answers NOT_FOUND — never an empty value — for a case the caller cannot see, so the page
 * can render its not-found boundary distinctly from an error. The shell's bell keeps its own feed
 * (`workspace.supportCases`), which reads through {@link listSupportCases} too.
 */
export const supportRouter = {
	cases: query
		.input(z.object({ bucket: caseBucket, cursor: caseCursor.optional() }))
		.handler(({ input }) =>
			listSupportCases(input.bucket === "all" ? {} : { status: input.bucket }, {
				cursor: input.cursor,
				limit: CASE_PAGE_SIZE,
			}),
		),
	case: query
		.input(z.object({ id: z.string().uuid() }))
		.handler(async ({ input, errors }) => {
			const found = await readSupportCase(input.id);
			if (!found) throw errors.NOT_FOUND({ message: "Case not found." });
			return found;
		}),
};
