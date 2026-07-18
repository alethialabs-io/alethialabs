// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W4 guard: the `AddOnField[]` form descriptors and the per-add-on Zod `configSchema` are
// hand-kept in sync (the descriptors drive the client form; the schema validates server-side).
// They used to drift silently. These tests check them BEHAVIORALLY (via parse — no zod internals):
// every descriptor names a real schema key, and an enum's options are exactly the values the schema
// accepts. Plus: addOnFieldSchema validates the descriptor shapes, and enum choices flow through
// resolveAddOnInstall into the Helm values. (Secret encrypt-at-rest is covered by addon-secrets.test.ts.)

import { describe, expect, it } from "vitest";
import { ADDON_CATALOG, resolveAddOnInstall } from "@/lib/addons/catalog";
import { addOnFieldSchema } from "@/lib/addons/types";

describe("add-on field descriptors are consistent with their Zod configSchema", () => {
	for (const def of ADDON_CATALOG) {
		// configSchema is a generic ZodTypeAny → parse() is `unknown`; the defaults are an object.
		const defaults = def.configSchema.parse({}) as Record<string, unknown>;

		for (const field of def.fields) {
			it(`${def.id}.${field.key} names a real schema key`, () => {
				expect(Object.keys(defaults)).toContain(field.key);
			});

			if (field.type === "enum") {
				it(`${def.id}.${field.key} enum options match what the schema accepts`, () => {
					expect(field.options?.length ?? 0).toBeGreaterThan(0);
					// Every offered choice must validate…
					for (const opt of field.options ?? []) {
						const ok = def.configSchema.safeParse({
							...defaults,
							[field.key]: opt.value,
						}).success;
						expect(ok).toBe(true);
					}
					// …and a value NOT among the options must be rejected — proving the schema key is
					// really an enum, not a free string mislabelled as one.
					const rejected = def.configSchema.safeParse({
						...defaults,
						[field.key]: "__not_a_valid_choice__",
					}).success;
					expect(rejected).toBe(false);
				});
			}
		}
	}

	it("every real catalog field descriptor validates against addOnFieldSchema", () => {
		for (const def of ADDON_CATALOG) {
			for (const field of def.fields) {
				const res = addOnFieldSchema.safeParse(field);
				expect(res.success).toBe(true);
			}
		}
	});
});

// #7 / #640 leak-class guard. A knob whose KEY names a credential VALUE (a password, token, API/access
// key, or credential blob) MUST be `type: "secret"` so it is encrypted at rest and diverted to the
// runner-seeded k8s Secret at execution time (#640) — never rendered into config_snapshot, the ArgoCD
// Application manifest, or the customer's gitops repo. This locks the invariant across the WHOLE
// catalog so a future add-on cannot silently reintroduce the plaintext-credential leak by mislabelling
// a field. Deliberately excludes bare "secret" (matches reference keys like `existingSecret`/
// `secretName`, which name a Secret, not a value).
describe("#640 leak-class guard: credential-shaped knobs are write-only secret fields", () => {
	const CREDENTIAL_KEY =
		/pass(word|phrase|wd)|token|api[_-]?key|access[_-]?key|secret[_-]?key|credential/i;
	for (const def of ADDON_CATALOG) {
		for (const field of def.fields) {
			// A nested field's own value isn't a credential; its scalar children are checked as fields.
			if (field.type === "nested") continue;
			if (!CREDENTIAL_KEY.test(field.key)) continue;
			it(`${def.id}.${field.key} is a write-only secret field`, () => {
				expect(field.type).toBe("secret");
				expect(field.secret).toBe(true);
				// Write-only: a default would bake a plaintext credential into the catalog + the client form.
				expect(field.default).toBeUndefined();
			});
		}
	}

	it("the secure secret pipeline is actually exercised by the catalog", () => {
		const withSecret = ADDON_CATALOG.filter((d) =>
			d.fields.some((f) => f.type === "secret"),
		);
		// kube-prometheus-stack, velero, minio, harbor, external-dns wire secret knobs today.
		expect(withSecret.length).toBeGreaterThanOrEqual(5);
	});
});

describe("addOnFieldSchema", () => {
	it("accepts enum / secret / nested / number / boolean descriptors", () => {
		const valid = [
			{ key: "a", label: "A", type: "enum", options: [{ value: "x", label: "X" }] },
			{ key: "b", label: "B", type: "secret", secret: true },
			{
				key: "c",
				label: "C",
				type: "nested",
				fields: [{ key: "d", label: "D", type: "number", default: 1 }],
			},
			{ key: "e", label: "E", type: "number", default: 5, min: 1, max: 10 },
			{ key: "g", label: "G", type: "boolean", default: false },
		];
		for (const f of valid) {
			expect(addOnFieldSchema.safeParse(f).success).toBe(true);
		}
	});

	it("rejects an enum without options", () => {
		expect(
			addOnFieldSchema.safeParse({ key: "a", label: "A", type: "enum" }).success,
		).toBe(false);
	});

	it("rejects two-level nesting (a nested field inside a nested field)", () => {
		const twoLevel = {
			key: "a",
			label: "A",
			type: "nested",
			fields: [{ key: "b", label: "B", type: "nested", fields: [] }],
		};
		expect(addOnFieldSchema.safeParse(twoLevel).success).toBe(false);
	});
});

describe("enum choices resolve into the Helm values", () => {
	it("minio mode picks the chosen enum value", () => {
		const spec = resolveAddOnInstall({
			addon_id: "minio",
			mode: "managed",
			values: { mode: "distributed", storageGb: 100 },
		});
		expect(spec?.values).toMatchObject({
			mode: "distributed",
			persistence: { size: "100Gi" },
		});
	});

	it("external-dns provider picks the chosen enum value", () => {
		const spec = resolveAddOnInstall({
			addon_id: "external-dns",
			mode: "managed",
			values: { provider: "hetzner" },
		});
		expect(spec?.values).toMatchObject({ provider: { name: "hetzner" } });
	});
});
