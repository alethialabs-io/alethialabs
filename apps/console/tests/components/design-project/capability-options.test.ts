// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The three invariants of the capability seam. These are the rules the #939/#977/#980 lanes build
// against, and each one, if broken, fails SILENTLY in the product — an empty picker, another cloud's
// SKUs, or a quota we couldn't check rendered as one we verified. So they're pinned here rather than
// left to review.

import { describe, expect, it } from "vitest";
import {
	advisoryFor,
	cacheTierOptions,
	existingNetworkOptions,
	instanceTypeOptions,
	intersectWithFloor,
	k8sVersionOptions,
	nosqlKeyTypeOptions,
	regionCodes,
	subnetOptions,
	withSelected,
} from "@/components/design-project/canvas/inspector/capability-options";
import {
	NO_CAPABILITIES,
	type CapabilityBag,
	type FieldCtx,
} from "@/components/design-project/canvas/inspector/config-schema";
import type { CloudProviderSlug } from "@/lib/cloud-providers";

/** A ctx whose bag describes the SAME provider as the node — the happy path. */
const ctxWith = (
	provider: CloudProviderSlug,
	bag: Partial<CapabilityBag> = {},
): FieldCtx => ({
	provider,
	config: {},
	caps: { ...NO_CAPABILITIES, provider, identityId: "id-1", state: "ready", ...bag },
});

/** A ctx with NO account data at all (fresh create flow, or nothing synced). */
const ctxStatic = (provider: CloudProviderSlug): FieldCtx => ({
	provider,
	config: {},
	caps: NO_CAPABILITIES,
});

describe("invariant 1 — fail open (#918): the picker is never empty", () => {
	it("falls back to the static catalog for every axis when the account reports nothing", () => {
		const ctx = ctxStatic("aws");
		expect(regionCodes(ctx).length).toBeGreaterThan(0);
		expect(instanceTypeOptions(ctx).length).toBeGreaterThan(0);
		expect(k8sVersionOptions(ctx).length).toBeGreaterThan(0);
		expect(cacheTierOptions(ctx).length).toBeGreaterThan(0);
		expect(nosqlKeyTypeOptions(ctx).length).toBeGreaterThan(0);
	});

	it("carries no advisory on a static row — no signal must not read as a verdict", () => {
		for (const o of instanceTypeOptions(ctxStatic("aws"))) {
			expect(o.advisory).toBeUndefined();
		}
	});

	it("prefers account rows once they exist", () => {
		const ctx = ctxWith("aws", {
			instanceTypes: [{ value: "m9.mega", label: "m9.mega", launchable: "launchable" }],
		});
		expect(instanceTypeOptions(ctx).map((o) => o.value)).toEqual(["m9.mega"]);
	});
});

