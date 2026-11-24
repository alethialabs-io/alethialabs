// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6889 — the instance edition contract.
//
// One resolver answers "which edition is this instance, which capabilities does its licence
// grant, which enterprise modules are built". These tests pin the answer for each edition
// (hosted, self-hosted, enterprise) and the rule the contract exists for: a licence state that
// was not reported, could not be read or does not hold together grants what a community
// instance has.
//
// The expected values are written out by hand, never derived from the module under test.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	hasEditionReporter,
	isLicenseState,
	licenseStateGrants,
	parseEnterpriseEditionReport,
	type EnterpriseEditionReport,
	type LicenseState,
} from "@alethia/enterprise-api";

vi.mock("server-only", () => ({}));

/** What the mocked enterprise loader answers in the case under test. */
const loader = vi.hoisted(() => ({
	editionState: vi.fn<() => unknown>(),
	getEnterprise: vi.fn<() => unknown>(),
}));

vi.mock("@/lib/enterprise", () => ({
	editionState: loader.editionState,
	getEnterprise: loader.getEnterprise,
}));

import {
	getInstanceEdition,
	instanceCapabilities,
	resolveInstanceEdition,
} from "@/lib/edition/instance-edition";

/** The fixed clock every case is read at. */
const NOW = new Date("2026-12-01T00:00:00.000Z");

/** The ten capabilities, in display order, written out. */
const ALL_CAPABILITIES = [
	"organizations",
	"teams",
	"customRoles",
	"sso",
	"activityExport",
	"alerting",
	"advancedAlerting",
	"byoRunners",
	"managedPools",
	"agentPolicy",
];

/** The enterprise modules as the enterprise package names them today: two built, five planned. */
const FEATURES = [
	{ id: "sso-provisioning", built: true },
	{ id: "enforced-sso", built: false },
	{ id: "group-mapping", built: false },
	{ id: "scim", built: false },
	{ id: "audit-stream", built: false },
	{ id: "session-policy", built: false },
	{ id: "agent-policy", built: true },
];

/** A report for a licence in `state`, with dates that agree with that state at {@link NOW}. */
function reportFor(state: LicenseState): EnterpriseEditionReport {
	const dates: Record<LicenseState, { expiresAt: string | null; graceEndsAt: string | null }> = {
		none: { expiresAt: null, graceEndsAt: null },
		active: { expiresAt: "2027-12-01T00:00:00.000Z", graceEndsAt: "2027-12-31T00:00:00.000Z" },
		expiring: { expiresAt: "2026-12-15T00:00:00.000Z", graceEndsAt: "2027-01-14T00:00:00.000Z" },
		grace: { expiresAt: "2026-11-20T00:00:00.000Z", graceEndsAt: "2026-12-20T00:00:00.000Z" },
		expired: { expiresAt: "2026-09-01T00:00:00.000Z", graceEndsAt: "2026-10-01T00:00:00.000Z" },
		invalid: { expiresAt: null, graceEndsAt: null },
	};
	const named = state !== "none" && state !== "invalid";
	return {
		license: {
			state,
			subject: named ? "Example GmbH" : null,
			tier: named ? "enterprise" : null,
			...dates[state],
		},
		capabilities: ALL_CAPABILITIES,
		features: FEATURES,
	};
}

/** Makes the loader answer as an enterprise build whose module reports `report`. */
function enterpriseReporting(report: unknown): void {
	loader.editionState.mockReturnValue({ kind: "enterprise" });
	loader.getEnterprise.mockReturnValue({ instanceEdition: async () => report });
}

beforeEach(() => {
	loader.editionState.mockReset();
	loader.getEnterprise.mockReset();
	vi.unstubAllEnvs();
});

describe("the capability list", () => {
	it("names the ten capabilities a licence can grant, in display order", () => {
		expect(instanceCapabilities()).toEqual(ALL_CAPABILITIES);
	});
});

