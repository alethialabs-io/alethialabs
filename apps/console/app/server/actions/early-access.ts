"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The complimentary Early Access request (EA-3, #7325): an EU business with a VAT number asks for
// the paid tier free, until billing for its market opens. The logic is in lib/early-access/; these
// actions only authorize and pick the organization.
//
// Both act on the actor's ACTIVE organization, never a client-supplied id, and both need the
// billing permission (`manage_billing`): a request is filed by the organization's billing admin.
// Hosted only — a self-managed instance has no plans to grant.

import { authorize, authorizeRead } from "@/lib/authz/guard";
import { deploymentMode } from "@/lib/billing/config";
import {
	type EarlyAccessOverview,
	type FileEarlyAccessResult,
	fileEarlyAccessRequest,
	readEarlyAccessOverview,
} from "@/lib/early-access/request";

/** Refuses on a self-managed deployment, where there is no hosted plan to grant. */
function requireHosted(): void {
	if (deploymentMode() !== "hosted") {
		throw new Error("Early Access grants exist only on the hosted service.");
	}
}

/**
 * Files a complimentary Early Access request for the active organization. Answers a result rather
 * than throwing for anything the requester can fix (the form, the VAT number, an open request).
 */
export async function requestEarlyAccess(input: unknown): Promise<FileEarlyAccessResult> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHosted();
	return fileEarlyAccessRequest({ userId: actor.userId, orgId: actor.orgId }, input);
}

/** The active organization's Early Access requests, and whether grants are open. */
export async function getEarlyAccessOverview(): Promise<EarlyAccessOverview> {
	const actor = await authorizeRead("manage_billing", { type: "billing" });
	requireHosted();
	return readEarlyAccessOverview({ userId: actor.userId, orgId: actor.orgId });
}
