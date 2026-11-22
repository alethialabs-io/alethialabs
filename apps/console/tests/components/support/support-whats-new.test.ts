// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #7148: the support hub's "Platform status" chip used to hard-code https://status.alethialabs.io, a
// host with no DNS record, and a self-hosted console linked it too. It now follows `statusUrl()` (the
// configured NEXT_PUBLIC_STATUS_URL), and with nothing configured the chip is omitted — never a dead link.

import { describe, expect, it } from "vitest";
import { whatsNewLinks } from "@/components/support/support-whats-new";

describe("whatsNewLinks", () => {
	it("links the configured status page, opening it in a new tab", () => {
		const status = whatsNewLinks("https://status.example.test").find((l) => l.label === "Platform status");
		expect(status).toMatchObject({ href: "https://status.example.test", external: true });
	});

	it("omits the status chip when no status URL is configured", () => {
		const links = whatsNewLinks(null);
		expect(links.map((l) => l.label)).toEqual(["News", "Documentation"]);
	});

	it("never hard-codes a status host", () => {
		for (const link of whatsNewLinks(null)) expect(link.href).not.toContain("status.");
	});
});