describe("the hosted edition", () => {
	it("leaves capabilities to each organisation's plan and lists the built modules", async () => {
		vi.stubEnv("ALETHIA_DEPLOYMENT_MODE", "hosted");
		enterpriseReporting({ ...reportFor("none"), capabilities: [] });

		expect(await getInstanceEdition(NOW)).toEqual({
			deployment: "hosted",
			edition: "enterprise",
			offering: "hosted",
			license: { state: "none", subject: null, tier: null, expiresAt: null, graceEndsAt: null },
			capabilitySource: "organization-plan",
			capabilities: [],
			features: FEATURES,
			diagnostic: "ok",
		});
	});

	it("is still hosted, with each organisation's plan deciding, when the module reports nothing", async () => {
		vi.stubEnv("ALETHIA_DEPLOYMENT_MODE", "hosted");
		loader.editionState.mockReturnValue({ kind: "enterprise" });
		loader.getEnterprise.mockReturnValue({});

		const edition = await getInstanceEdition(NOW);
		expect(edition.offering).toBe("hosted");
		expect(edition.capabilitySource).toBe("organization-plan");
		expect(edition.capabilities).toEqual([]);
		expect(edition.license.state).toBe("unknown");
		expect(edition.diagnostic).toBe("no-report");
	});

	it("grants nothing on a hosted community build", async () => {
		vi.stubEnv("ALETHIA_DEPLOYMENT_MODE", "hosted");
		loader.editionState.mockReturnValue({ kind: "community", reason: "configured" });

		const edition = await getInstanceEdition(NOW);
		expect(edition.offering).toBe("hosted");
		expect(edition.edition).toBe("community");
		expect(edition.capabilitySource).toBe("community");
		expect(edition.capabilities).toEqual([]);
	});
});

describe("the self-hosted edition", () => {
	it.each([
		["configured as community", { kind: "community", reason: "configured" }],
		["with the enterprise package not installed", { kind: "community", reason: "not-installed" }],
	])("is a community build with no licence and no enterprise modules (%s)", async (_name, state) => {
		loader.editionState.mockReturnValue(state);

		expect(await getInstanceEdition(NOW)).toEqual({
			deployment: "self-managed",
			edition: "community",
			offering: "self-hosted",
			license: { state: "none", subject: null, tier: null, expiresAt: null, graceEndsAt: null },
			capabilitySource: "community",
			capabilities: [],
			features: [],
			diagnostic: "ok",
		});
		expect(loader.getEnterprise).not.toHaveBeenCalled();
	});

	it("reads any deployment mode other than hosted as self-managed", async () => {
		vi.stubEnv("ALETHIA_DEPLOYMENT_MODE", "Hosted ");
		loader.editionState.mockReturnValue({ kind: "community", reason: "configured" });

		expect((await getInstanceEdition(NOW)).deployment).toBe("self-managed");
	});

	it.each<LicenseState>(["none", "expired", "invalid"])(
		"is what the enterprise build is when its licence is %s",
		async (state) => {
			enterpriseReporting(reportFor(state));

			const edition = await getInstanceEdition(NOW);
			expect(edition.edition).toBe("enterprise");
			expect(edition.offering).toBe("self-hosted");
			expect(edition.license.state).toBe(state);
			expect(edition.capabilitySource).toBe("community");
			expect(edition.capabilities).toEqual([]);
			// The modules are a property of the build, so they are listed whatever the licence says.
			expect(edition.features).toEqual(FEATURES);
			expect(edition.diagnostic).toBe("ok");
		},
	);
});

describe("the enterprise edition", () => {
	it("grants the licensed capabilities and reports the licence and the modules", async () => {
		enterpriseReporting(reportFor("active"));

		expect(await getInstanceEdition(NOW)).toEqual({
			deployment: "self-managed",
			edition: "enterprise",
			offering: "enterprise",
			license: {
				state: "active",
				subject: "Example GmbH",
				tier: "enterprise",
				expiresAt: "2027-12-01T00:00:00.000Z",
				graceEndsAt: "2027-12-31T00:00:00.000Z",
			},
			capabilitySource: "instance-license",
			capabilities: ALL_CAPABILITIES,
			features: FEATURES,
			diagnostic: "ok",
		});
	});

	it.each<LicenseState>(["expiring", "grace"])("keeps its capabilities while the licence is %s", async (state) => {
		enterpriseReporting(reportFor(state));

		const edition = await getInstanceEdition(NOW);
		expect(edition.offering).toBe("enterprise");
		expect(edition.license.state).toBe(state);
		expect(edition.capabilitySource).toBe("instance-license");
		expect(edition.capabilities).toEqual(ALL_CAPABILITIES);
	});

	it("grants a licence with no end", async () => {
		const report = reportFor("active");
		enterpriseReporting({ ...report, license: { ...report.license, expiresAt: null, graceEndsAt: null } });

		const edition = await getInstanceEdition(NOW);
		expect(edition.offering).toBe("enterprise");
		expect(edition.license.expiresAt).toBeNull();
	});

	it("grants only the capabilities the licence names, drops names it does not know, and orders them", async () => {
		enterpriseReporting({
			...reportFor("active"),
			capabilities: ["sso", "not-a-capability", "quotas", "toString", "teams", "sso"],
		});

		expect((await getInstanceEdition(NOW)).capabilities).toEqual(["teams", "sso"]);
	});

	it("names a module that is not built without calling it built", async () => {
		enterpriseReporting(reportFor("active"));

		const { features } = await getInstanceEdition(NOW);
		expect(features.filter((feature) => feature.built).map((feature) => feature.id)).toEqual([
			"sso-provisioning",
			"agent-policy",
		]);
		expect(features.find((feature) => feature.id === "scim")).toEqual({ id: "scim", built: false });
	});

	it("is licensed on the hosted service too, where the licence is read before any plan", async () => {
		vi.stubEnv("ALETHIA_DEPLOYMENT_MODE", "hosted");
		enterpriseReporting(reportFor("active"));

		const edition = await getInstanceEdition(NOW);
		expect(edition.offering).toBe("hosted");
		expect(edition.capabilitySource).toBe("instance-license");
		expect(edition.capabilities).toEqual(ALL_CAPABILITIES);
	});
});

