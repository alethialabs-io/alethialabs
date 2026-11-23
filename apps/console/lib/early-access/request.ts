// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Filing and reading complimentary Early Access requests (EA-3, #7325).
//
// THE LEGAL SHAPE (decisions-2026-11-23-early-access.md §2). An EU business with a VAT number cannot
// be sold to until the seller's Art. 97a registration is in force. What it can be given is the paid
// tier FREE: nothing charged, nothing promised as a debt, no back-billing. Billing, if the business
// later commits to pay, starts after the registration and only going forward. So nothing in this
// flow creates a Stripe object, names a price, or records an amount: a request is a row, a grant is
// a plan set through the operator plane (`setOrgPlan`), and both say "complimentary".
//
// THE TENANCY SHAPE (programmables.sql, `early_access_request`). The app role may INSERT only a bare
// `open` row with no VIES fields, and SELECT its own organization's rows. So the request is filed on
// the RLS connection under the actor's scope, and the VIES verdict is written afterwards through the
// service role, by the server, from the server's own call to VIES — never from anything the client
// sent.
//
// `server-only` with no "use server": these are called from the thin server actions in
// app/server/actions/early-access.ts, which do the authorization.

import "server-only";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { getServiceDb, withActorScope } from "@/lib/db";
import { pgErrorCode } from "@/lib/db/pg-error";
import {
	EARLY_ACCESS_PLANS,
	type EarlyAccessPlan,
	type EarlyAccessRequestStatus,
	earlyAccessRequest,
} from "@/lib/db/schema";
import { log } from "@/lib/observability/log";
import { notifyEarlyAccessRequest } from "./notify";
import { VAT_NUMBER_REFUSAL_MESSAGES, grantEligibleFor, parseVatNumber } from "./vat-number";
import { type ViesResult, checkVatWithVies } from "./vies";

/** The longest note a requester may attach. */
const EARLY_ACCESS_NOTE_MAX = 1000;

/** What the request form sends. Validated again here: a server action's input is untrusted. */
const earlyAccessRequestInput = z.object({
	plan: z.enum(EARLY_ACCESS_PLANS, { error: "Choose the plan you would like." }),
	vatId: z.string().trim().min(4, "Enter your VAT number.").max(32, "That VAT number is too long."),
	note: z
		.string()
		.trim()
		.max(EARLY_ACCESS_NOTE_MAX, `Keep the note under ${EARLY_ACCESS_NOTE_MAX} characters.`)
		.optional(),
});

/** The VIES verdict as the customer and staff see it. */
export type ViesVerdict = "valid" | "invalid" | "unchecked";

/** The outcome of filing a request. */
export type FileEarlyAccessResult =
	| { readonly ok: true; readonly requestId: string; readonly vies: ViesVerdict }
	| { readonly ok: false; readonly error: string };

/** The actor filing a request: the billing admin, in the organization the request is for. */
export interface RequestActor {
	readonly userId: string;
	readonly orgId: string;
}

/** The VIES verdict of a stored row: NULL `viesCheckedAt` means VIES was not asked successfully. */
export function viesVerdictOf(row: {
	viesValid: boolean | null;
	viesCheckedAt: Date | null;
}): ViesVerdict {
	if (!row.viesCheckedAt || row.viesValid === null) return "unchecked";
	return row.viesValid ? "valid" : "invalid";
}

/** The verdict of a fresh VIES result. */
function verdictOf(result: ViesResult): ViesVerdict {
	if (result.status === "unchecked") return "unchecked";
	return result.valid ? "valid" : "invalid";
}

/**
 * Files a request for the actor's organization: validates the form, asks EA-1's eligibility rule,
 * inserts the bare `open` row under RLS, checks the number with VIES and stores the verdict through
 * the service role, then tells the maintainer. VIES being down never refuses the request — it is
 * stored unchecked. A VIES "not valid" does not refuse it either: staff see the verdict and decide.
 */
