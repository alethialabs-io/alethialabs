"use server";

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Contract formation: recording what a person agreed to, and who they are buying as (#2372).
//
// Both actions write EVIDENCE. That shapes every decision here: values are snapshotted rather than
// resolved later, an unknown is stored as null rather than as a plausible-looking default, and
// nothing is ever updated to erase what it previously said.

import { headers } from "next/headers";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
	EU_MEMBER_STATES,
	PAYER_CAPACITIES,
	type PayerCapacity,
	VAT_ID_STATUSES,
	type VatIdStatus,
	vatIdGivenOf,
} from "@repo/legal/commerce";
import { LEGAL_DOCUMENTS } from "@repo/legal/documents";
import { authorize, authorizeInOrg, currentActor } from "@/lib/authz/guard";
import {
	acceptanceRequiredDocuments,
	hasAcceptedCurrentDocuments,
	type PaidConversionRefusal,
	paidConversionStatus,
} from "@/lib/billing/eligibility";
import { markPendingOrgSetupDeclared } from "@/lib/billing/pending-org-setup";
import { isUsStateCode, normaliseEuVatNumber } from "@/lib/billing/tax-ids";
import { checkVatNumber } from "@/lib/billing/vies";
import { getServiceDb } from "@/lib/db";
import { legalAcceptance, organizationBilling } from "@/lib/db/schema";
import type { LegalAcceptanceEvidence } from "@/types/jsonb.types";

/**
 * What the CLIENT may say about an acceptance — and deliberately nothing about WHY it happened or
 * WHERE it was shown (#5009).
 *
 * `context` and `surface` used to be client input, and the one caller hardcoded "reacceptance", so
 * every first acceptance on record was mislabelled as a re-acceptance of terms the person had never
 * seen. Both are facts the server can establish on its own — whether an earlier acceptance of the
 * document exists is a query, and the only surface that calls this is the console gate — and a fact
 * the server can establish must never be one the browser can assert. `.strict()` REJECTS a request
 * that still carries either key rather than dropping it silently: a caller that believes it is
 * choosing the context is wrong, and saying so is cheaper than a record that disagrees with it.
 */
const acceptDocumentsSchema = z
	.object({
		/** The document ids being accepted, which must cover every acceptance-required document. */
		documentIds: z.array(z.string().min(1)).min(1),
		locale: z.string().min(2).max(16).default("en"),
		/** The browser's own clock, for reconciling against the server's. Optional and untrusted. */
		clientTimestamp: z.string().datetime().nullable().default(null),
	})
	.strict();

/**
 * The surface this action records. The console gate (`/accept-terms`) is its only caller.
 *
 * Nothing in product code writes a `checkout` surface or a `paid_conversion` context today: this
 * action and the seed builder are the only writers of `legal_acceptance`. Checkout does not capture
 * consent of its own — it REFUSES to proceed (`terms_not_accepted`, in `lib/billing/eligibility.ts`)
 * until a row written HERE covers the current documents. A checkout-time acceptance would be new
 * code with its own writer; it must not be routed through this action, whose context is decided
 * from history and can never be `paid_conversion`.
 */
const GATE_SURFACE: LegalAcceptanceEvidence["surface"] = "console-gate";

/** The two contexts an acceptance through the gate can carry. `paid_conversion` is not one. */
type GateAcceptanceContext = "signup" | "reacceptance";

/**
 * Whether this user has NEVER accepted any version of this document — the single definition of a
 * "first acceptance", shared by the write (`acceptLegalDocuments`, which records it as the row's
 * context) and the read (`getPendingAcceptance`, which tells the gate which copy to show), so the
 * words on the screen and the context on the record cannot disagree.
 *
 * ANY version, on purpose: a person who accepted v1 and is now shown v2 is re-accepting, and a
 * person with no row at all is agreeing for the first time — which is what `signup` means.
 */
async function isFirstAcceptance(
	userId: string,
	documentId: string,
): Promise<boolean> {
	const [prior] = await getServiceDb()
		.select({ id: legalAcceptance.id })
		.from(legalAcceptance)
		.where(
			and(
				eq(legalAcceptance.userId, userId),
				eq(legalAcceptance.documentId, documentId),
			),
		)
		.limit(1);
	return !prior;
}

