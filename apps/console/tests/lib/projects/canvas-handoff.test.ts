// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AVAILABLE_CLOUDS, HIDDEN_CLOUDS } from "@repo/cloud-catalog";
import { describe, expect, it } from "vitest";
import {
	byoWizardId,
	CANVAS_SEED_PARAM,
	CANVAS_SEED_VERSION,
	type CanvasSeed,
	CanvasSeedError,
	canvasHandoffHref,
	canvasSeedSchema,
	parseCanvasSeed,
	readCanvasSeed,
	serialiseCanvasSeed,
} from "@/lib/projects/canvas-handoff";
import {
	CONNECTED_ACCOUNT_VERSION,
	connectedAccount,
	connectedAccountSchema,
	parseConnectedAccount,
	serialiseConnectedAccount,
} from "@/lib/projects/connected-account";
import { sensitiveDraftKeys } from "@/lib/wizard/define";

const IDENTITY_ID = "0b0f4a52-7d5c-4a8e-9a53-0d6f1f1c2e11";

/** One seed of every kind, with the URL form each is expected to take. */
const SEEDS: readonly { readonly seed: CanvasSeed; readonly wire: string }[] = [
	{ seed: { kind: "blank" }, wire: "v1.blank" },
	{ seed: { kind: "byo", attach: "chart" }, wire: "v1.byo.chart" },
	{ seed: { kind: "byo", attach: "iac" }, wire: "v1.byo.iac" },
	{
		seed: { kind: "template", templateId: "standard", provider: "aws" },
		wire: "v1.template.standard.aws",
	},
	{
		seed: { kind: "template", templateId: "ai", provider: "hetzner" },
		wire: "v1.template.ai.hetzner",
	},
	{
		seed: { kind: "template", templateId: "custom", provider: "gcp" },
		wire: "v1.template.custom.gcp",
	},
	{
		seed: { kind: "proposal", proposalId: IDENTITY_ID },
		wire: `v1.proposal.${IDENTITY_ID}`,
	},
	{ seed: { kind: "proposal", proposalId: "scan_42-a" }, wire: "v1.proposal.scan_42-a" },
];

/** The refusal reason of a seed's URL form, or `null` when it was accepted. */
function seedRefusal(raw: string, offered?: readonly string[]): string | null {
	const parsed = parseCanvasSeed(raw, offered);
	return parsed.ok ? null : parsed.reason;
}

/** The refusal reason of a serialised account, or `null` when it was accepted. */
function accountRefusal(raw: string, offered?: readonly string[]): string | null {
	const parsed = parseConnectedAccount(raw, offered);
	return parsed.ok ? null : parsed.reason;
}

/** The reason `serialiseCanvasSeed` refuses `seed` with, or `null` when it serialises. */
function serialiseRefusal(seed: CanvasSeed, offered?: readonly string[]): string | null {
	try {
		serialiseCanvasSeed(seed, offered);
		return null;
	} catch (error) {
		if (error instanceof CanvasSeedError) return error.reason;
		throw error;
	}
}

describe("CanvasSeed: round trip", () => {
	it.each(SEEDS)("writes $wire and reads the same seed back", ({ seed, wire }) => {
		expect(serialiseCanvasSeed(seed)).toBe(wire);
		expect(parseCanvasSeed(wire)).toEqual({ ok: true, seed });
	});

	it("writes a URL form that needs no escaping and stays short", () => {
		for (const { seed } of SEEDS) {
			const wire = serialiseCanvasSeed(seed);
			expect(wire).toMatch(/^[A-Za-z0-9._-]+$/);
			expect(encodeURIComponent(wire)).toBe(wire);
			expect(wire.length).toBeLessThanOrEqual(80);
		}
	});

	it("is the current version", () => {
		expect(CANVAS_SEED_VERSION).toBe(1);
	});
});

