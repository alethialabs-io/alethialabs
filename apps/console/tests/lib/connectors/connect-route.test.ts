// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { connectRoute } from "@/lib/connectors/helpers";

describe("connectRoute", () => {
	// The bug: the token clouds are `category: "cloud"` but `auth_method: "api_key"` (the enum has no
	// `token` value). Routing on auth_method first sent them to the pluggable sheet, which has no entry
	// for them and rendered an empty panel. Category must win.
	it.each(["hetzner", "civo", "digitalocean"])(
		"routes the token cloud %s to the cloud flow despite auth_method=api_key",
		(slug) => {
			expect(
				connectRoute({ category: "cloud", auth_method: "api_key" }),
			).toBe("cloud");
			// (slug is illustrative — connectRoute keys off category/auth_method, not the slug.)
			void slug;
		},
	);

	it.each([
		["aws", "iam_role"],
		["gcp", "service_account"],
		["azure", "service_principal"],
		["alibaba", "ram_role"],
	] as const)("routes the keyless cloud %s to the cloud flow", (_slug, auth) => {
		expect(connectRoute({ category: "cloud", auth_method: auth })).toBe("cloud");
	});

	it("routes a non-cloud api_key connector (vault) to the pluggable flow", () => {
		expect(
			connectRoute({ category: "secrets", auth_method: "api_key" }),
		).toBe("api_key");
	});

	it("routes a git connector to the git flow", () => {
		expect(connectRoute({ category: "git", auth_method: "oauth" })).toBe("git");
	});
});