/** The context a gate acceptance is recorded under, decided from the stored history alone. */
function gateAcceptanceContext(first: boolean): GateAcceptanceContext {
	return first ? "signup" : "reacceptance";
}

export type AcceptDocumentsInput = z.input<typeof acceptDocumentsSchema>;

/**
 * Records this user's acceptance of the CURRENT version of the named documents.
 *
 * The version and hash come from LEGAL_DOCUMENTS at write time and are COPIED IN. A record that
 * stored only the id and resolved the version on read would silently re-describe the past every
 * time the copy changed — which is the one thing this table exists to prevent.
 *
 * WHY the acceptance happened is decided here, never taken from the caller: `signup` when the user
 * has no earlier acceptance of that document at any version, `reacceptance` otherwise
 * (`isFirstAcceptance`). `paid_conversion` is unreachable from this action.
 *
 * Idempotent per (user, document, version): re-submitting the same acceptance does not stack rows,
 * because a double-click is not a second agreement. A NEW version always writes a new row, and the
 * old one is never touched.
 */
export async function acceptLegalDocuments(
	input: AcceptDocumentsInput,
): Promise<{ accepted: number }> {
	const parsed = acceptDocumentsSchema.parse(input);
	const actor = await currentActor();

	// Only documents this product actually publishes, and only ones that CAN be accepted. Recording
	// an "acceptance" of the Privacy Policy would misstate its basis: it is a notice, not consent,
	// and a stored acceptance of it is the artefact a regulator reads as consent having been sought.
	const known = new Map(LEGAL_DOCUMENTS.map((d) => [d.id, d]));
	const docs = parsed.documentIds
		.map((id) => known.get(id))
		.filter((d): d is NonNullable<typeof d> => Boolean(d) && d!.acceptanceRequired);
	if (docs.length === 0) {
		throw new Error("No acceptance-required document was named.");
	}

	const h = await headers();
	const evidence: LegalAcceptanceEvidence = {
		// Recorded as null rather than a placeholder when a proxy strips it — an absent value must
		// never read as a real one in a record whose whole job is attribution.
		ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
		userAgent: h.get("user-agent") || null,
		clientTimestamp: parsed.clientTimestamp,
		surface: GATE_SURFACE,
	};

	const db = getServiceDb();
	// An org id when one is in scope; null at signup, where no org exists yet and inventing a
	// placeholder would be worse than recording the truth.
	const organizationId =
		actor.orgId && actor.orgId !== actor.userId ? actor.orgId : null;

	let accepted = 0;
	for (const doc of docs) {
		const [existing] = await db
			.select({ id: legalAcceptance.id })
			.from(legalAcceptance)
			.where(
				and(
					eq(legalAcceptance.userId, actor.userId),
					eq(legalAcceptance.documentId, doc.id),
					eq(legalAcceptance.documentVersion, doc.version),
				),
			)
			.limit(1);
		if (existing) continue;
		// Decided per DOCUMENT, and before this row exists: a user re-accepting the Terms at v2 may be
		// accepting a newly-required document for the first time in the same submission.
		const context = gateAcceptanceContext(
			await isFirstAcceptance(actor.userId, doc.id),
		);
		await db.insert(legalAcceptance).values({
			userId: actor.userId,
			organizationId,
			documentId: doc.id,
			documentVersion: doc.version,
			documentHash: doc.contentHash,
			locale: parsed.locale,
			context,
			evidence,
		});
		accepted += 1;
	}
	return { accepted };
}

/** What the console's acceptance gate needs to render itself. */
export interface PendingAcceptance {
	/** True when everything required is already accepted at its current version. */
	readonly satisfied: boolean;
	readonly documents: {
		readonly id: string;
		readonly title: string;
		readonly version: string;
		readonly path: string;
		/**
		 * True when the user has never accepted ANY version of this document — the same answer
		 * `acceptLegalDocuments` records as `signup`. The gate words itself from it.
		 */
		readonly firstAcceptance: boolean;
	}[];
}

