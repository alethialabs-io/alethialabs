// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// GCP asset-inventory + capability-invalidation forwarder — triggered by a Cloud Asset Inventory feed via
// Pub/Sub. Normalizes a Network/Subnetwork change (inventory) OR a serviceusage Service enable/disable
// (capability_dirty) into Alethia's NormalizedCloudEvent contract and POSTs it to the console ingester
// (/api/cloud-events/gcp). Deployed by ../events.tf into the customer project. Only normalized signals
// leave the project — never credentials.

const functions = require("@google-cloud/functions-framework");

/** Maps a CAI assetType → Alethia inventory kind. */
const KIND = {
	"compute.googleapis.com/Network": "network",
	"compute.googleapis.com/Subnetwork": "subnet",
};

/** CAI assetTypes whose change INVALIDATES the account's capability catalog → the capability axis they
 * dirty. A serviceusage Service enable/disable changes which services (and offerings) are launchable. */
const CAP_AXIS = {
	"serviceusage.googleapis.com/Service": "services",
};

/** Builds the normalized event for one CAI change, or null if the assetType isn't one we forward. */
function normalize(asset, deleted) {
	const kind = KIND[asset.assetType];
	if (kind) {
		const data = asset.resource?.data || {};
		return {
			kind,
			// Use the resource selfLink as the native id so events MATCH the inventory sync (syncGcpInventory
			// keys networks on selfLink); fall back to the CAI asset name on a delete with no resource data.
			native_id: data.selfLink || asset.name,
			name: data.name || null,
			region: data.region ? String(data.region).split("/").pop() : null,
			deleted,
		};
	}
	const axis = CAP_AXIS[asset.assetType];
	if (axis) {
		// A capability-invalidation SIGNAL — no data, just the dirtied axis (services are project-global, so
		// no region). The console NULLs capabilities_synced_at → the next sweep re-enumerates keyless.
		return { kind: "capability_dirty", axis, region: null };
	}
	return null;
}

functions.cloudEvent("forward", async (cloudEvent) => {
	const raw = cloudEvent?.data?.message?.data;
	if (!raw) return;
	const payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));

	// CAI change: { asset: { name, assetType, resource: { data } }, deleted, priorAssetState }
	const asset = payload.asset || payload.priorAsset || {};
	const event = normalize(asset, Boolean(payload.deleted));
	if (!event) return;

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