describe("a licence state that cannot be relied on", () => {
	/** The answer every case in this block must reduce to on a self-managed enterprise build. */
	function expectCommunityAnswer(
		edition: Awaited<ReturnType<typeof getInstanceEdition>>,
		diagnostic: string,
	): void {
		expect(edition.offering).toBe("self-hosted");
		expect(edition.license.state).toBe("unknown");
		expect(edition.capabilitySource).toBe("community");
		expect(edition.capabilities).toEqual([]);
		expect(edition.diagnostic).toBe(diagnostic);
	}

	it("grants nothing when the module does not report the edition", async () => {
		loader.editionState.mockReturnValue({ kind: "enterprise" });
		loader.getEnterprise.mockReturnValue({ resolveEntitlements: async () => ({}) });

		const edition = await getInstanceEdition(NOW);
		expectCommunityAnswer(edition, "no-report");
		expect(edition.edition).toBe("enterprise");
		expect(edition.features).toEqual([]);
	});

	it("grants nothing when no module is registered", async () => {
		loader.editionState.mockReturnValue({ kind: "enterprise" });
		loader.getEnterprise.mockReturnValue(null);

		const edition = await getInstanceEdition(NOW);
		expectCommunityAnswer(edition, "no-report");
		expect(edition.capabilities).toEqual([]);
	});

	it("grants nothing when asking for the report throws, and does not throw itself", async () => {
		loader.editionState.mockReturnValue({ kind: "enterprise" });
		loader.getEnterprise.mockReturnValue({
			instanceEdition: async () => {
				throw new Error("the licence could not be read");
			},
		});

		const edition = await getInstanceEdition(NOW);
		expectCommunityAnswer(edition, "report-failed");
		expect(edition.capabilities).toEqual([]);
	});

	it("grants nothing when the report throws synchronously", async () => {
		loader.editionState.mockReturnValue({ kind: "enterprise" });
		loader.getEnterprise.mockReturnValue({
			instanceEdition: () => {
				throw new Error("the licence could not be read");
			},
		});

		const edition = await getInstanceEdition(NOW);
		expectCommunityAnswer(edition, "report-failed");
		expect(edition.capabilities).toEqual([]);
	});

	it("grants nothing when the loader throws after reporting an enterprise build", async () => {
		loader.editionState.mockReturnValue({ kind: "enterprise" });
		loader.getEnterprise.mockImplementation(() => {
			throw new Error("load failed");
		});

		const edition = await getInstanceEdition(NOW);
		expectCommunityAnswer(edition, "enterprise-load-failed");
		expect(edition.capabilities).toEqual([]);
	});

	it("answers as a community build when the enterprise load failed", async () => {
		loader.editionState.mockReturnValue({ kind: "failed", error: new Error("register blew up") });

		const edition = await getInstanceEdition(NOW);
		expectCommunityAnswer(edition, "enterprise-load-failed");
		expect(edition.edition).toBe("community");
		expect(edition.features).toEqual([]);
		expect(loader.getEnterprise).not.toHaveBeenCalled();
	});

	it.each([
		["not an object", "active"],
		["null", null],
		["no licence", { capabilities: ALL_CAPABILITIES, features: FEATURES }],
		["a state that is not one of the six", { ...reportFor("active"), license: { state: "licensed" } }],
		["a boolean in place of a state", { ...reportFor("active"), license: { active: true } }],
		[
			"an end that is not a date",
			{ ...reportFor("active"), license: { ...reportFor("active").license, expiresAt: "next year" } },
		],
		[
			"an end that is a number",
			{ ...reportFor("active"), license: { ...reportFor("active").license, expiresAt: 1827619200 } },
		],
		["a subject that is not a string", { ...reportFor("active"), license: { state: "active", subject: 7 } }],
		["capabilities that are not a list", { ...reportFor("active"), capabilities: { sso: true } }],
		["a capability that is not a string", { ...reportFor("active"), capabilities: ["sso", true] }],
		["no capabilities", { license: reportFor("active").license, features: FEATURES }],
		["features that are not a list", { ...reportFor("active"), features: "all" }],
		["a feature with no id", { ...reportFor("active"), features: [{ built: true }] }],
		["a feature with an empty id", { ...reportFor("active"), features: [{ id: "", built: true }] }],
		["a feature whose built is not a boolean", { ...reportFor("active"), features: [{ id: "scim", built: "yes" }] }],
	])("grants nothing for a report with %s", async (_name, report) => {
		enterpriseReporting(report);

		const edition = await getInstanceEdition(NOW);
		expectCommunityAnswer(edition, "malformed-report");
		// A report is accepted whole or not at all: its module list is not used either.
		expect(edition.features).toEqual([]);
	});

	it.each([
		["active with an end that has passed", "active", { expiresAt: "2026-11-30T23:59:59.000Z" }],
		["active with an end at this instant", "active", { expiresAt: "2026-12-01T00:00:00.000Z" }],
		["expiring with an end that has passed", "expiring", { expiresAt: "2026-06-01T00:00:00.000Z" }],
		["grace with a grace end that has passed", "grace", { graceEndsAt: "2026-11-30T00:00:00.000Z" }],
		["grace with no grace end", "grace", { graceEndsAt: null }],
	] satisfies [string, LicenseState, Partial<EnterpriseEditionReport["license"]>][])(
		"grants nothing for a licence reported %s",
		async (_name, state, dates) => {
			const report = reportFor(state);
			enterpriseReporting({ ...report, license: { ...report.license, ...dates } });

			const edition = await getInstanceEdition(NOW);
			expectCommunityAnswer(edition, "inconsistent-report");
			// The licence is still described, and the modules are still listed.
			expect(edition.license.subject).toBe("Example GmbH");
			expect(edition.features).toEqual(FEATURES);
		},
	);

	it("never treats a report as a licence on a community build", () => {
		const edition = resolveInstanceEdition({
			deployment: "self-managed",
			build: "community",
			outcome: { kind: "report", report: reportFor("active") },
			now: NOW,
		});

		expect(edition.offering).toBe("self-hosted");
		expect(edition.license.state).toBe("none");
		expect(edition.capabilitySource).toBe("community");
		expect(edition.capabilities).toEqual([]);
		expect(edition.features).toEqual([]);
	});
});

