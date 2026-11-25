// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The words the approvals list and the decision sheet use (AGT-L2 design spec §0), in one place so
// the list, the sheet and the filter bar cannot disagree. Pure: no React, no server imports.
//
// The engine says `reject`; the UI says Deny / Denied. Credentials are never shown as their enum:
// `cli_session` is "Alethia CLI", `agent_oauth` the app's own name, and so on.

import type { StatusTier } from "@repo/ui/status-badge";
import type { ApplyOperation, ApprovalStatus } from "@/lib/approvals/types";
import type { CredentialKind } from "@/lib/authz/types";

/** Each effective status's label and its explicit `StatusBadge` tier (spec §0; gap G12). */
export const APPROVAL_STATUS: Record<ApprovalStatus, { label: string; tier: StatusTier }> = {
	pending: { label: "Waiting", tier: "pending" },
	approved: { label: "Approved", tier: "active" },
	consumed: { label: "Used", tier: "active" },
	rejected: { label: "Denied", tier: "failed" },
	expired: { label: "Expired", tier: "disabled" },
	superseded: { label: "Replaced", tier: "disabled" },
};

/** The operation as a person reads it. */
export const OPERATION_LABEL: Record<ApplyOperation, string> = {
	deploy: "Deploy",
	destroy: "Destroy",
};

/** The credential kind as the "Requested through" facet names it. */
export const CREDENTIAL_LABEL: Record<CredentialKind, string> = {
	session: "Alethia console",
	cli_session: "Alethia CLI",
	agent_oauth: "Connected agent",
	agent_in_app: "Alethia assistant",
	service_token: "Service token",
};

/** The fields of an approval that say what asked for it. */
export interface RequesterCredential {
	requester_credential: CredentialKind;
	requester_credential_name: string | null;
}

/**
 * What asked, as one name: the connected agent's app name ("Claude Code"), the service token's name,
 * or the credential's label when there is no name to show. Used in sentences ("Approving lets Claude
 * Code deploy…"), so it is a proper name, never the enum.
 */
export function requesterName(a: RequesterCredential): string {
	if ((a.requester_credential === "agent_oauth" || a.requester_credential === "service_token") && a.requester_credential_name) {
		return a.requester_credential_name;
	}
	return CREDENTIAL_LABEL[a.requester_credential];
}

/**
 * The "Requested through" line: the name and, when the name is not already the label, the kind under
 * it ("Claude Code" · "Connected agent"; "ci-deploy" · "Service token"). A console request is the
 * Enterprise second-person case: the requester started it themselves and it needs someone else.
 */
export function requestedThrough(a: RequesterCredential): { name: string; kind: string | null } {
	const name = requesterName(a);
	if (a.requester_credential === "session") {
		return { name, kind: "Started by them, needs a second person" };
	}
	const kind = CREDENTIAL_LABEL[a.requester_credential];
	return { name, kind: name === kind ? null : kind };
}

/** The sheet's title and the dialog's accessible name: "Deploy · payments-api / staging". */
export function approvalTitle(a: { operation: ApplyOperation; project_name: string; environment_name: string }): string {
	return `${OPERATION_LABEL[a.operation]} · ${a.project_name} / ${a.environment_name}`;
}
