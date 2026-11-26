// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The staff app's read of the privacy register (#7222). The console owns the tables and answers on
// /api/internal/platform/privacy/*; this file is the consumer's half of that wire contract. Strict
// on purpose, as the funnel's is: the pages must only render the fields listed here, so a body that
// grows a field upstream — the subject's address hash, say — fails the parse and the page shows an
// error instead of the field.

import { z } from "zod";
import { getPrivacyCase, getPrivacyCases } from "@/lib/platform/console-client";
import { PRIVACY_KINDS, PRIVACY_STATES, REFERENCE_PATTERN } from "./constants";

const reference = z.string().regex(REFERENCE_PATTERN);
const kind = z.enum(PRIVACY_KINDS);
const state = z.enum(PRIVACY_STATES);
const instant = z.string().datetime({ offset: true });
const uuid = z.string().uuid();

const listRowSchema = z
	.object({
		reference,
		kind,
		state,
		receivedAt: instant,
		dueAt: instant,
		extendedAt: instant.nullable(),
		identityVerifiedAt: instant.nullable(),
		legalHoldReason: z.string().nullable(),
		decidedAt: instant.nullable(),
		organizationId: uuid.nullable(),
		subjectUserId: uuid.nullable(),
	})
	.strict();

/** One row of the privacy register. */
export type PrivacyListRow = z.infer<typeof listRowSchema>;

const registerSchema = z
	.object({
		open: z.array(listRowSchema),
		decided: z.array(listRowSchema),
		overdue: z.array(z.object({ reference, kind, state, dueAt: instant }).strict()),
	})
	.strict();

/** The privacy register: open cases, the overdue ones, and the recently decided. */
export type PrivacyRegister = z.infer<typeof registerSchema>;

const caseSchema = z
	.object({
		reference,
		kind,
		state,
		receivedAt: instant,
		dueAt: instant,
		extendedAt: instant.nullable(),
		extensionReason: z.string().nullable(),
		identityVerifiedAt: instant.nullable(),
		legalHoldReason: z.string().nullable(),
		decidedAt: instant.nullable(),
		refusalReason: z.string().nullable(),
		organizationId: uuid.nullable(),
		subjectUserId: uuid.nullable(),
	})
	.strict();

/** One privacy case, as the case page shows it. */
export type PrivacyCaseView = z.infer<typeof caseSchema>;

const caseDetailSchema = z
	.object({
		case: caseSchema,
		events: z.array(
			z
				.object({
					kind: z.string(),
					at: instant,
					summary: z.string().nullable(),
					actorEmail: z.string().nullable(),
				})
				.strict(),
		),
	})
	.strict();

/** One case and its ledger. */
export type PrivacyCaseDetail = z.infer<typeof caseDetailSchema>;

/** Reads and validates the privacy register from the console. */
export async function loadPrivacyRegister(): Promise<PrivacyRegister> {
	return registerSchema.parse(await getPrivacyCases());
}

/**
 * Reads and validates one case. Answers null for a string that is not a reference, and for a
 * reference the console does not know (its 404 surfaces as "no such privacy request").
 */
export async function loadPrivacyCase(ref: string): Promise<PrivacyCaseDetail | null> {
	if (!REFERENCE_PATTERN.test(ref)) return null;
	try {
		return caseDetailSchema.parse(await getPrivacyCase(ref));
	} catch (err) {
		if (err instanceof Error && err.message === "no such privacy request") return null;
		throw err;
	}
}
