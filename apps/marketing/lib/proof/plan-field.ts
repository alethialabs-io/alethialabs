// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SAMPLE_RECEIPT, type VerifyStatus } from "./verify-receipt-sample";

/**
 * The subjects in the homepage field — the things a visitor drags into the gate.
 *
 * Honesty, precisely:
 *
 * - The **addresses** are real. Every one is a module or resource that
 *   `infra/templates/project/aws` actually declares (`module.eks`,
 *   `aws_iam_policy.irsa_karpenter`, `aws_vpc_endpoint.s3_gateway`, …).
 * - The **controls** are real. `id`, `title` and `frameworks` are read from
 *   `SAMPLE_RECEIPT` below, which is engine output from `packages/core/verify`.
 * - The **pairing** between an address and a control is illustrative. The real
 *   receipt reports per-control verdicts over a whole plan, not per-resource
 *   ones, so which address a control "belongs to" is our editorial choice.
 *
 * `not_evaluable` entries are the point, not an oversight: elench has four
 * verdicts and never silently passes something it could not inspect.
 */

/** One draggable subject: a plan address and the verdict the gate returns for it. */
export interface FieldSubject {
	/** A real OpenTofu address from the AWS project template. */
	address: string;
	/** The control id from the real catalog, or `null` when nothing covers it. */
	controlId: string | null;
	status: VerifyStatus;
	/** Why the gate reached this verdict, in one plain line. */
	note: string;
}

const CONTROLS = SAMPLE_RECEIPT.receipt.report.controls;

/** Look a real control up by id so titles and ids can never drift out of sync. */
function control(id: string) {
	const found = CONTROLS.find((c) => c.id === id);
	if (!found) {
		throw new Error(
			`plan-field: control "${id}" is not in the receipt catalog ` +
				`(${CONTROLS.map((c) => c.id).join(", ")}). The fixture changed — update this file.`,
		);
	}
	return found;
}

/** A covered subject: the control's own title becomes the note. */
function covered(address: string, id: string): FieldSubject {
	const c = control(id);
	return { address, controlId: c.id, status: c.status, note: c.title.toLowerCase() };
}

/** An uncovered subject: no control in the catalog can see it. */
function uncovered(address: string, note: string): FieldSubject {
	return { address, controlId: null, status: "not_evaluable", note };
}

export const FIELD_SUBJECTS: FieldSubject[] = [
	covered("module.eks", "KEYLESS-001"),
	covered("module.irsa_alethia_agent", "OIDC-001"),
	covered("aws_iam_policy.irsa_karpenter", "LEASTPRIV-001"),
	covered("aws_iam_policy.rds_iam_auth", "KEYLESS-001"),
	covered("module.rds_maindb", "LEASTPRIV-001"),
	uncovered("module.common_vpc", "no IAM surface on this resource"),
	uncovered("module.route53", "no IAM surface on this resource"),
	uncovered("aws_vpc_endpoint.s3_gateway", "outside the control catalog"),
];

/** The catalog version that produced every verdict above. */
export const FIELD_CATALOG = SAMPLE_RECEIPT.receipt.catalog_version;

/** The ed25519 key id the resulting receipt is signed under. */
export const FIELD_KEY_ID = SAMPLE_RECEIPT.key_id ?? "unsigned";

/** Short glyph tokens scattered among the subjects — the mark, and what it seals. */
export const FIELD_GLYPHS = ["[·]", "✓", "sha", "[·]"] as const;
