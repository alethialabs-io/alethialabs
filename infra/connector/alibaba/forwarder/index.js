// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Alibaba asset-change forwarder — a Function Compute function triggered by EventBridge on the
// `acs.actiontrail` bus (VPC/VSwitch create+delete). Normalizes one ActionTrail event into Alethia's
// NormalizedCloudEvent contract and POSTs it to the console ingester (/api/cloud-events/alibaba).
// Deployed by ../events.tf into the customer account. Only normalized {kind, native_id, region,
// deleted} events leave the account — never credentials.

/** Maps an ActionTrail eventName → [Alethia inventory kind, deleted]. */
const KIND = {
	CreateVpc: ["network", false],
	DeleteVpc: ["network", true],
	CreateVSwitch: ["subnet", false],
	DeleteVSwitch: ["subnet", true],
};

/** Reads a key from an object case-insensitively (ActionTrail casing varies by field). */
function pick(obj, ...keys) {
	if (!obj) return undefined;
	for (const k of keys) {
		if (obj[k] != null) return obj[k];
		const lower = k.charAt(0).toLowerCase() + k.slice(1);
		if (obj[lower] != null) return obj[lower];
	}
	return undefined;
}

/**
 * Function Compute handler. EventBridge delivers the ActionTrail event as a CloudEvents JSON buffer;
 * `.data` carries the raw ActionTrail record (eventName, acsRegion, requestParameters, responseElements).
 */
exports.handler = async (event, context, callback) => {
	try {
		const ce = JSON.parse(Buffer.from(event).toString("utf8"));
		const data = ce.data || ce; // tolerate an already-unwrapped record
		const name = pick(data, "eventName", "EventName");
		const map = KIND[name];
		if (!map) {
			callback(null, JSON.stringify({ skipped: name || "unknown" }));
			return;
		}
		const [kind, deleted] = map;

		const req = pick(data, "requestParameters", "RequestParameters") || {};
		const resp =
			pick(data, "responseElements", "ResponseElements", "serviceResponse") || {};
		// Native id MUST match the inventory sync key (inventory/alibaba.ts keys networks on VpcId,
		// subnets on VSwitchId): from the response on create, the request params on delete.
		const nativeId =
			kind === "network"
				? pick(resp, "VpcId") || pick(req, "VpcId")
				: pick(resp, "VSwitchId") || pick(req, "VSwitchId");
		const region = pick(data, "acsRegion", "AcsRegion", "region") || null;

		// The account id maps the event → connection (verified_account_id). Injected by ../events.tf
		// from the account data source (reliable), with the ActionTrail record as a fallback.
		const accountId =
			process.env.ALIBABA_ACCOUNT_ID ||
			pick(data, "acsAccountId", "AcsAccountId") ||
			pick(pick(data, "userIdentity", "UserIdentity") || {}, "accountId", "AccountId");

		if (!accountId || !nativeId) {
			callback(null, JSON.stringify({ skipped: "no id" }));
			return;
		}

		const res = await fetch(
			`${process.env.INGESTION_URL}/api/cloud-events/alibaba`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${process.env.INGESTION_SECRET}`,
				},
				body: JSON.stringify({
					account_id: String(accountId),
					events: [
						{
							kind,
							native_id: String(nativeId),
							name: null,
							region: region ? String(region) : null,
							deleted,
						},
					],
				}),
			},
		);
		if (!res.ok) throw new Error(`ingestion HTTP ${res.status}`);
		callback(null, JSON.stringify({ forwarded: nativeId }));
	} catch (err) {
		callback(err);
	}
};