/**
 * The acceptance-required documents this user has NOT accepted at the current version.
 *
 * Read by the post-auth gate. It asks about the CURRENT version specifically: a user who accepted
 * v1 and never saw v2 has not agreed to v2, and treating the old row as covering it would be
 * inventing consent.
 */
export async function getPendingAcceptance(): Promise<PendingAcceptance> {
	const actor = await currentActor();
	const required = acceptanceRequiredDocuments();
	if (required.length === 0) return { satisfied: true, documents: [] };
	if (await hasAcceptedCurrentDocuments(actor.userId)) {
		return { satisfied: true, documents: [] };
	}

	const db = getServiceDb();
	const pending: PendingAcceptance["documents"] = [];
	for (const doc of required) {
		const [row] = await db
			.select({ id: legalAcceptance.id })
			.from(legalAcceptance)
			.where(
				and(
					eq(legalAcceptance.userId, actor.userId),
					eq(legalAcceptance.documentId, doc.id),
					eq(legalAcceptance.documentVersion, doc.version),
				),
			)
			.limit(1);
		if (!row) {
			pending.push({
				id: doc.id,
				title: doc.title,
				version: doc.version,
				path: doc.path,
				firstAcceptance: await isFirstAcceptance(actor.userId, doc.id),
			});
		}
	}
	return { satisfied: pending.length === 0, documents: pending };
}

const declarePayerSchema = z.object({
	capacity: z.enum(["consumer", "organization"]),
	/** ISO 3166-1 alpha-2. Upper-cased on the way in so the gate's comparison is total. */
	billingCountry: z
		.string()
		.trim()
		.length(2)
		.transform((v) => v.toUpperCase()),
	/** Required for an organization: the role under which the payer can bind it. */
	authorityAttestation: z.string().trim().min(2).max(200).nullable().default(null),
	/**
	 * Whether the organization has a VAT number (#7324). OPTIONAL so callers written before Early
	 * Access still parse — and omitted means "not stated in this call" (see `declarePayer` for what
	 * that keeps), never "no VAT number". `null` clears it.
	 */
	vatIdStatus: z.enum(["given", "not_given"]).nullable().optional(),
	/** The VAT number, required with `given` and refused with anything else. */
	vatId: z.string().trim().max(32).nullable().optional(),
	/** USPS state code, for a US payer only. Upper-cased so the gate's comparison is total. */
	billingState: z
		.string()
		.trim()
		.transform((v) => v.toUpperCase())
		.nullable()
		.optional(),
});

export type DeclarePayerInput = z.input<typeof declarePayerSchema>;

/** The declaration once parsed. */
type ParsedDeclaration = z.output<typeof declarePayerSchema>;

/**
 * Refuses VAT-number and state facts that do not fit the capacity and country, before anything is
 * written or asked. Shared by `declarePayer` and `payerConversionStatus`, like the attestation rule.
 *
 *  - A consumer has no VAT-number status: stating one is the same disagreement about the regime as a
 *    consumer attestation.
 *  - `given` needs the number, and for an EU country one in that country's format; `not_given` (or
 *    no status) carries no number — the record that none was communicated must stay true.
 *  - A state belongs to a US payer only, and must be a USPS code the thresholds know.
 *
 * Returns the VAT number normalised for storage (an EU number as `PREFIX+number`), or null.
 */
function assertVatAndStateCoherent(parsed: ParsedDeclaration): string | null {
	if (parsed.capacity === "consumer" && (parsed.vatIdStatus || parsed.vatId)) {
		throw new Error(
			"An individual purchase has no VAT-number status — clear it, or choose the organization option.",
		);
	}
	const vatId = parsed.vatId?.trim() ? parsed.vatId.trim() : null;
	let normalisedVatId: string | null = null;
	if (parsed.vatIdStatus === "given") {
		if (!vatId) throw new Error("Enter the organization's VAT number.");
		if (EU_MEMBER_STATES.includes(parsed.billingCountry)) {
			const vat = normaliseEuVatNumber(parsed.billingCountry, vatId);
			if (!vat) {
				throw new Error(
					"That is not a VAT number for the billing country. Check the number and the country.",
				);
			}
			normalisedVatId = vat.full;
		} else {
			normalisedVatId = vatId.toUpperCase();
		}
	} else if (vatId) {
		throw new Error(
			"A VAT number can only be recorded for an organization that says it has one.",
		);
	}
	const state = parsed.billingState?.trim() ? parsed.billingState : null;
	if (state !== null) {
		if (parsed.billingCountry !== "US") {
			throw new Error("A state is recorded only for a purchase billed in the United States.");
		}
		if (!isUsStateCode(state)) throw new Error("Select a US state.");
	}
	return normalisedVatId;
}

