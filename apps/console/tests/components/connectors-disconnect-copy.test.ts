// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the disconnect confirmation says and how much it asks (#6816). Disconnecting a cloud
// account that projects use is destroy-class: the projects are named and the account's name is
// typed. An answer that is not known is treated as the worse case, never as "no projects".

import { describe, expect, it, vi } from "vitest";

// The dialog module reads `orpc` for the projects query; the copy functions under test do not.
vi.mock("@/lib/rpc/client", () => ({ orpc: {} }));

import {
	NAMED_PROJECTS_MAX,
	cloudDisconnectCopy,
	connectorDisconnectCopy,
} from "@/components/connectors/connectors-disconnect-dialog";

describe("cloudDisconnectCopy", () => {
	it("is a plain confirmation that says so when no project uses the account", () => {
		const copy = cloudDisconnectCopy("Prod AWS", { kind: "none" });
		expect(copy.severity).toEqual({ level: "confirm" });
		expect(copy.description).toContain("cloud account Prod AWS");
		expect(copy.description).toContain("No project uses it.");
		expect(copy.description).toContain("not changed or deleted");
	});

	it("is destroy-class, names each project and asks for the account's name when projects use it", () => {
		const copy = cloudDisconnectCopy("Prod AWS", { kind: "some", names: ["shop", "billing"] });
		expect(copy.description).toContain("2 projects use it");
		if (copy.severity.level !== "destroy") throw new Error("expected a destroy-class confirmation");
		expect(copy.severity.subject).toBe("Prod AWS");
		expect(copy.severity.consequences.filter((line) => /shop|billing/.test(line))).toHaveLength(2);
		expect(copy.severity.consequences.at(-1)).toContain("not changed or deleted");
	});

	it("says 1 project, in the singular", () => {
		const copy = cloudDisconnectCopy("Prod AWS", { kind: "some", names: ["shop"] });
		expect(copy.description).toContain("1 project uses it and is left without a cloud account");
	});

	it("names the first projects and counts the rest", () => {
		const names = Array.from({ length: NAMED_PROJECTS_MAX + 3 }, (_, i) => `project-${i}`);
		const copy = cloudDisconnectCopy("Prod AWS", { kind: "some", names });
		if (copy.severity.level !== "destroy") throw new Error("expected a destroy-class confirmation");
		expect(copy.severity.consequences.filter((line) => line.includes("project-"))).toHaveLength(NAMED_PROJECTS_MAX);
		expect(copy.severity.consequences).toContain("And 3 more projects.");
	});

	it("keeps every line distinct when two projects share a name", () => {
		const copy = cloudDisconnectCopy("Prod AWS", { kind: "some", names: ["shop", "shop"] });
		if (copy.severity.level !== "destroy") throw new Error("expected a destroy-class confirmation");
		expect(new Set(copy.severity.consequences).size).toBe(copy.severity.consequences.length);
	});

	it("is destroy-class and says the check could not be made when the answer is not known", () => {
		const copy = cloudDisconnectCopy("Prod AWS", { kind: "unknown" });
		if (copy.severity.level !== "destroy") throw new Error("expected a destroy-class confirmation");
		expect(copy.severity.subject).toBe("Prod AWS");
		expect(copy.severity.consequences[0]).toContain("could not check which projects use this cloud account");
		expect(copy.description).not.toContain("No project uses it");
	});
});

describe("connectorDisconnectCopy", () => {
	it("is a plain confirmation for a git link and for a stored credential, each in its own words", () => {
		const git = connectorDisconnectCopy({ category: "git", name: "GitHub" });
		const key = connectorDisconnectCopy({ category: "observability", name: "Datadog" });
		expect(git.severity).toEqual({ level: "confirm" });
		expect(key.severity).toEqual({ level: "confirm" });
		expect(git.description).toContain("unlinks your GitHub account");
		expect(key.description).toContain("stored credential for the whole organization");
	});
});