describe("CanvasSeed: the link", () => {
	it("opens the project's canvas with the seed in ?seed=", () => {
		expect(canvasHandoffHref("acme", "shop", { kind: "blank" })).toBe(
			"/acme/shop/architecture?seed=v1.blank",
		);
	});

	it.each(SEEDS)("carries $wire through a link and back", ({ seed }) => {
		const href = canvasHandoffHref("acme", "shop", seed);
		const params = new URLSearchParams(href.slice(href.indexOf("?")));
		expect(readCanvasSeed(params)).toEqual(seed);
	});

	it("reads no seed from a link that carries none, or one it refuses", () => {
		expect(readCanvasSeed(new URLSearchParams(""))).toBeNull();
		expect(readCanvasSeed(new URLSearchParams({ [CANVAS_SEED_PARAM]: "" }))).toBeNull();
		expect(readCanvasSeed(new URLSearchParams({ [CANVAS_SEED_PARAM]: "v2.blank" }))).toBeNull();
		expect(
			readCanvasSeed(new URLSearchParams({ [CANVAS_SEED_PARAM]: "v1.template.ai.alibaba" })),
		).toBeNull();
	});

	it("refuses to build a link for a seed it would not read", () => {
		expect(() =>
			canvasHandoffHref("acme", "shop", {
				kind: "template",
				templateId: "ai",
				provider: "alibaba",
			}),
		).toThrow(CanvasSeedError);
	});

	it("names the overlay wizard a byo seed opens", () => {
		expect(byoWizardId("chart")).toBe("byo-chart");
		expect(byoWizardId("iac")).toBe("byo-iac");
	});
});

describe("CanvasSeed: version", () => {
	it.each(["v0.blank", "v2.blank", "v2.template.standard.aws", "v10.byo.chart"])(
		"refuses %s as another version",
		(raw) => {
			expect(seedRefusal(raw)).toBe("version");
		},
	);

	it.each(["blank", "1.blank", "v.blank", "vx.blank", "V1.blank", "v1", "v1.", "", "v-1.blank"])(
		"refuses %j, which names no version, as malformed",
		(raw) => {
			expect(seedRefusal(raw)).toBe("malformed");
		},
	);
});

describe("CanvasSeed: clouds", () => {
	it("accepts a template on each offered cloud", () => {
		for (const provider of AVAILABLE_CLOUDS) {
			expect(seedRefusal(`v1.template.standard.${provider}`)).toBeNull();
		}
	});

	it("refuses a template on each hidden cloud", () => {
		expect(HIDDEN_CLOUDS.length).toBeGreaterThan(0);
		for (const provider of HIDDEN_CLOUDS) {
			expect(seedRefusal(`v1.template.standard.${provider}`)).toBe("cloud-not-offered");
		}
	});

	it.each(["oracle", "AWS", "aws ", "", "__proto__"])(
		"refuses a template on %j, which is not a cloud",
		(provider) => {
			expect(seedRefusal(`v1.template.standard.${provider}`)).toBe("cloud-not-offered");
		},
	);

	it("follows the offered list it is given", () => {
		expect(seedRefusal("v1.template.standard.alibaba", [...AVAILABLE_CLOUDS, "alibaba"])).toBeNull();
		expect(seedRefusal("v1.template.standard.aws", ["gcp"])).toBe("cloud-not-offered");
		expect(seedRefusal("v1.template.standard.aws", [])).toBe("cloud-not-offered");
	});

	it("refuses a cloud that is offered but cannot hold a cluster, whatever the list says", () => {
		expect(seedRefusal("v1.template.standard.civo", ["civo"])).toBe("cloud-not-offered");
	});

	it("refuses to write a template seed on a cloud that is not offered", () => {
		const seed: CanvasSeed = { kind: "template", templateId: "standard", provider: "alibaba" };
		expect(serialiseRefusal(seed)).toBe("cloud-not-offered");
		expect(serialiseRefusal(seed, ["alibaba"])).toBeNull();
	});

	it("does not ask about a cloud for a seed that names none", () => {
		expect(seedRefusal("v1.blank", [])).toBeNull();
		expect(seedRefusal("v1.byo.iac", [])).toBeNull();
	});
});