export async function fileEarlyAccessRequest(
	actor: RequestActor,
	rawInput: unknown,
	vatRegistered: boolean = LEGAL_ENTITY.vatRegistered,
): Promise<FileEarlyAccessResult> {
	const parsed = earlyAccessRequestInput.safeParse(rawInput);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
	}
	const vat = parseVatNumber(parsed.data.vatId);
	if (!vat.ok) return { ok: false, error: VAT_NUMBER_REFUSAL_MESSAGES[vat.reason] };
	if (!grantEligibleFor(vat.vat, vatRegistered)) {
		return {
			ok: false,
			error: "Complimentary Early Access is closed: your organization can buy a plan directly from the billing page.",
		};
	}
	const note = parsed.data.note ? parsed.data.note : null;

	let requestId: string;
	try {
		const [row] = await withActorScope(actor, (tx) =>
			tx
				.insert(earlyAccessRequest)
				.values({
					organizationId: actor.orgId,
					requestedByUserId: actor.userId,
					country: vat.vat.country,
					vatId: vat.vat.normalised,
					planWanted: parsed.data.plan,
					requesterNote: note,
				})
				.returning({ id: earlyAccessRequest.id }),
		);
		if (!row) return { ok: false, error: "The request could not be saved. Try again." };
		requestId = row.id;
	} catch (err) {
		if (pgErrorCode(err) === "23505") {
			return {
				ok: false,
				error: "Your organization already has an open request. We will reply to it before you can file another.",
			};
		}
		log.error("[early-access] request insert failed", { org_id: actor.orgId, err });
		return { ok: false, error: "The request could not be saved. Try again." };
	}

	const vies = await checkVatWithVies(vat.vat.viesCountryCode, vat.vat.number);
	if (vies.status === "checked") {
		try {
			await getServiceDb()
				.update(earlyAccessRequest)
				.set({
					viesValid: vies.valid,
					viesName: vies.name,
					viesAddress: vies.address,
					viesRequestId: vies.requestId,
					viesCheckedAt: vies.checkedAt,
					updatedAt: new Date(),
				})
				.where(eq(earlyAccessRequest.id, requestId));
		} catch (err) {
			// The request stands; it reads as unchecked, which is what staff should then treat it as.
			log.error("[early-access] storing the VIES verdict failed", { org_id: actor.orgId, err });
		}
	} else {
		log.warn(`[early-access] request ${requestId} stored unchecked: ${vies.detail}`, {
			org_id: actor.orgId,
		});
	}

	const verdict = verdictOf(vies);
	await notifyEarlyAccessRequest({
		requestId,
		organizationId: actor.orgId,
		country: vat.vat.country,
		vatId: vat.vat.normalised,
		plan: parsed.data.plan,
		vies: verdict,
		viesName: vies.status === "checked" ? vies.name : null,
		requesterUserId: actor.userId,
		note,
	});

	return { ok: true, requestId, vies: verdict };
}

/** One request as the organization's billing admin sees it. */
export interface EarlyAccessRequestView {
	readonly id: string;
	readonly plan: EarlyAccessPlan;
	readonly vatId: string;
	readonly country: string;
	readonly status: EarlyAccessRequestStatus;
	readonly vies: ViesVerdict;
	readonly createdAt: string;
	readonly decidedAt: string | null;
}

/** What the request page needs: whether grants are open at all, and the organization's requests. */
export interface EarlyAccessOverview {
	/** False once the seller is VAT-registered: the organization then buys like any other. */
	readonly grantsOpen: boolean;
	readonly requests: readonly EarlyAccessRequestView[];
}

/**
 * The actor's organization's requests, newest first, read on the RLS connection (the SELECT policy
 * bounds it to the organization). Staff-only fields — the decision reason, who decided — are not
 * returned.
 */
export async function readEarlyAccessOverview(
	actor: RequestActor,
	vatRegistered: boolean = LEGAL_ENTITY.vatRegistered,
): Promise<EarlyAccessOverview> {
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({
				id: earlyAccessRequest.id,
				plan: earlyAccessRequest.planWanted,
				vatId: earlyAccessRequest.vatId,
				country: earlyAccessRequest.country,
				status: earlyAccessRequest.status,
				viesValid: earlyAccessRequest.viesValid,
				viesCheckedAt: earlyAccessRequest.viesCheckedAt,
				createdAt: earlyAccessRequest.createdAt,
				decidedAt: earlyAccessRequest.decidedAt,
			})
			.from(earlyAccessRequest)
			.where(eq(earlyAccessRequest.organizationId, actor.orgId))
			.orderBy(desc(earlyAccessRequest.createdAt))
			.limit(20),
	);
	return {
		grantsOpen: !vatRegistered,
		requests: rows.map((r) => ({
			id: r.id,
			plan: r.plan,
			vatId: r.vatId,
			country: r.country,
			status: r.status,
			vies: viesVerdictOf(r),
			createdAt: r.createdAt.toISOString(),
			decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
		})),
	};
}
