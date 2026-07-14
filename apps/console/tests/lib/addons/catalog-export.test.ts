// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Go e2e harness seeds the FULL add-on surface (all 19 charts) from a GENERATED fixture —
// `test/e2e/fixtures/addon_catalog.json`, produced by `pnpm -F console export:addon-catalog` from
// catalog.ts via the real `resolveAddOnInstall`.
//
// This guard is what makes that safe. catalog.ts is the SSOT for chart coordinates; a fixture that
// silently goes stale would have the nightly install YESTERDAY's charts against a real cloud and
// still report green. So: regenerate in-memory and compare. A chart bump that forgets the
// regeneration reds CI here — cheaply — instead of on a real-apply nightly.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { exportCatalogSpecs } from "@/scripts/export-addon-catalog.mts";

const FIXTURE = resolve(
	__dirname,
	"../../../../../test/e2e/fixtures/addon_catalog.json",
);

describe("add-on catalog export fixture (e2e full-surface seed)", () => {
	it("is current with catalog.ts — regenerate with `pnpm -F console export:addon-catalog`", () => {
		const onDisk = JSON.parse(readFileSync(FIXTURE, "utf8"));
		const live = JSON.parse(JSON.stringify(exportCatalogSpecs()));
		expect(onDisk).toEqual(live);
	});

	it("carries every catalog add-on (the full surface, not a sample)", () => {
		const onDisk = JSON.parse(readFileSync(FIXTURE, "utf8"));
		// Mirrors the B0.3 SSOT count guard: the harness must exercise ALL of them.
		expect(onDisk).toHaveLength(19);
	});

	it("pins no dead chart repo (the sealed-secrets rot class)", () => {
		const onDisk: { id: string; chartRepo: string }[] = JSON.parse(
			readFileSync(FIXTURE, "utf8"),
		);
		for (const spec of onDisk) {
			// bitnami-labs.github.io was renamed → its index 404s; the whole class of "the chart
			// can't even be fetched" is what broke sealed-secrets (fixed) and Hetzner's valkey.
			expect(spec.chartRepo).not.toContain("bitnami-labs.github.io");
			expect(spec.chartRepo).toMatch(/^https:\/\//);
		}
	});
});