describe("CanvasSeed: shape", () => {
	it.each([
		"v1.unknown",
		"v1.blank.extra",
		"v1.byo",
		"v1.byo.terraform",
		"v1.byo.chart.extra",
		"v1.template",
		"v1.template.standard",
		"v1.template.enterprise.aws",
		"v1.template.standard.aws.extra",
		"v1.proposal",
		"v1.proposal.",
		"v1.proposal.a.b",
		"v1.proposal.-leading",
		"v1.proposal.has space",
		"v1.proposal.a/b",
		`v1.proposal.${"a".repeat(65)}`,
	])("refuses %j as malformed", (raw) => {
		expect(seedRefusal(raw)).toBe("malformed");
	});

	it("accepts a proposal id of the longest length", () => {
		expect(seedRefusal(`v1.proposal.${"a".repeat(64)}`)).toBeNull();
	});
});

describe("CanvasSeed: holds identifiers only", () => {
	it("names no key that suggests a credential", () => {
		expect(sensitiveDraftKeys(canvasSeedSchema)).toEqual([]);
	});

	it.each(SEEDS)("refuses $wire with a key the schema does not name", ({ seed }) => {
		for (const key of ["token", "secret", "roleArn", "cloudIdentityId", "note"]) {
			const widened = { ...seed, [key]: "value" };
			expect(canvasSeedSchema.safeParse(widened).success).toBe(false);
			expect(serialiseRefusal(widened)).toBe("malformed");
		}
	});

	it("refuses a key that belongs to another kind", () => {
		const mixed = { kind: "blank", proposalId: "scan-1" };
		expect(canvasSeedSchema.safeParse(mixed).success).toBe(false);
	});

	it.each([
		"AKIAIOSFODNN7EXAMPLE/wJalrXUtnFEMI",
		"ghp_abc def",
		"a=b&c=d",
		"line\nbreak",
		"dotted.value",
		"x".repeat(200),
	])("has no field that takes the free text %j", (text) => {
		expect(serialiseRefusal({ kind: "proposal", proposalId: text })).toBe("malformed");
		expect(canvasSeedSchema.safeParse({ kind: "byo", attach: text }).success).toBe(false);
		expect(
			canvasSeedSchema.safeParse({ kind: "template", templateId: text, provider: "aws" }).success,
		).toBe(false);
		expect(
			canvasSeedSchema.safeParse({ kind: "template", templateId: "ai", provider: text }).success,
		).toBe(false);
	});

	it("writes nothing but the kind and its identifiers", () => {
		for (const { seed, wire } of SEEDS) {
			const values = Object.entries(seed)
				.filter(([key]) => key !== "kind")
				.map(([, value]) => value);
			expect(wire.split(".")).toEqual(["v1", seed.kind, ...values]);
		}
	});
});

describe("ConnectedAccount: round trip", () => {
	it.each([...AVAILABLE_CLOUDS])("builds, writes and reads back an account on %s", (provider) => {
		const built = connectedAccount({ identityId: IDENTITY_ID, provider });
		expect(built).toEqual({ ok: true, account: { identityId: IDENTITY_ID, provider } });
		if (!built.ok) return;
		const raw = serialiseConnectedAccount(built.account);
		expect(JSON.parse(raw)).toEqual({
			version: CONNECTED_ACCOUNT_VERSION,
			identityId: IDENTITY_ID,
			provider,
		});
		expect(parseConnectedAccount(raw)).toEqual(built);
	});

	it("is the current version", () => {
		expect(CONNECTED_ACCOUNT_VERSION).toBe(1);
	});
});

