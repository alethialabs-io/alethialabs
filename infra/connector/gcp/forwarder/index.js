// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// GCP asset-inventory forwarder — triggered by a Cloud Asset Inventory feed via Pub/Sub. Normalizes a
// Network/Subnetwork change into Alethia's NormalizedCloudEvent contract and POSTs it to the console
// ingester (/api/cloud-events/gcp). Deployed by ../events.tf into the customer project.

const functions = require("@google-cloud/functions-framework");

/** Maps a CAI assetType → Alethia inventory kind. */
const KIND = {
	"compute.googleapis.com/Network": "network",
	"compute.googleapis.com/Subnetwork": "subnet",
};

functions.cloudEvent("forward", async (cloudEvent) => {
	const raw = cloudEvent?.data?.message?.data;
	if (!raw) return;
	const payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));

	// CAI change: { asset: { name, assetType, resource: { data } }, deleted, priorAssetState }
	const asset = payload.asset || payload.priorAsset || {};
	const kind = KIND[asset.assetType];
	if (!kind) return;

	const data = asset.resource?.data || {};
	const event = {
		kind,
		// Use the resource selfLink as the native id so events MATCH the inventory sync (syncGcpInventory
		// keys networks on selfLink); fall back to the CAI asset name on a delete with no resource data.
		native_id: data.selfLink || asset.name,
		name: data.name || null,
		region: data.region ? String(data.region).split("/").pop() : null,
		deleted: Boolean(payload.deleted),
	};

	const res = await fetch(`${process.env.INGESTION_URL}/api/cloud-events/gcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${process.env.INGESTION_SECRET}`,
		},
		body: JSON.stringify({
			account_id: process.env.GCP_PROJECT_ID,
			events: [event],
		}),
	});
	if (!res.ok) throw new Error(`ingestion HTTP ${res.status}`);
});
