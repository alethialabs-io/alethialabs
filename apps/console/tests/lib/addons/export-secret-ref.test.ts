// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #2835: the e2e fixture is `exportCatalogSpecs` resolved with NO stored values, so an add-on that
// mints its own secret at enable time (#2822) exported no `secretRef` at all. The runner's
// `EnsureAddOnSecrets` skips an add-on with no ref, so the chart fell back to generating its own
// credential at RENDER time — different on every reconcile, permanently OutOfSync.
//
// The export now resolves those add-ons as if their secrets were stored. The thing that makes this
// safe is that a `secretRef` carries NAMES only, so these tests are mostly about proving no value
// ever escapes.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ADDON_CATALOG } from "@/lib/addons/catalog";
import { exportCatalogSpecs } from "@/lib/addons/catalog-export";

const FIXTURE = resolve(
	__dirname,
	"../../../../../test/e2e/fixtures/addon_catalog.json",
);

/** Add-ons that mint a secret at enable time, read from the catalog rather than restated here. */
const MINTING = ADDON_CATALOG.filter((d) => d.generateSecrets).map((d) => d.id);

describe("exported specs carry a secretRef for minting add-ons (#2835)", () => {
	it("there is at least one minting add-on, so these tests are not vacuous", () => {
		// Without this the whole suite passes trivially the day `generateSecrets` is removed.
		expect(MINTING.length).toBeGreaterThan(0);
		expect(MINTING).toContain("minio");
	});

	it.each(MINTING)("%s exports a secretRef with its minted keys", (id) => {
		const spec = exportCatalogSpecs().find((s) => s.id === id);
		expect(spec, `${id} missing from the export`).toBeDefined();
		expect(spec?.secretRef).toBeDefined();
		expect(spec?.secretRef?.keys.length).toBeGreaterThan(0);
		expect(spec?.secretRef?.secretName).toBe(`alethia-addon-${id}`);
		expect(spec?.secretRef?.namespace).toBe(spec?.namespace);
	});

	it("minio's chart is wired at the Secret rather than left to generate its own", () => {
		// The actual defect: with no existingSecret the chart mints rootUser/rootPassword per render.
		const minio = exportCatalogSpecs().find((s) => s.id === "minio");
		expect(minio?.values.existingSecret).toBe("alethia-addon-minio");
		expect(minio?.secretRef?.keys).toEqual(["rootPassword"]);
		// The username is NOT a secret and pairs in through staticData.
		expect(minio?.secretRef?.staticData).toEqual({ rootUser: "admin" });
	});

	it("an add-on that mints nothing still exports no secretRef", () => {
		// The narrowing that keeps this change from handing every add-on a Secret it never asked for.
		const reloader = exportCatalogSpecs().find((s) => s.id === "reloader");
		expect(reloader?.secretRef).toBeUndefined();
	});

	it("NO secret value, and no presence marker, reaches the exported specs", () => {
		// The whole safety argument in one assertion. `resolveAddOnInstall` strips secret knobs
		// before validation, so the marker used to signal presence must not survive into the output
		// — nor may anything that looks like a credential.
		const json = JSON.stringify(exportCatalogSpecs());
		expect(json).not.toContain("e2e-fixture-presence-marker");
	});

	it("the COMMITTED fixture matches, and carries no marker either", () => {
		// The generated file is what the harness actually seeds. A drifted or marker-bearing fixture
		// is the thing that would reach a repository, so it is asserted directly rather than
		// inferred from the exporter.
		const onDisk = readFileSync(FIXTURE, "utf8");
		expect(onDisk).not.toContain("e2e-fixture-presence-marker");
		expect(JSON.parse(onDisk)).toEqual(exportCatalogSpecs());
	});
});