describe("the edition report an extension package makes", () => {
	it("names the three licence states that grant, and the three that do not", () => {
		expect(
			(["none", "active", "expiring", "grace", "expired", "invalid"] satisfies LicenseState[]).map(
				(state) => [state, licenseStateGrants(state)],
			),
		).toEqual([
			["none", false],
			["active", true],
			["expiring", true],
			["grace", true],
			["expired", false],
			["invalid", false],
		]);
	});

	it("recognises the six state names and nothing else", () => {
		expect(["none", "active", "expiring", "grace", "expired", "invalid"].every(isLicenseState)).toBe(true);
		expect(["unknown", "", "ACTIVE", "licensed", null, undefined, true, 1].some(isLicenseState)).toBe(false);
	});

	it("finds the reporter member only when it is a function", () => {
		expect(hasEditionReporter({ instanceEdition: () => reportFor("none") })).toBe(true);
		expect(hasEditionReporter({ instanceEdition: reportFor("active") })).toBe(false);
		expect(hasEditionReporter({})).toBe(false);
		expect(hasEditionReporter(null)).toBe(false);
		expect(hasEditionReporter("instanceEdition")).toBe(false);
	});

	it("normalises instants and reads an absent optional field as null", () => {
		expect(
			parseEnterpriseEditionReport({
				license: { state: "active", subject: "Example GmbH", expiresAt: "2027-12-01T02:00:00+02:00" },
				capabilities: ["sso"],
				features: [{ id: "scim", built: false, authPlugins: () => [] }],
			}),
		).toEqual({
			license: {
				state: "active",
				subject: "Example GmbH",
				tier: null,
				expiresAt: "2027-12-01T00:00:00.000Z",
				graceEndsAt: null,
			},
			capabilities: ["sso"],
			features: [{ id: "scim", built: false }],
		});
	});

	it("returns null for a value that is not a report", () => {
		expect(parseEnterpriseEditionReport(undefined)).toBeNull();
		expect(parseEnterpriseEditionReport([])).toBeNull();
		expect(parseEnterpriseEditionReport({ license: null, capabilities: [], features: [] })).toBeNull();
	});
});
