// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Plain-language explanations for every Evidence concept, surfaced through the shared
// `FieldHelp` "?" popover (title + body + a "Learn more →" docs link). One source of truth so
// the column headers, the drawer's empty states, and the waivers panel all say the same thing.
// The whole point of the redesign: no dead-end status a user can't interpret or act on.

export interface EvidenceHelp {
	title: string;
	body: string;
	docsHref: string;
}

const DOCS = "/docs/elench";

export const EVIDENCE_HELP: Record<
	"verify" | "drift" | "security" | "receipt" | "waiver",
	EvidenceHelp
> = {
	verify: {
		title: "Verification",
		body: "Between plan and apply, the elench gate checks the plan for keyless access, least-privilege IAM, and OIDC-subject-bound trust. A hard failure blocks the apply. “Not verified” means no plan has run the gate against this environment yet.",
		docsHref: `${DOCS}/control-catalog`,
	},
	drift: {
		title: "Drift",
		body: "A refresh-only plan compares the live cloud against the state Alethia provisioned. “In sync” means nothing diverged; a count means that many managed resources changed outside Alethia. “Not scanned” means no drift scan has run yet.",
		docsHref: `${DOCS}/drift`,
	},
	security: {
		title: "Security scan",
		body: "Reads Trivy-Operator vulnerability reports from the cluster and rolls up critical / high / medium / low findings. “Not scanned” means the Trivy-Operator add-on isn’t installed — never a silent all-clear.",
		docsHref: `${DOCS}/security-scanning`,
	},
	receipt: {
		title: "Evidence receipt",
		body: "On every apply, Alethia seals a receipt binding the exact plan (SHA-256), the verdict, and the control-catalog version. Signed with an ed25519 key it becomes tamper-evident and verifiable offline. “—” means no apply has sealed one yet.",
		docsHref: `${DOCS}/receipts`,
	},
	waiver: {
		title: "Waiver",
		body: "An authorized, time-boxed pass of a specific failing control so a fail-closed apply can proceed deliberately — recorded with who, why, and when it expires, and sealed into the receipt as an exception.",
		docsHref: `${DOCS}/receipts`,
	},
};
