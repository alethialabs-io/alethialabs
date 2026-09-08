// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The workbench re-seeds the canvas only when the server design's REVISION moved. That is only
// safe if the revision is a function of content alone: the same design serialised with its keys
// in another order, or with an `undefined` member where the last render had none, must hash the
// same — otherwise a re-render is a re-seed again and the fix is cosmetic.

import { describe, expect, it } from "vitest";
import { buildDefaultFormValues } from "@/components/design-project/source-project";
import {
	designRevision,
	draftScope,
	fnv1a32,
	NEW_DRAFT_SCOPE,
	stableStringify,
} from "@/lib/canvas/design-revision";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

/** One database, the shape `getProjectAsFormData` emits for a row. */
const ORDERS: ProjectFormData["databases"][number] = {
	name: "orders",
	engine_family: "postgres",
	min_capacity: 0.5,
	max_capacity: 4,
	port: 5432,
	iam_auth: false,
};

/** A design with one database, built from the defaults. */
function design(overrides: Partial<ProjectFormData> = {}): ProjectFormData {
	const base = buildDefaultFormValues();
	return {
		...base,
		project: { ...base.project, project_name: "shop", region: "eu-west-1" },
		databases: [ORDERS],
		...overrides,
	};
}

describe("stableStringify", () => {
	it("sorts object keys recursively and keeps array order", () => {
		expect(stableStringify({ b: { z: 1, a: [3, 1, 2] }, a: "x" })).toBe(
			'{"a":"x","b":{"a":[3,1,2],"z":1}}',
		);
	});

	it("drops undefined members and renders undefined array slots as null, like JSON.stringify", () => {
		expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
		expect(stableStringify([undefined, 1])).toBe("[null,1]");
		expect(stableStringify(undefined)).toBe("null");
		expect(stableStringify(null)).toBe("null");
	});
});

describe("fnv1a32", () => {
	it("matches the published FNV-1a 32-bit test vectors", () => {
		expect(fnv1a32("")).toBe("811c9dc5");
		expect(fnv1a32("a")).toBe("e40c292c");
		expect(fnv1a32("foobar")).toBe("bf9cf968");
	});
});

describe("designRevision", () => {
	it("is a function of content, not object identity", () => {
		expect(designRevision(design())).toBe(designRevision(design()));
	});

	it("is independent of key order at every depth", () => {
		const a = design();
		// The same design with its keys written in another order at the top level, inside the
		// project block and inside the database row — what a different serializer would emit.
		const { project, databases, ...rest } = a;
		const b: ProjectFormData = {
			databases: databases.map((db) => ({
				iam_auth: db.iam_auth,
				port: db.port,
				max_capacity: db.max_capacity,
				min_capacity: db.min_capacity,
				engine_family: db.engine_family,
				name: db.name,
			})),
			project: {
				iac_version: project.iac_version,
				cloud_identity_id: project.cloud_identity_id,
				region: project.region,
				environment_stage: project.environment_stage,
				project_name: project.project_name,
			},
			...rest,
		};
		expect(Object.keys(b)).not.toEqual(Object.keys(a));
		expect(Object.keys(b.project)).not.toEqual(Object.keys(a.project));
		expect(b).toEqual(a);
		expect(designRevision(b)).toBe(designRevision(a));
	});

	it("treats an undefined member and an absent one as the same design", () => {
		const a = design();
		const withUndefined = design({ dns: { ...a.dns, managed_certificate: undefined } });
		const absent = design({ dns: { ...a.dns } });
		delete absent.dns.managed_certificate;
		expect("managed_certificate" in withUndefined.dns).toBe(true);
		expect("managed_certificate" in absent.dns).toBe(false);
		expect(designRevision(withUndefined)).toBe(designRevision(absent));
	});

	it("moves when the content moves — a port change, a new table, a reordered list", () => {
		const base = designRevision(design());
		expect(designRevision(design({ databases: [{ ...ORDERS, port: 6543 }] }))).not.toBe(base);
		const audit = { ...ORDERS, name: "audit" };
		const two = design({ databases: [ORDERS, audit] });
		expect(designRevision(two)).not.toBe(base);
		expect(designRevision(design({ databases: [audit, ORDERS] }))).not.toBe(
			designRevision(two),
		);
	});

	it("is eight lowercase hex digits", () => {
		expect(designRevision(design())).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe("draftScope", () => {
	it("is the create-flow scope without a project", () => {
		expect(draftScope(undefined, undefined)).toBe(NEW_DRAFT_SCOPE);
		expect(draftScope(undefined, "env-1")).toBe("new");
	});

	it("is project:environment, with 'default' for an unresolved environment", () => {
		expect(draftScope("proj-1", "env-a")).toBe("proj-1:env-a");
		expect(draftScope("proj-1", undefined)).toBe("proj-1:default");
	});
});
