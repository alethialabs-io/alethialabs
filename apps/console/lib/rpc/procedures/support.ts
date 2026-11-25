// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { z } from "zod";
import { authorizeQuiet } from "@/lib/authz/guard";
import { type KeysetPageRequest, keysetPageInput } from "@/lib/queries/keyset";
import {
	type CaseListFilter,
	type CaseListItem,
	type CasePage,
	type CaseWithThread,
	getCaseWithThread,
	listCasesForOwner,
	queryCasesPage,
} from "@/lib/queries/support";
import { query } from "@/lib/rpc/base";
import { withSupportScope } from "@/lib/support/scope";

/** The lifecycle buckets the case list reads by; "all" is the absence of a status filter. */
const caseBucket = z.enum(["all", "active", "resolved"]);

/**
 * Every one of the caller's support cases, newest activity first, optionally bucketed by lifecycle
 * (see {@link listCasesForOwner}) — the shell bell's feed. "My cases" pages through `support.cases`.
 *
 * Moved here from `listMyCases` (the `"use server"` support actions, #6130) so the read is a plain
 * function the read router calls in-process, never a queued server-action POST. The visibility rule
 * is unchanged and lives in RLS: `withSupportScope` scopes to the ADDRESSED org (the actor the read
 * router resolved) and sets `app.support_all` only for `manage_support` holders, so a viewer reads
 * the cases they opened and an owner/admin reads the org's.
 */
export async function listSupportCases(filter: CaseListFilter = {}): Promise<CaseListItem[]> {
	const actor = await authorizeQuiet("view", { type: "support_case" });
	return withSupportScope(actor, (tx) => listCasesForOwner(tx, actor.userId, filter));
}

/**
 * One page of the "My cases" list under the list's filters, with the facet counts on the first page
 * (see {@link queryCasesPage}). Same visibility rule as {@link listSupportCases}: RLS, under the
 * addressed org's support scope.
 */
async function readSupportCasesPage(filter: CaseListFilter, page: KeysetPageRequest): Promise<CasePage> {
	const actor = await authorizeQuiet("view", { type: "support_case" });
	return withSupportScope(actor, (tx) => queryCasesPage(tx, actor.userId, filter, page));
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
 * The support domain's reads (ADR 0005 D1, #6130). `cases` backs "My cases", one keyset page at a
 * time on the console list contract (`lib/queries/keyset.ts`, #7494): no `cursor` is the first page,
 * each page answers the opaque `nextCursor` of the page after it (null at the end), and a malformed
 * cursor is a 400 — so a case is never out of reach and a bad cursor never restarts the walk. Its
 * search, severity and type are applied in the query, and the first page carries the facet counts
 * over the caller's unfiltered cases (#7396), so a filter reaches every case, not the pages loaded. `case` backs the case
 * view and answers NOT_FOUND — never an empty value — for a case the caller cannot see, so the page
 * can render its not-found boundary distinctly from an error. The shell's bell keeps its own feed
 * (`workspace.supportCases`), which reads through {@link listSupportCases} too.
 */
export const supportRouter = {
	cases: query
		.input(
			z.object({
				bucket: caseBucket,
				search: z.string().max(200).optional(),
				severity: z.array(z.string().max(64)).max(20).optional(),
				type: z.array(z.string().max(64)).max(20).optional(),
				...keysetPageInput("uuid"),
			}),
		)
		.handler(({ input }) =>
			readSupportCasesPage(
				{
					...(input.bucket === "all" ? {} : { status: input.bucket }),
					search: input.search,
					severity: input.severity,
					type: input.type,
				},
				{ cursor: input.cursor, limit: input.limit },
			),
		),
	case: query
		.input(z.object({ id: z.string().uuid() }))
		.handler(async ({ input, errors }) => {
			const found = await readSupportCase(input.id);
			if (!found) throw errors.NOT_FOUND({ message: "Case not found." });
			return found;
		}),
};
