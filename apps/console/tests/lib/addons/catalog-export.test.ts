// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Go e2e harness seeds the FULL add-on surface (all 19 charts) from a GENERATED fixture —
// `test/e2e/fixtures/addon_catalog.<cloud>.json`, produced by `pnpm -F console export:addon-catalog` from
// catalog.ts via the real `resolveAddOnInstall`.
//
// This guard is what makes that safe. catalog.ts is the SSOT for chart coordinates; a fixture that
// silently goes stale would have the nightly install YESTERDAY's charts against a real cloud and
// still report green. So: regenerate in-memory and compare. A chart bump that forgets the
// regeneration reds CI here — cheaply — instead of on a real-apply nightly.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPORT_CLOUDS, exportCatalogSpecs } from "@/lib/addons/catalog-export";

const fixtureFor = (cloud: string) =>
	resolve(
		__dirname,
		`../../../../../test/e2e/fixtures/addon_catalog.${cloud}.json`,
	);

const readFixture = (cloud: string) =>
	JSON.parse(readFileSync(fixtureFor(cloud), "utf8"));

describe("add-on catalog export fixture (e2e full-surface seed)", () => {
	// Every cloud, every time. Looping matters more than it looks: a single-fixture guard would
	// have gone green over four stale files, which is the exact "silently stale generated artifact"
	// failure this test exists to prevent — reproduced once per cloud.
	it.each([...EXPORT_CLOUDS])(
		"%s is current with catalog.ts — regenerate with `pnpm -F console export:addon-catalog`",
		(cloud) => {
			const live = JSON.parse(JSON.stringify(exportCatalogSpecs(cloud)));
			expect(readFixture(cloud)).toEqual(live);
		},
	);

	it.each([...EXPORT_CLOUDS])(
		"%s carries every catalog add-on (the full surface, not a sample)",
		(cloud) => {
			// Mirrors the B0.3 SSOT count guard: the harness must exercise ALL of them.
			// 19 → 18: cert-manager moved to the PLATFORM rail, so it is no longer a marketplace
			// chart this fixture seeds — it ships from the deploy itself.
			expect(readFixture(cloud)).toHaveLength(18);
		},
	);

	it.each([...EXPORT_CLOUDS])(
		"%s pins no dead chart repo (the sealed-secrets rot class)",
		(cloud) => {
			const onDisk: { id: string; chartRepo: string }[] = readFixture(cloud);
			for (const spec of onDisk) {
				// bitnami-labs.github.io was renamed → its index 404s; the whole class of "the chart
				// can't even be fetched" is what broke sealed-secrets (fixed) and Hetzner's valkey.
				expect(spec.chartRepo).not.toContain("bitnami-labs.github.io");
				expect(spec.chartRepo).toMatch(/^https:\/\//);
			}
		},
	);

	// The point of making these per-cloud (#2717 class (c)). A fixture that still said `cloudflare`
	// on a cloud with its own DNS would install external-dns with no credential it can use, and the
	// add-on could never converge — so the cell would measure the fixture, not the chart.
	//
	// Asserted as "NOT cloudflare" plus a positive check on the two shapes the emitter produces,
	// rather than by restating the expected values: re-listing them here would be a second copy of
	// EXTERNAL_DNS_PROVIDERS, and the whole design keeps that map the only one.
	it.each([
		["aws", "aws"],
		["gcp", "google"],
		["azure", "azure"],
	] as const)("%s points external-dns at its own cloud DNS", (cloud, want) => {
		const spec = readFixture(cloud).find(
			(a: { id: string }) => a.id === "external-dns",
		);
		expect(spec.values.provider.name).toBe(want);
	});

	it("hetzner reaches its DNS through the webhook sidecar, not a native provider name", () => {
		const spec = readFixture("hetzner").find(
			(a: { id: string }) => a.id === "external-dns",
		);
		// The emitter derives this shape; a hand-written per-cloud override in the Go harness
		// would have produced `name: "hetzner"` and silently installed a controller with no
		// provider implementation behind it.
		expect(spec.values.provider.name).toBe("webhook");
		expect(spec.values.provider.webhook.image.repository).toContain(
			"external-dns-hetzner-webhook",
		);
	});

	it("alibaba keeps the catalog default, because the catalog offers it no native provider", () => {
		// Recorded, not fixed. EXTERNAL_DNS_PROVIDER_IDS has no alibaba entry, so there is nothing
		// native to point it at; this asserts the state is UNCHANGED from before the split rather
		// than pretending otherwise. If alibaba ever gains a provider id, this test fails and forces
		// the map to be revisited.
		const spec = readFixture("alibaba").find(
			(a: { id: string }) => a.id === "external-dns",
		);
		expect(spec.values.provider.name).toBe("cloudflare");
	});
});