describe("invariant 2 — the tri-state is guidance, never a gate", () => {
	it("gives NO advisory for launchable or for a static row", () => {
		expect(advisoryFor("launchable", "available")).toBeUndefined();
		expect(advisoryFor(undefined, null)).toBeUndefined();
	});

	it("marks not_launchable unavailable and not_evaluable unverified — never 'available'", () => {
		expect(advisoryFor("not_launchable", "quota_zero")?.level).toBe("unavailable");
		expect(advisoryFor("not_evaluable", "quota_unknown")?.level).toBe("unverified");
		// There is no positive level in the vocabulary at all — that is what makes
		// "not_evaluable must never render as available" structural rather than a review rule.
		const levels = (["not_launchable", "not_evaluable"] as const).map(
			(l) => advisoryFor(l, null)?.level,
		);
		expect(levels).not.toContain("available");
	});

	it("maps the reason from the bounded enum and never echoes an unknown value", () => {
		expect(advisoryFor("not_launchable", "sold_out")?.note).toMatch(/sold out/i);
		// An unrecognised reason must not reach the DOM — it degrades to the honest wording.
		const note = advisoryFor("not_launchable", "<img src=x onerror=1>")?.note;
		expect(note).not.toContain("<img");
		expect(note).toMatch(/can't be checked/i);
	});

	it("still OFFERS a not_launchable option (advisory is ink, not a filter)", () => {
		const ctx = ctxWith("aws", {
			instanceTypes: [
				{ value: "a", label: "a", launchable: "not_launchable", launchableReason: "quota_zero" },
			],
		});
		const opts = instanceTypeOptions(ctx);
		expect(opts.map((o) => o.value)).toEqual(["a"]);
		expect(opts[0].advisory?.level).toBe("unavailable");
	});
});

describe("invariant 3 — provider mismatch degrades to static, never to another cloud", () => {
	it("ignores a bag describing a different provider", () => {
		const ctx: FieldCtx = {
			provider: "aws",
			config: {},
			caps: {
				...NO_CAPABILITIES,
				provider: "gcp",
				identityId: "id-1",
				instanceTypes: [{ value: "n2-standard-4", label: "n2-standard-4" }],
			},
		};
		const values = instanceTypeOptions(ctx).map((o) => o.value);
		expect(values).not.toContain("n2-standard-4");
		expect(values.length).toBeGreaterThan(0); // fell back to AWS static, not empty
	});

	it("returns no placement inventory on mismatch rather than another account's networks", () => {
		const ctx: FieldCtx = {
			provider: "aws",
			config: {},
			caps: {
				...NO_CAPABILITIES,
				provider: "gcp",
				networks: [
					{ nativeId: "vpc-x", name: null, region: null, cidrBlock: null, isDefault: false },
				],
			},
		};
		expect(existingNetworkOptions(ctx)).toEqual([]);
	});
});

describe("withSelected — a stored value can never vanish from the list", () => {
	it("pins an unknown stored value in, marked unverified", () => {
		const opts = withSelected([{ value: "a", label: "A" }], "legacy-sku");
		expect(opts.map((o) => o.value)).toEqual(["a", "legacy-sku"]);
		expect(opts[1].advisory?.level).toBe("unverified");
	});

	it("leaves the list alone when the value is present, or empty", () => {
		const list = [{ value: "a", label: "A" }];
		expect(withSelected(list, "a")).toBe(list);
		expect(withSelected(list, "")).toBe(list);
	});
});

describe("enum-bound axes drop out-of-enum capability values", () => {
	it("keeps only S/N/B for nosql key types", () => {
		// `nosql_key_type` is a pgEnum. A federated value outside it would save through the form and
		// then fail on INSERT, so it must never be offered.
		const ctx = ctxWith("aws", {
			nosqlKeyTypes: [
				{ value: "S", label: "String" },
				{ value: "GEOPOINT", label: "Geo point" },
			],
		});
		expect(nosqlKeyTypeOptions(ctx).map((o) => o.value)).toEqual(["S"]);
	});

	it("falls back to static when every account value is out of enum", () => {
		const ctx = ctxWith("aws", {
			nosqlKeyTypes: [{ value: "GEOPOINT", label: "Geo point" }],
		});
		expect(nosqlKeyTypeOptions(ctx).length).toBeGreaterThan(0);
		expect(nosqlKeyTypeOptions(ctx).map((o) => o.value)).not.toContain("GEOPOINT");
	});
});

describe("intersectWithFloor — the deploy-time floor wins on an empty intersection", () => {
	const floor = [
		{ value: "postgres", label: "PostgreSQL" },
		{ value: "mysql", label: "MySQL" },
	];

	it("narrows the floor to what the account reports", () => {
		const kept = intersectWithFloor(floor, [{ value: "postgres", label: "pg" }]);
		expect(kept.map((o) => o.value)).toEqual(["postgres"]);
	});

	it("returns the floor untouched when the account reports nothing", () => {
		expect(intersectWithFloor(floor, [])).toEqual(floor);
	});

	it("returns the FLOOR when the intersection is empty — never an empty radio", () => {
		// e.g. Hetzner, whose chart mapper only knows CNPG/Valkey, with a capability sync that
		// reported only engines the mapper can't deploy. An empty engine radio is a #918 violation.
		const kept = intersectWithFloor(floor, [{ value: "oracle", label: "Oracle" }]);
		expect(kept).toEqual(floor);
	});

	it("carries the advisory through on a kept option", () => {
		const kept = intersectWithFloor(floor, [
			{ value: "postgres", label: "pg", launchable: "not_evaluable", launchableReason: "quota_unknown" },
		]);
		expect(kept[0].advisory?.level).toBe("unverified");
	});
});

describe("placement inventory (#980)", () => {
	const bag: Partial<CapabilityBag> = {
		networks: [
			{
				nativeId: "vpc-abc",
				name: "prod",
				region: "us-east-1",
				cidrBlock: "10.0.0.0/16",
				isDefault: true,
			},
		],
		subnets: [
			{
				nativeId: "subnet-1",
				name: "a",
				region: "us-east-1",
				cidrBlock: "10.0.1.0/24",
				isDefault: false,
				availabilityZone: "us-east-1a",
				isPublic: true,
				networkRowId: "vpc-abc",
			},
			{
				nativeId: "subnet-2",
				name: "b",
				region: "us-east-1",
				cidrBlock: "10.9.1.0/24",
				isDefault: false,
				availabilityZone: "us-east-1b",
				isPublic: false,
				networkRowId: "vpc-other",
			},
		],
	};

	it("values the network option on the NATIVE id, not a row uuid", () => {
		// project_network.network_id stores `vpc-…`; writing a uuid there breaks the tofu path.
		const opts = existingNetworkOptions(ctxWith("aws", bag));
		expect(opts[0].value).toBe("vpc-abc");
		expect(opts[0].label).toContain("vpc-abc");
	});

	it("narrows subnets to the selected network", () => {
		const opts = subnetOptions(ctxWith("aws", bag), "vpc-abc");
		expect(opts.map((o) => o.value)).toEqual(["subnet-1"]);
	});

	it("lists every subnet when no network is selected", () => {
		expect(subnetOptions(ctxWith("aws", bag)).length).toBe(2);
	});
});