describe("ConnectedAccount: clouds", () => {
	it("refuses each hidden cloud, when built and when read", () => {
		expect(HIDDEN_CLOUDS.length).toBeGreaterThan(0);
		for (const provider of HIDDEN_CLOUDS) {
			const built = connectedAccount({ identityId: IDENTITY_ID, provider });
			expect(built).toEqual({ ok: false, reason: "cloud-not-offered" });
			const raw = JSON.stringify({ version: 1, identityId: IDENTITY_ID, provider });
			expect(accountRefusal(raw)).toBe("cloud-not-offered");
		}
	});

	it.each(["oracle", "AWS", "", "aws "])("refuses %j, which is not a cloud", (provider) => {
		expect(connectedAccount({ identityId: IDENTITY_ID, provider })).toEqual({
			ok: false,
			reason: "cloud-not-offered",
		});
		const raw = JSON.stringify({ version: 1, identityId: IDENTITY_ID, provider });
		expect(accountRefusal(raw)).toBe("cloud-not-offered");
	});

	it("follows the offered list it is given", () => {
		const input = { identityId: IDENTITY_ID, provider: "civo" };
		const raw = JSON.stringify({ version: 1, ...input });
		expect(connectedAccount(input, [...AVAILABLE_CLOUDS, "civo"]).ok).toBe(true);
		expect(accountRefusal(raw, [...AVAILABLE_CLOUDS, "civo"])).toBeNull();
		expect(accountRefusal(raw, [])).toBe("cloud-not-offered");
	});

	it("refuses a name in the offered list that is not a cloud", () => {
		expect(connectedAccount({ identityId: IDENTITY_ID, provider: "oracle" }, ["oracle"])).toEqual({
			ok: false,
			reason: "malformed",
		});
	});
});

describe("ConnectedAccount: version and shape", () => {
	it.each([0, 2, 99])("refuses version %d", (version) => {
		const raw = JSON.stringify({ version, identityId: IDENTITY_ID, provider: "aws" });
		expect(accountRefusal(raw)).toBe("version");
	});

	it.each([
		"",
		"not json",
		"null",
		"[]",
		'"aws"',
		JSON.stringify({ identityId: IDENTITY_ID, provider: "aws" }),
		JSON.stringify({ version: "1", identityId: IDENTITY_ID, provider: "aws" }),
		JSON.stringify({ version: 1, identityId: "not-an-id", provider: "aws" }),
		JSON.stringify({ version: 1, identityId: IDENTITY_ID }),
		JSON.stringify({ version: 1, provider: "aws" }),
		JSON.stringify({ version: 1, identityId: IDENTITY_ID, provider: 7 }),
	])("refuses %j as malformed", (raw) => {
		expect(accountRefusal(raw)).toBe("malformed");
	});

	it("refuses an identity id that is not a UUID", () => {
		expect(connectedAccount({ identityId: "identity-1", provider: "aws" })).toEqual({
			ok: false,
			reason: "malformed",
		});
	});
});

describe("ConnectedAccount: holds identifiers only", () => {
	it("names no key that suggests a credential", () => {
		expect(sensitiveDraftKeys(connectedAccountSchema)).toEqual([]);
	});

	it.each(["token", "secret", "roleArn", "credentials", "note"])(
		"refuses the extra key %s, in the schema and in the serialised form",
		(key) => {
			const widened = { identityId: IDENTITY_ID, provider: "aws", [key]: "value" };
			expect(connectedAccountSchema.safeParse(widened).success).toBe(false);
			expect(accountRefusal(JSON.stringify({ version: 1, ...widened }))).toBe("malformed");
		},
	);

	it("drops every key but the two identifiers when it builds and writes an account", () => {
		const input = { identityId: IDENTITY_ID, provider: "aws", roleArn: "arn:aws:iam::1:role/x" };
		const built = connectedAccount(input);
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(Object.keys(built.account).sort()).toEqual(["identityId", "provider"]);
		expect(serialiseConnectedAccount(built.account)).not.toContain("arn:");
	});
});
