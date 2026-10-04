// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for the SERVER's half of a paid create-a-team setup (#5445), for the sheet tests.
//
// Since the resume became server-authoritative, the sheet asks `resolveNewOrgSetup` before every run
// and believes it over its own record. A mock that always answered "no org, not linked" would
// therefore make every resume create a second org — and a test asserting "no second org" would be
// asserting the mock. So the answer is DERIVED from what the mocked create and link actually did:
// an org created with the subscription marker in its metadata is "found", and a link that resolved
// makes the subscription "linked". `orgCreatedButResponseLost` models the case the review named —
// the server committed the org, the browser never heard.

import { NEW_ORG_SUBSCRIPTION_KEY, type NewOrgSetupState } from "@/lib/billing/new-org-setup";

interface Org {
	id: string;
	slug: string;
}

/** What the fake server holds: orgs by the subscription their metadata names, and links. */
export const fakeServer = {
	orgs: new Map<string, Org>(),
	linked: new Map<string, string>(),
	/** Forgets everything — call in `beforeEach`. */
	reset() {
		this.orgs.clear();
		this.linked.clear();
	},
};

/** The subscription id an org-create call's metadata names, or null. */
function markerOf(args: unknown): string | null {
	if (typeof args !== "object" || args === null) return null;
	const metadata: unknown = Reflect.get(args, "metadata");
	if (typeof metadata !== "object" || metadata === null) return null;
	const sub: unknown = Reflect.get(metadata, NEW_ORG_SUBSCRIPTION_KEY);
	return typeof sub === "string" ? sub : null;
}

/** Wraps a mocked `organization.create` so an org it creates is recorded against its marker. */
export function recordingCreate(
	create: (...a: unknown[]) => Promise<{ data: Org | null; error: unknown }>,
) {
	return async (...a: unknown[]) => {
		const result = await create(...a);
		const sub = markerOf(a[0]);
		if (result?.data && sub && !fakeServer.orgs.has(sub)) fakeServer.orgs.set(sub, result.data);
		return result;
	};
}

/** Records, server-side only, an org whose create response the browser never receives. */
export function orgCreatedButResponseLost(subscriptionId: string, org: Org): void {
	fakeServer.orgs.set(subscriptionId, org);
}

/** Wraps a mocked link so a link that resolves marks the subscription linked. */
export function recordingLink(link: (...a: unknown[]) => Promise<unknown>) {
	return async (...a: unknown[]) => {
		const result = await link(...a);
		const input: unknown = a[0];
		if (typeof input === "object" && input !== null) {
			const sub: unknown = Reflect.get(input, "subscriptionId");
			const org: unknown = Reflect.get(input, "orgId");
			if (typeof sub === "string" && typeof org === "string") fakeServer.linked.set(sub, org);
		}
		return result;
	};
}

/** The fake `resolveNewOrgSetup`: answers from what was recorded above. */
export async function fakeResolve(input: {
	subscriptionId: string;
	customerId: string;
}): Promise<NewOrgSetupState> {
	const linkedTo = fakeServer.linked.get(input.subscriptionId);
	const org = fakeServer.orgs.get(input.subscriptionId) ?? null;
	return {
		subscriptionId: input.subscriptionId,
		customerId: input.customerId,
		paid: true,
		planState: "active",
		org,
		linked: !!linkedTo && linkedTo === org?.id,
		declared: false,
		name: "Acme Cloud",
		slug: org?.slug ?? "acme-cloud",
		billing: null,
		currency: "eur",
	};
}