/**
 * Refuses a declaration whose attestation does not match its capacity, in BOTH directions.
 *
 * The forbidden half is the one worth stating. An organization declaration without an attestation
 * was already refused below; a CONSUMER declaration carrying one used to be quietly normalised to
 * null, which is the same failure shape the rest of this file exists to avoid — a record that
 * silently says something other than what the payer submitted. A consumer has nothing to bind, so
 * an attestation on that declaration means the form and the payer disagree about which legal regime
 * is being entered, and the right answer to a disagreement about the regime is to stop.
 *
 * Shared by `declarePayer` (which writes) and `payerConversionStatus` (which does not), so the
 * preview a purchase sheet renders cannot accept a shape the write would then reject.
 */
function assertAttestationMatchesCapacity(parsed: {
	capacity: PayerCapacity;
	authorityAttestation: string | null;
}): void {
	if (parsed.capacity === "organization" && !parsed.authorityAttestation) {
		throw new Error(
			"State the role under which you can bind this organization — a purchase on its behalf needs it.",
		);
	}
	if (parsed.capacity === "consumer" && parsed.authorityAttestation) {
		throw new Error(
			"An individual purchase binds nobody but you, so it cannot carry an attestation of authority.",
		);
	}
}

/**
 * Records WHO is paying and from WHERE — the two facts the paid-conversion gate needs before an
 * order exists.
 *
 * `consumer` vs `organization` is DECLARED here and never inferred. An organization declaration
 * additionally requires the attestation of authority, because a purchase that binds a legal person
 * needs someone to say they can bind it; a consumer declaration must NOT carry one, since there is
 * nothing to bind and storing a role there would make the record ambiguous about which regime
 * applied.
 *
 * AND, FOR EARLY ACCESS (#7324), whether the organization has a VAT number (and which), and a US
 * payer's state. A VAT number given for an EU country is checked with VIES first: one VIES says is
 * not registered is refused here, and a VIES outage is NOT a refusal (a national register being down
 * must not block a purchase; the gate does not open anything on the number's say-so — an EU business
 * with a VAT number outside Bulgaria is routed to the complimentary grant either way).
 *
 * The three new fields are OPTIONAL for the callers written before them (the create-a-team flow,
 * #6930 and #7004). Omitted, the stored values are KEPT while the capacity and country are unchanged,
 * and CLEARED when either changes — a VAT-number status or a state declared for another country is
 * not a fact about this one. The gate then refuses an EU organization or a US payer until they are
 * stated: fail-closed, never a guess.
 *
 * @param input The declared facts — capacity, ISO-2 billing country, the attestation, and the
 *   optional VAT-number status, VAT number and US state.
 * @param opts.orgId The organization to record the declaration ON, when it is not the ambient one.
 *   NAMED, not ambient, for exactly the reason `startProTrial` and `linkSubscriptionToNewOrg` take
 *   one (#4133): the create-org purchase sheet runs from a page inside the CURRENT org and declares
 *   for the org it has just created, so under URL-wins the ambient scope is the OLD org and the
 *   declaration would land on it — recording a capacity and a country against a payer who never
 *   gave them, while the new org stays undeclared and is refused at its next conversion. Optional
 *   because the upgrade sheet genuinely is on the org it is declaring for.
 */
