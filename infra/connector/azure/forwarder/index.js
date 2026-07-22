// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Azure asset-inventory + capability-invalidation forwarder — an Event Grid-triggered Function. Normalizes
// a VNet/subnet resource-write/delete event (inventory) OR a Microsoft.Quota / Microsoft.Features write
// (capability_dirty) into Alethia's NormalizedCloudEvent contract and POSTs it to the console ingester
// (/api/cloud-events/azure). Deployed by ../events.tf into the customer subscription. Only normalized
// signals leave the subscription — never credentials.
//
// Event Grid binding (function.json): { type: "eventGridTrigger", name: "event", direction: "in" }.

/**
 * Classifies a capability-affecting subject → the capability axis it dirties: a Microsoft.Quota change
 * alters launch limits (quota); a Microsoft.Features registration can change region/SKU availability
 * (regions). Returns null for a non-capability subject.
 */
function capabilityAxis(subject) {
	if (/Microsoft\.Quota/i.test(subject)) return "quota";
	if (/Microsoft\.Features/i.test(subject)) return "regions";
	return null;
}

module.exports = async function (context, event) {
	// event.subject ≈ /subscriptions/.../resourceGroups/.../providers/Microsoft.Network/virtualNetworks/<name>[/subnets/<name>]
	const subject = event?.subject || "";
	const region = event?.data?.resourceLocation || null;

	// Capability invalidation (#978) — a quota/feature write → a capability_dirty SIGNAL (no data). The
	// console NULLs capabilities_synced_at → the next sweep re-enumerates keyless.
	const axis = capabilityAxis(subject);
	let normalized;
	if (axis) {
		normalized = { kind: "capability_dirty", axis, region };
	} else {
		const isSubnet = /\/subnets\//i.test(subject);
		const isVnet = /\/virtualNetworks\/[^/]+$/i.test(subject);
		if (!isSubnet && !isVnet) return;

		const eventType = event?.eventType || "";
		const deleted = /ResourceDeleteSuccess/i.test(eventType);
		const name = subject.split("/").pop() || null;

		normalized = {
			kind: isSubnet ? "subnet" : "network",
			native_id: subject, // the full ARM resource id is the stable native id
			name,
			region,
			deleted,
		};
	}

	const res = await fetch(`${process.env.INGESTION_URL}/api/cloud-events/azure`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${process.env.INGESTION_SECRET}`,
		},
		body: JSON.stringify({
			account_id: process.env.AZURE_SUBSCRIPTION_ID,
			events: [normalized],
		}),
	});
	if (!res.ok) {
		context.log.error(`Alethia ingestion HTTP ${res.status}`);
	}
};
