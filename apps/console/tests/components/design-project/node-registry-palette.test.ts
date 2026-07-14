// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shape guard for the registry-driven Add palette: every ADDABLE kind must carry palette
// presentation metadata (group + subtitle), every group must be a known PALETTE_GROUP_ORDER
// heading (roadmap rows included), and addableKindsFor must drop the kinds a provider can't
// back — so all three Add entry points (palette, ⌘K, controls) stay in lockstep.

import { describe, expect, it } from "vitest";
import {
	ADDABLE_KINDS,
	addableKindsFor,
	NODE_REGISTRY,
	PALETTE_GROUP_ORDER,
	ROADMAP_ITEMS,
	UNSUPPORTED_KINDS_BY_PROVIDER,
} from "@/components/design-project/canvas/graph/node-registry";
import {
	UNSUPPORTED_KINDS_BY_PROVIDER as SERVER_UNSUPPORTED_KINDS_BY_PROVIDER,
	unsupportedKindsFor,
} from "@/lib/cloud-providers/unsupported-kinds";

describe("NODE_REGISTRY palette metadata", () => {
	it("every addable kind has palette metadata in a known group with a subtitle", () => {
		for (const kind of ADDABLE_KINDS) {
			const palette = NODE_REGISTRY[kind].palette;
			expect(palette, `${kind} is missing palette metadata`).toBeDefined();
			expect(
				PALETTE_GROUP_ORDER,
				`${kind} declares an unknown palette group`,
			).toContain(palette?.group);
			expect(
				palette?.subtitle,
				`${kind} is missing a palette subtitle`,
			).toBeTruthy();
		}
	});

	it("roadmap items live in known groups and are marked coming-soon", () => {
		expect(ROADMAP_ITEMS.length).toBeGreaterThan(0);
		for (const item of ROADMAP_ITEMS) {
			expect(PALETTE_GROUP_ORDER).toContain(item.group);
			expect(item.comingSoon).toBe(true);
			expect(item.subtitle).toBeTruthy();
		}
	});

	it("addableKindsFor drops the kinds Hetzner can't back and passes AWS through", () => {
		const hetzner = addableKindsFor("hetzner");
		expect(hetzner).not.toContain("topic");
		expect(hetzner).not.toContain("nosql");
		// No native container registry on Hetzner yet (Harbor add-on covers it in-cluster).
		expect(hetzner).not.toContain("registry");
		// Bucket is NATIVE on Hetzner (Object Storage via the aminueza/minio provider).
		expect(hetzner).toContain("bucket");
		expect(hetzner).toContain("database");
		expect(hetzner).toContain("queue");

		expect(addableKindsFor("aws")).toEqual(ADDABLE_KINDS);
		expect(addableKindsFor(null)).toEqual(ADDABLE_KINDS);
	});

	it("bucket and registry are addable kinds; volume stays the only roadmap row", () => {
		expect(ADDABLE_KINDS).toContain("bucket");
		expect(ADDABLE_KINDS).toContain("registry");
		expect(ROADMAP_ITEMS.map((i) => i.id)).toEqual(["volume"]);
	});

	it("re-exports the SAME UNSUPPORTED_KINDS_BY_PROVIDER as the server-safe source (one SSOT)", () => {
		// node-registry re-exports the extracted server-safe module, so the palette and the
		// deploy-time guard (buildConfigSnapshot) can never diverge on what a cloud can't back.
		expect(UNSUPPORTED_KINDS_BY_PROVIDER).toBe(SERVER_UNSUPPORTED_KINDS_BY_PROVIDER);
		// bucket is NATIVE on Hetzner (Object Storage via the minio provider) and
		// database/cache/queue run as in-cluster charts (hetzner-services.ts), so those stay
		// addable. topic/nosql/registry have no path — and `secret` is blocked too: Hetzner has
		// no cloud secret store and ProviderTfvars never emits `custom_secrets`, so before the
		// gate the component was silently dropped while the deploy reported SUCCESS.
		expect(unsupportedKindsFor("hetzner")).toEqual([
			"topic",
			"nosql",
			"registry",
			"secret",
		]);
		// A cloud with no blocked kinds (and an unknown/out-of-design slug) → empty.
		expect(unsupportedKindsFor("aws")).toEqual([]);
		expect(unsupportedKindsFor("digitalocean")).toEqual([]);
		expect(unsupportedKindsFor(null)).toEqual([]);
	});
});
