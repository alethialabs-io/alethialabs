// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The account menu's version line (#6948): the console names its commercial stage, the platform
// release, and the short SHA of the running build, which is NEXT_PUBLIC_APP_VERSION (the deploy
// commit the image's runner stage sets). A value that is neither a commit nor a version tag is not
// printed. The stage is `RELEASE_STAGE` from `@repo/legal/launch` (EA-4, #7326), so every assertion
// below reads the constant rather than repeating the words.

import { RELEASE_STAGE } from "@repo/legal/launch";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runtimeEnv } = vi.hoisted(() => ({
	runtimeEnv: { current: new Map<string, string>() },
}));

vi.mock("next-runtime-env", () => ({
	env: (key: string) => runtimeEnv.current.get(key),
}));

const { PLATFORM_RELEASE, VersionLabel, versionFacts } = await import(
	"@/components/shell/version-label"
);

const FULL_SHA = "703d40d946914ab0dafdb4ed643a2c2437fa7def";

describe("versionFacts", () => {
	it("names the shared stage and the platform release", () => {
		const facts = versionFacts(undefined);
		expect(facts.stage).toBe(RELEASE_STAGE);
		expect(facts.release).toBe("2027.01-beta");
		expect(PLATFORM_RELEASE).toBe("2027.01-beta");
	});

	it("does not declare a stage name of its own", async () => {
		const label = await import("@/components/shell/version-label");
		expect(Object.keys(label)).not.toContain("RELEASE_STAGE");
	});

	it("shortens a commit SHA to seven characters and keeps the full one", () => {
		expect(versionFacts(FULL_SHA)).toEqual({
			stage: RELEASE_STAGE,
			release: "2027.01-beta",
			build: "703d40d",
			commit: FULL_SHA,
		});
	});

	it("lower-cases an upper-case SHA", () => {
		expect(versionFacts(FULL_SHA.toUpperCase()).build).toBe("703d40d");
	});

	it("shows a version tag or a build word as it is", () => {
		expect(versionFacts("v0.6.2").build).toBe("v0.6.2");
		expect(versionFacts("dev").build).toBe("dev");
		expect(versionFacts("v0.6.2").commit).toBeNull();
	});

	it("shows no build when the value is absent, empty or blank", () => {
		expect(versionFacts(undefined).build).toBeNull();
		expect(versionFacts("").build).toBeNull();
		expect(versionFacts("   ").build).toBeNull();
	});

	it("never prints a value that is not a commit or a version tag", () => {
		const shown = [
			"https://internal.example:8443/build",
			"build 42",
			"a/b",
			"x".repeat(80),
			"<script>",
		].filter((value) => versionFacts(value).build !== null);
		expect(shown).toEqual([]);
	});
});

describe("VersionLabel", () => {
	beforeEach(() => {
		runtimeEnv.current = new Map();
	});

	it("renders the stage, the release name and the short SHA of the running build", () => {
		runtimeEnv.current.set("NEXT_PUBLIC_APP_VERSION", FULL_SHA);
		render(<VersionLabel />);
		const line = screen.getByText(RELEASE_STAGE).closest("p");
		expect(line).not.toBeNull();
		expect(line?.textContent).toBe(`${RELEASE_STAGE}·2027.01-beta·build 703d40d`);
		expect(line?.getAttribute("title")).toBe(FULL_SHA);
	});

	it("renders the stage and release without a build when none is known", () => {
		render(<VersionLabel />);
		const line = screen.getByText(RELEASE_STAGE).closest("p");
		expect(line?.textContent).toBe(`${RELEASE_STAGE}·2027.01-beta`);
		expect(line?.hasAttribute("title")).toBe(false);
	});

	it("is not interactive", () => {
		runtimeEnv.current.set("NEXT_PUBLIC_APP_VERSION", FULL_SHA);
		render(<VersionLabel />);
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
	});
});
