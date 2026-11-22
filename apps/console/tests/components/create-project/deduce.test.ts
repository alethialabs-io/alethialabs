// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6843: what the one-screen create works out before the person types anything. Each default is
// tested against the data that decides it, and each says where it came from.

import { describe, expect, it } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import {
	type AccountOption,
	cloudAccounts,
	deduceName,
	deduceProvider,
	deduceRegion,
	pickAccount,
	regionGroupForTimeZone,
	repoName,
} from "@/components/create-project/deduce";
import { DEFAULT_REGION } from "@/lib/cloud-providers";

const OFFERED = ["aws", "gcp", "azure", "hetzner"] as const;

/** A cloud connector with the given accounts. */
function cloud(
	slug: string,
	accounts: { identityId: string; status: "connected" | "degraded" | "testing" | "failed" }[],
): Pick<ConnectorWithConnection, "slug" | "name" | "category" | "connected" | "accounts"> {
	return {
		slug,
		name: slug.toUpperCase(),
		category: "cloud",
		connected: accounts.length > 0,
		accounts: accounts.map((a) => ({ ...a, name: `${slug} ${a.identityId}` })),
	};
}

describe("cloudAccounts", () => {
	it("lists accounts on offered clouds and names a connected cloud that is not offered", () => {
		const { accounts, unoffered } = cloudAccounts(
			[
				cloud("aws", [
					{ identityId: "a1", status: "failed" },
					{ identityId: "a2", status: "connected" },
				]),
				cloud("alibaba", [{ identityId: "x1", status: "connected" }]),
				cloud("hetzner", [{ identityId: "h1", status: "degraded" }]),
			],
			[...OFFERED],
		);
		expect(accounts.map((a) => [a.identityId, a.provider, a.usable])).toEqual([
			["a1", "aws", false],
			["a2", "aws", true],
			["h1", "hetzner", true],
		]);
		expect(unoffered.map((c) => c.slug)).toEqual(["alibaba"]);
	});
});

const ACCOUNTS: AccountOption[] = [
	{ identityId: "a1", provider: "aws", name: "broken", label: null, usable: false },
	{ identityId: "h1", provider: "hetzner", name: "hz", label: null, usable: true },
];

describe("pickAccount", () => {
	it("picks the first usable account on the cloud, never a broken one", () => {
		expect(pickAccount("hetzner", ACCOUNTS)).toBe("h1");
		expect(pickAccount("aws", ACCOUNTS)).toBe("");
	});
});

describe("deduceProvider", () => {
	it("prefers the scan, then a usable account, then the org's projects, then the first offered", () => {
		const base = { offered: [...OFFERED], accounts: [], projects: [] };
		expect(deduceProvider({ ...base, scanProvider: "gcp" })).toEqual({ provider: "gcp", reason: "scan" });
		expect(deduceProvider({ ...base, scanProvider: null, accounts: ACCOUNTS })).toEqual({
			provider: "hetzner",
			reason: "account",
		});
		expect(
			deduceProvider({
				...base,
				scanProvider: null,
				projects: [
					{ project_name: "a", region: "westeurope", cloud_provider: "azure" },
					{ project_name: "b", region: "westeurope", cloud_provider: "azure" },
					{ project_name: "c", region: "eu-west-1", cloud_provider: "aws" },
				],
			}),
		).toEqual({ provider: "azure", reason: "projects" });
		expect(deduceProvider({ ...base, scanProvider: null })).toEqual({ provider: "aws", reason: "default" });
	});

	it("never deduces a cloud that is not offered", () => {
		expect(
			deduceProvider({ offered: ["gcp"], scanProvider: "alibaba", accounts: ACCOUNTS, projects: [] }),
		).toEqual({ provider: "gcp", reason: "default" });
	});
});

describe("regionGroupForTimeZone", () => {
	it("places the common zones and refuses the ones that say nothing", () => {
		expect(regionGroupForTimeZone("Europe/Sofia")).toBe("Europe");
		expect(regionGroupForTimeZone("America/New_York")).toBe("United States");
		expect(regionGroupForTimeZone("America/Argentina/Buenos_Aires")).toBe("South America");
		expect(regionGroupForTimeZone("Asia/Tokyo")).toBe("Asia Pacific");
		expect(regionGroupForTimeZone("Australia/Sydney")).toBe("Asia Pacific");
		expect(regionGroupForTimeZone("UTC")).toBeNull();
		expect(regionGroupForTimeZone("")).toBeNull();
	});
});

describe("deduceRegion", () => {
	it("uses the scan's region when the cloud has it", () => {
		expect(deduceRegion({ provider: "aws", scanRegion: "us-west-2", projects: [], timeZone: "" })).toEqual({
			region: "us-west-2",
			reason: "scan",
		});
	});

	it("uses where the org's projects on that cloud run, ignoring other clouds", () => {
		const projects = [
			{ project_name: "a", region: "nbg1", cloud_provider: "hetzner" },
			{ project_name: "b", region: "eu-north-1", cloud_provider: "aws" },
		];
		expect(deduceRegion({ provider: "hetzner", scanRegion: null, projects, timeZone: "Asia/Tokyo" })).toEqual({
			region: "nbg1",
			reason: "projects",
		});
	});

	it("picks the cloud's region nearest the time zone, preferring its default inside the group", () => {
		expect(deduceRegion({ provider: "aws", scanRegion: null, projects: [], timeZone: "Europe/Berlin" })).toEqual({
			region: DEFAULT_REGION.aws,
			reason: "location",
		});
		const us = deduceRegion({ provider: "hetzner", scanRegion: null, projects: [], timeZone: "America/Chicago" });
		expect(us.reason).toBe("location");
		expect(["ash", "hil"]).toContain(us.region);
	});

	it("falls back to the cloud's default when nothing else says", () => {
		expect(deduceRegion({ provider: "gcp", scanRegion: "nowhere-1", projects: [], timeZone: "UTC" })).toEqual({
			region: DEFAULT_REGION.gcp,
			reason: "default",
		});
	});
});

describe("deduceName", () => {
	it("names a first project my-first-project and a later one my-project", () => {
		expect(deduceName({ scanName: null, repoUrl: null, existingNames: [] })).toBe("my-first-project");
		expect(deduceName({ scanName: null, repoUrl: null, existingNames: ["prod"] })).toBe("my-project");
	});

	it("takes the scan's name, then the repository's, made free against the org's names", () => {
		expect(deduceName({ scanName: "Shop API", repoUrl: null, existingNames: [] })).toBe("Shop API");
		expect(
			deduceName({ scanName: null, repoUrl: "https://github.com/acme/api.git", existingNames: ["API"] }),
		).toBe("api 2");
	});

	it("reads a repository name off its URL", () => {
		expect(repoName("https://github.com/acme/web/")).toBe("web");
		expect(repoName("")).toBeNull();
	});
});
