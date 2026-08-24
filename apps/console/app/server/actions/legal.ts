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
	PAYER_CAPACITIES,
	type PayerCapacity,
} from "@repo/legal/commerce";
import { LEGAL_DOCUMENTS } from "@repo/legal/documents";
import { authorize, currentActor } from "@/lib/authz/guard";
import {
	acceptanceRequiredDocuments,
	hasAcceptedCurrentDocuments,
} from "@/lib/billing/eligibility";
import { getServiceDb } from "@/lib/db";
import { legalAcceptance, organizationBilling } from "@/lib/db/schema";
import type { LegalAcceptanceEvidence } from "@/types/jsonb.types";

/** Where the acceptance was presented. Finite and known, so a union — never a bare string. */
const acceptanceSurface = z.enum(["signup", "console-gate", "checkout"]);

const acceptDocumentsSchema = z.object({
	/** The document ids being accepted, which must cover every acceptance-required document. */
	documentIds: z.array(z.string().min(1)).min(1),
	locale: z.string().min(2).max(16).default("en"),
	surface: acceptanceSurface,
	context: z.enum(["signup", "paid_conversion", "reacceptance"]),
	/** The browser's own clock, for reconciling against the server's. Optional and untrusted. */
	clientTimestamp: z.string().datetime().nullable().default(null),
});

export type AcceptDocumentsInput = z.input<typeof acceptDocumentsSchema>;

/**
 * Records this user's acceptance of the CURRENT version of the named documents.
 *
 * The version and hash come from LEGAL_DOCUMENTS at write time and are COPIED IN. A record that
 * stored only the id and resolved the version on read would silently re-describe the past every
 * time the copy changed — which is the one thing this table exists to prevent.
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
		surface: parsed.surface,
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
		await db.insert(legalAcceptance).values({
			userId: actor.userId,
			organizationId,
			documentId: doc.id,
			documentVersion: doc.version,
			documentHash: doc.contentHash,
			locale: parsed.locale,
			context: parsed.context,
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
});

export type DeclarePayerInput = z.input<typeof declarePayerSchema>;

/**
 * Records WHO is paying and from WHERE — the two facts the paid-conversion gate needs before an
 * order exists.
 *
 * `consumer` vs `organization` is DECLARED here and never inferred. An organization declaration
 * additionally requires the attestation of authority, because a purchase that binds a legal person
 * needs someone to say they can bind it; a consumer declaration must NOT carry one, since there is
 * nothing to bind and storing a role there would make the record ambiguous about which regime
 * applied.
 */
export async function declarePayer(
	input: DeclarePayerInput,
): Promise<{ capacity: PayerCapacity; billingCountry: string }> {
	const parsed = declarePayerSchema.parse(input);
	const actor = await authorize("manage_billing", { type: "billing" });
	if (actor.orgId === actor.userId) {
		throw new Error("Create an organization before setting up billing.");
	}
	if (parsed.capacity === "organization" && !parsed.authorityAttestation) {
		throw new Error(
			"State the role under which you can bind this organization — a purchase on its behalf needs it.",
		);
	}
	const authorityAttestation =
		parsed.capacity === "organization" ? parsed.authorityAttestation : null;

	const db = getServiceDb();
	const [existing] = await db
		.select({ id: organizationBilling.id })
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, actor.orgId))
		.limit(1);
	if (existing) {
		await db
			.update(organizationBilling)
			.set({
				payerCapacity: parsed.capacity,
				billingCountry: parsed.billingCountry,
				authorityAttestation,
				updatedAt: new Date(),
			})
			.where(eq(organizationBilling.id, existing.id));
	} else {
		await db.insert(organizationBilling).values({
			organizationId: actor.orgId,
			payerCapacity: parsed.capacity,
			billingCountry: parsed.billingCountry,
			authorityAttestation,
		});
	}
	return { capacity: parsed.capacity, billingCountry: parsed.billingCountry };
}

/** The declared payer facts for the active org, or nulls when nothing has been declared. */
export async function getDeclaredPayer(): Promise<{
	capacity: PayerCapacity | null;
	billingCountry: string | null;
	authorityAttestation: string | null;
}> {
	const actor = await authorize("manage_billing", { type: "billing" });
	const [row] = await getServiceDb()
		.select({
			capacity: organizationBilling.payerCapacity,
			billingCountry: organizationBilling.billingCountry,
			authorityAttestation: organizationBilling.authorityAttestation,
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
