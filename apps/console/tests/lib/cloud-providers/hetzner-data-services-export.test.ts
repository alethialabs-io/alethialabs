// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Go e2e harness seeds Hetzner's three in-cluster data services (CloudNativePG / Valkey /
// RabbitMQ) from a GENERATED fixture — `test/e2e/fixtures/hetzner_data_services.json`, produced by
// `pnpm -F console export:hetzner-data-services` from hetzner-services.ts via the real
// `hetznerDataServicesToAddOns`.
//
// This guard is what makes that safe, and it is the sibling of catalog-export.test.ts. The mapper is
// the SSOT for chart coordinates, namespaces, sync-waves, the CNPG CRD gate and two value schemas
// that have each broken in production once (bitnami/valkey deleted from the index; bitnami/rabbitmq's
// image 404). A fixture that silently went stale would have a Hetzner full-bar nightly install
// YESTERDAY's charts against a real cloud and still report green. So: regenerate in-memory and
// compare. A chart bump that forgets the regeneration reds CI here — cheaply — instead of on a
// real-apply nightly a week later.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { exportHetznerDataServiceFixture } from "@/lib/cloud-providers/hetzner-services-export";

const FIXTURE = resolve(
	__dirname,
	"../../../../../test/e2e/fixtures/hetzner_data_services.json",
);

describe("hetzner data-service export fixture (e2e max-config in-cluster seed)", () => {
	it("is current with hetzner-services.ts — regenerate with `pnpm -F console export:hetzner-data-services`", () => {
		const onDisk = JSON.parse(readFileSync(FIXTURE, "utf8"));
		const live = JSON.parse(JSON.stringify(exportHetznerDataServiceFixture()));
		expect(onDisk).toEqual(live);
	});

	it("carries one Application per component plus the CNPG operator", () => {
		const fixture = exportHetznerDataServiceFixture();
		const ids = fixture.addons.map((a) => a.id);
		// The per-component ids are what the Go table's ArgoApp names ("addon-" + id) are derived
		// from; the operator is the CRD gate the database's Cluster CR needs at sync-wave 0.
		expect(ids).toContain("cnpg-operator");
		for (const db of fixture.components.databases) {
			expect(ids).toContain(`db-${db.name}`);
		}
		for (const cache of fixture.components.caches) {
			expect(ids).toContain(`cache-${cache.name}`);
		}
		for (const queue of fixture.components.queues) {
			expect(ids).toContain(`queue-${queue.name}`);
		}
	});

	it("pins a fetchable chart for every spec (the bitnami rot class)", () => {
		for (const spec of exportHetznerDataServiceFixture().addons) {
			// bitnami-labs.github.io was renamed → its index 404s, and Broadcom relocated
			// docker.io/bitnami/* to bitnamilegacy/*. Both are how a Hetzner data service ships a
			// chart ArgoCD cannot even fetch — valkey and rabbitmq have each been there.
			expect(spec.chartRepo).not.toContain("bitnami");
			expect(spec.chartRepo).toMatch(/^https:\/\//);
			expect(spec.chart).not.toBe("");
			expect(spec.version).not.toBe("");
			expect(spec.namespace).not.toBe("");
		}
	});
});
