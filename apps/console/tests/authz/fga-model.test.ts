// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { buildAuthorizationModel } from "@/lib/authz/fga-model";
import { isOrgLevel, toCheck } from "@/lib/authz/fga-mapping";
import { PERMISSIONS } from "@/lib/authz/registry";

const model = buildAuthorizationModel();
const byType = new Map(model.type_definitions.map((t) => [t.type, t]));

describe("OpenFGA model generation", () => {
	it("declares the core principal + grouping types", () => {
		expect(byType.has("user")).toBe(true);
		expect(byType.has("team")).toBe(true);
		expect(byType.get("team")?.relations.member).toBeDefined();
		expect(byType.has("org")).toBe(true);
	});

	it("covers EVERY registry permission key org-wide (a capability on org)", () => {
		for (const p of PERMISSIONS) {
			const rel = `${p.resource}_${p.action}`;
			expect(
				byType.get("org")?.relations[rel],
				`org is missing org-wide capability ${rel} for ${p.key}`,
			).toBeDefined();
		}
	});

	it("covers every per-instance permission key on its instance type (perm_ + can_)", () => {
		for (const p of PERMISSIONS) {
			if (isOrgLevel(p.resource, p.action)) continue; // org-level/create → org only
			const def = byType.get(p.resource);
			expect(def, `missing instance type ${p.resource}`).toBeDefined();
			expect(
				def?.relations[`perm_${p.action}`],
				`${p.resource} missing perm_${p.action}`,
			).toBeDefined();
			expect(
				def?.relations[`can_${p.action}`],
				`${p.resource} missing can_${p.action}`,
			).toBeDefined();
		}
	});

	it("resolves every key via toCheck to a relation that exists on the model", () => {
		for (const p of PERMISSIONS) {
			// per-instance actions are asked with a concrete id; org-level without one.
			const id = isOrgLevel(p.resource, p.action) ? undefined : "11111111-1111-4111-8111-111111111111";
			const { object, relation } = toCheck(p.resource, p.action, { id, orgId: "o" });
			const objectType = object.split(":")[0];
			expect(
				byType.get(objectType)?.relations[relation],
				`toCheck(${p.key}) → ${objectType}#${relation} not in model`,
			).toBeDefined();
		}
	});

	it("gives instance types a parent relation for inheritance", () => {
		for (const r of ["project", "runner", "cloud_identity", "connector"]) {
			expect(byType.get(r)?.relations.parent, `${r} missing parent`).toBeDefined();
		}
	});

	it("has unique type names", () => {
		const names = model.type_definitions.map((t) => t.type);
		expect(new Set(names).size).toBe(names.length);
	});
});
