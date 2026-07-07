// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Azure asset-inventory forwarder — an Event Grid-triggered Function. Normalizes a VNet/subnet
// resource-write/delete event into Alethia's NormalizedCloudEvent contract and POSTs it to the console
// ingester (/api/cloud-events/azure). Deployed by ../events.tf into the customer subscription.
//
// Event Grid binding (function.json): { type: "eventGridTrigger", name: "event", direction: "in" }.

module.exports = async function (context, event) {
	// event.subject ≈ /subscriptions/.../resourceGroups/.../providers/Microsoft.Network/virtualNetworks/<name>[/subnets/<name>]
	const subject = event?.subject || "";
	const isSubnet = /\/subnets\//i.test(subject);
	const isVnet = /\/virtualNetworks\/[^/]+$/i.test(subject);
	if (!isSubnet && !isVnet) return;

	const eventType = event?.eventType || "";
	const deleted = /ResourceDeleteSuccess/i.test(eventType);
	const name = subject.split("/").pop() || null;
	// Region: Event Grid puts the resource location in data.resourceProvider/claims; fall back to null.
	const region = event?.data?.resourceLocation || null;

	const normalized = {
		kind: isSubnet ? "subnet" : "network",
		native_id: subject, // the full ARM resource id is the stable native id
		name,
		region,
		deleted,
	};

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
