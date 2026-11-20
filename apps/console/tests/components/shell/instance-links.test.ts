// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where the shell's outbound links point, by instance edition (#6924).
//
// The account menu linked every instance to the hosted service's status page and, on a
// self-managed instance, to the hosted marketing site as its "Home page". A self-managed instance
// now gets the address its operator configured, or no link.

import { describe, expect, it } from "vitest";
import { type ConfiguredLinks, resolveInstanceLinks } from "@/components/shell/instance-links";
import type { ShellEdition } from "@/components/shell/shell-edition";

const HOSTED: ShellEdition = { deployment: "hosted", edition: "enterprise", offering: "hosted" };
const SELF_HOSTED: ShellEdition = {
	deployment: "self-managed",
	edition: "community",
	offering: "self-hosted",
};
const ENTERPRISE: ShellEdition = {
	deployment: "self-managed",
	edition: "enterprise",
	offering: "enterprise",
};

/** A deployment that configured nothing: only the hosted service's own defaults are present. */
const NOTHING_CONFIGURED: ConfiguredLinks = {
	statusUrl: undefined,
	legalBase: undefined,
	issuesUrl: undefined,
	hostedStatusUrl: "https://status.alethialabs.io",
	hostedSourceUrl: "https://alethialabs.io/legal/source",
};

/** Every address in a set of links, for asking "is the hosted site anywhere in here". */
function addressesOf(links: ReturnType<typeof resolveInstanceLinks>): string[] {
	const report = links.report.kind === "issues" ? [links.report.href] : [];
	return [links.status, links.home, links.releaseNotes, links.source, ...report].filter(
		(href): href is string => href !== null,
	);
}

describe("resolveInstanceLinks — the hosted service", () => {
	it("links its status page, its home page and its source page, and takes reports in the app", () => {
		expect(resolveInstanceLinks(HOSTED, NOTHING_CONFIGURED)).toEqual({
			status: "https://status.alethialabs.io",
			home: "/home",
			releaseNotes: "https://github.com/alethialabs-io/alethialabs/releases",
			source: "https://alethialabs.io/legal/source",
			report: { kind: "feedback" },
		});
	});

	it("has no status link when the status page was turned off", () => {
		const links = resolveInstanceLinks(HOSTED, { ...NOTHING_CONFIGURED, hostedStatusUrl: null });
		expect(links.status).toBeNull();
	});
});

/** Every edition that is not the hosted service, including one that is not known. */
const NOT_HOSTED: Array<[string, ShellEdition | null]> = [
	["a self-hosted instance", SELF_HOSTED],
	["a licensed enterprise instance", ENTERPRISE],
	["an edition that is not known", null],
];

describe.each(NOT_HOSTED)("resolveInstanceLinks — %s", (_name, edition) => {
	it("with nothing configured, links no status page and no home page, and no hosted address at all", () => {
		const links = resolveInstanceLinks(edition, NOTHING_CONFIGURED);
		expect(links.status).toBeNull();
		expect(links.home).toBeNull();
		expect(links.report).toEqual({
			kind: "issues",
			href: "https://github.com/alethialabs-io/alethialabs/issues/new",
		});
		expect(links.source).toBe("https://github.com/alethialabs-io/alethialabs");
		expect(addressesOf(links).filter((href) => href.includes("alethialabs.io"))).toEqual([]);
	});

	it("links the operator's own status page, pages and tracker when they are configured", () => {
		const links = resolveInstanceLinks(edition, {
			...NOTHING_CONFIGURED,
			statusUrl: "https://status.example.test",
			legalBase: "https://www.example.test",
			issuesUrl: "https://tracker.example.test/new",
		});
		expect(links.status).toBe("https://status.example.test");
		expect(links.home).toBe("https://www.example.test/");
		expect(links.source).toBe("https://www.example.test/legal/source");
		expect(links.report).toEqual({ kind: "issues", href: "https://tracker.example.test/new" });
	});

	it("reads an empty status address as no status page, and an empty base as this origin", () => {
		const links = resolveInstanceLinks(edition, {
			...NOTHING_CONFIGURED,
			statusUrl: "",
			legalBase: "",
			issuesUrl: "",
		});
		expect(links.status).toBeNull();
		expect(links.home).toBe("/");
		expect(links.source).toBe("/legal/source");
		expect(links.report).toEqual({
			kind: "issues",
			href: "https://github.com/alethialabs-io/alethialabs/issues/new",
		});
	});

	it("never takes reports through the in-app dialog, which writes to Alethia Labs", () => {
		expect(resolveInstanceLinks(edition, NOTHING_CONFIGURED).report.kind).toBe("issues");
	});
});