export async function declarePayer(
	input: DeclarePayerInput,
	opts?: { orgId?: string },
): Promise<{ capacity: PayerCapacity; billingCountry: string }> {
	const parsed = declarePayerSchema.parse(input);
	const actor = opts?.orgId
		? await authorizeInOrg("manage_billing", { type: "billing" }, opts.orgId)
		: await authorize("manage_billing", { type: "billing" });
	if (actor.orgId === actor.userId) {
		throw new Error("Create an organization before setting up billing.");
	}
	assertAttestationMatchesCapacity(parsed);
	const vatId = assertVatAndStateCoherent(parsed);
	const authorityAttestation =
		parsed.capacity === "organization" ? parsed.authorityAttestation : null;
	if (vatId && parsed.vatIdStatus === "given" && EU_MEMBER_STATES.includes(parsed.billingCountry)) {
		const vies = await checkVatNumber(parsed.billingCountry, vatId);
		if (vies.status === "invalid") {
			throw new Error(
				"The EU VAT register (VIES) does not list that VAT number. Check it, or answer that the " +
					"organization has no VAT number only if that is true.",
			);
		}
	}

	const db = getServiceDb();
	const [existing] = await db
		.select({
			id: organizationBilling.id,
			payerCapacity: organizationBilling.payerCapacity,
			billingCountry: organizationBilling.billingCountry,
			vatIdStatus: organizationBilling.vatIdStatus,
			vatId: organizationBilling.vatId,
			billingState: organizationBilling.billingState,
		})
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, actor.orgId))
		.limit(1);
	const vatFacts = vatAndStateToStore(parsed, vatId, existing ?? null);
	if (existing) {
		await db
			.update(organizationBilling)
			.set({
				payerCapacity: parsed.capacity,
				billingCountry: parsed.billingCountry,
				authorityAttestation,
				...vatFacts,
				updatedAt: new Date(),
			})
			.where(eq(organizationBilling.id, existing.id));
	} else {
		await db.insert(organizationBilling).values({
			organizationId: actor.orgId,
			payerCapacity: parsed.capacity,
			billingCountry: parsed.billingCountry,
			authorityAttestation,
			...vatFacts,
		});
	}
	// The last step of a paid create-a-team setup (#5445): a declaration NAMING an org is how that flow
	// declares, so it closes the caller's setup record for that org, if there is one.
	if (opts?.orgId) await markPendingOrgSetupDeclared(actor.userId, actor.orgId);
	return { capacity: parsed.capacity, billingCountry: parsed.billingCountry };
}

/** The VAT-number and state columns a declaration writes. */
interface VatAndStateColumns {
	vatIdStatus: VatIdStatus | null;
	vatId: string | null;
	billingState: string | null;
}

/**
 * What a declaration stores in the three Early Access columns. A field the call STATED (present, even
 * as null) is written as stated. A field it omitted keeps the stored value only while the capacity and
 * country are the ones it was declared under; a change of either clears it.
 */
function vatAndStateToStore(
	parsed: ParsedDeclaration,
	vatId: string | null,
	existing: {
		payerCapacity: string | null;
		billingCountry: string | null;
		vatIdStatus: string | null;
		vatId: string | null;
		billingState: string | null;
	} | null,
): VatAndStateColumns {
	const sameRegime =
		existing !== null &&
		existing.payerCapacity === parsed.capacity &&
		existing.billingCountry === parsed.billingCountry;
	const keptStatus = sameRegime ? narrowVatIdStatus(existing?.vatIdStatus) : null;
	const vatIdStatus =
		parsed.capacity === "consumer"
			? null
			: parsed.vatIdStatus !== undefined
				? parsed.vatIdStatus
				: keptStatus;
	const keptVatId = sameRegime && keptStatus === "given" ? (existing?.vatId ?? null) : null;
	const storedVatId =
		vatIdStatus !== "given" ? null : parsed.vatIdStatus !== undefined ? vatId : keptVatId;
	const keptState = sameRegime ? (existing?.billingState ?? null) : null;
	const billingState =
		parsed.billingCountry !== "US"
			? null
			: parsed.billingState !== undefined
				? parsed.billingState?.trim()
					? parsed.billingState
					: null
				: keptState;
	return { vatIdStatus, vatId: storedVatId, billingState };
}

/** Narrows a stored value to a known VAT-number status, or null. */
function narrowVatIdStatus(value: string | null | undefined): VatIdStatus | null {
	for (const known of VAT_ID_STATUSES) {
		if (value === known) return known;
	}
	return null;
}

