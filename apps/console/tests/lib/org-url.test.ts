// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { orgHost, orgUrl, slugify } from "@/lib/org-url";

const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL;
afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
	else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
});

describe("orgHost", () => {
	it("derives the bare host from NEXT_PUBLIC_APP_URL", () => {
		process.env.NEXT_PUBLIC_APP_URL = "https://app.alethialabs.io";
		expect(orgHost()).toBe("app.alethialabs.io");
	});

	it("keeps the port for a localhost origin", () => {
		process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
		expect(orgHost()).toBe("localhost:3000");
	});

	it("falls back to the canonical brand host when unset", () => {
		delete process.env.NEXT_PUBLIC_APP_URL;
		expect(orgHost()).toBe("alethialabs.io");
	});
});

describe("orgUrl", () => {
	it("joins the host and slug", () => {
		process.env.NEXT_PUBLIC_APP_URL = "https://alethialabs.io";
		expect(orgUrl("acme")).toBe("alethialabs.io/acme");
	});
});

describe("slugify", () => {
	it("normalizes a free-text name to a slug", () => {
		expect(slugify("  My Cool Team! ")).toBe("my-cool-team");
	});
});