/**
 * The gate's verdict on a purchase made under these declared facts — asked BEFORE any money moves,
 * and writing nothing.
 *
 * It exists because a refusal that reaches the customer as an exception is a refusal they cannot
 * act on. Every conversion action throws `PaidConversionNotAllowedError` across the server-action
 * boundary, where the class is gone and the message is redacted in a production build, so the
 * purchase sheets could only render a generic sentence — the one that said "Billing may not be
 * configured on this deployment" for a rule the product itself was enforcing (#4633). Asking first,
 * over a RETURN value, is the only way the sheet can say which of the four preconditions failed.
 *
 * It is not a second implementation of the rule and must never become one: `paidConversionStatus`
 * calls the same `assertPaidConversionAllowed` the sale does and catches, so a preview that says
 * "allowed" and a conversion that refuses cannot disagree about anything but timing. It is also not
 * a substitute for the gate — nothing here authorises a sale, and the conversion action re-asks.
 *
 * Takes the facts rather than reading them, so the create-org sheet — where no organization exists
 * yet, and therefore no row to read them from — gets the same answer as the upgrade sheet.
 */
export async function payerConversionStatus(
	input: DeclarePayerInput,
): Promise<
	| { allowed: true }
	| { allowed: false; reason: PaidConversionRefusal; message: string }
> {
	const parsed = declarePayerSchema.parse(input);
	assertAttestationMatchesCapacity(parsed);
	assertVatAndStateCoherent(parsed);
	const actor = await currentActor();
	return paidConversionStatus({
		userId: actor.userId,
		organizationId: actor.orgId,
		capacity: parsed.capacity,
		billingCountry: parsed.billingCountry,
		vatIdGiven: parsed.capacity === "organization" ? vatIdGivenOf(parsed.vatIdStatus) : null,
		billingState: parsed.billingState ?? null,
	});
}

/** The declared payer facts for the active org, or nulls when nothing has been declared. */
export async function getDeclaredPayer(): Promise<{
	capacity: PayerCapacity | null;
	billingCountry: string | null;
	authorityAttestation: string | null;
	vatIdStatus: VatIdStatus | null;
	vatId: string | null;
	billingState: string | null;
}> {
	const actor = await authorize("manage_billing", { type: "billing" });
	const [row] = await getServiceDb()
		.select({
			capacity: organizationBilling.payerCapacity,
			billingCountry: organizationBilling.billingCountry,
			authorityAttestation: organizationBilling.authorityAttestation,
			vatIdStatus: organizationBilling.vatIdStatus,
			vatId: organizationBilling.vatId,
			billingState: organizationBilling.billingState,
		})
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, actor.orgId))
		.limit(1);
	return {
		// Narrowed, never cast: the column is an enum, but a hand-edited row must not be able to
		// widen the set the eligibility gate reasons over — and an `as` cast would tell the compiler
		// the value is fine rather than asking it (which this repo's lint refuses outright).
		capacity: narrowCapacity(row?.capacity),
		billingCountry: row?.billingCountry ?? null,
		authorityAttestation: row?.authorityAttestation ?? null,
		vatIdStatus: narrowVatIdStatus(row?.vatIdStatus),
		vatId: row?.vatId ?? null,
		billingState: row?.billingState ?? null,
	};
}

/** Narrows a stored value to a known payer capacity, or null. */
function narrowCapacity(value: string | null | undefined): PayerCapacity | null {
	for (const known of PAYER_CAPACITIES) {
		if (value === known) return known;
	}
	return null;
}

/** The user's most recent acceptance of a document, for an evidence export or a support answer. */
export async function getLatestAcceptance(documentId: string) {
	const actor = await currentActor();
	const [row] = await getServiceDb()
		.select()
		.from(legalAcceptance)
		.where(
			and(
				eq(legalAcceptance.userId, actor.userId),
				eq(legalAcceptance.documentId, documentId),
			),
		)
		.orderBy(desc(legalAcceptance.acceptedAt))
		.limit(1);
	return row ?? null;
}
