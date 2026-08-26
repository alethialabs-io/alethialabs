// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #2846: harbor installed with the credentials printed in its own chart's values.yaml —
// `Harbor12345` as the admin login and `not-a-secure-key` as the key it encrypts data at rest with.
// Both are CONSTANTS, so the render never drifted and nothing ever flagged them: the Application
// reported Healthy the whole time.

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAddOn } from "@/lib/addons/catalog";
import type { AddOnDef } from "@/lib/addons/types";

const KEY = randomBytes(32).toString("base64");
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	vi.resetModules();
	process.env.ALETHIA_CRED_ENCRYPTION_KEY = KEY;
});
afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

async function load() {
	const { generateAddonSecrets } = await import("@/lib/addons/secrets");
	const { getAddOn: get, resolveAddOnInstall } = await import("@/lib/addons/catalog");
	return { generateAddonSecrets, getAddOn: get, resolveAddOnInstall };
}

describe("harbor default credentials (#2846)", () => {
	it("mints both the admin password and the data-encryption key", async () => {
		const { getAddOn: get, generateAddonSecrets } = await load();
		const def = get("harbor") as AddOnDef;
		const stored = generateAddonSecrets(def, {});
		expect(Object.keys(stored).sort()).toEqual(["adminPassword", "secretKey"]);
	});

	it("wires BOTH existing-secret pointers, so neither chart default survives", async () => {
		const { getAddOn: get, resolveAddOnInstall, generateAddonSecrets } = await load();

		// Before: no secret stored, so the chart's own constants stand.
		const bare = resolveAddOnInstall({ addon_id: "harbor", mode: "managed" });
		expect(bare?.values.existingSecretAdminPassword).toBeUndefined();
		expect(bare?.values.existingSecretSecretKey).toBeUndefined();

		const def = get("harbor") as AddOnDef;
		const enabled = resolveAddOnInstall({
			addon_id: "harbor",
			mode: "managed",
			values: generateAddonSecrets(def, {}),
		});
		expect(enabled?.values.existingSecretAdminPassword).toBe("alethia-addon-harbor");
		expect(enabled?.values.existingSecretAdminPasswordKey).toBe("adminPassword");
		expect(enabled?.values.existingSecretSecretKey).toBe("alethia-addon-harbor");
		expect(enabled?.secretRef?.keys.sort()).toEqual(["adminPassword", "secretKey"]);
	});

	it("the data-encryption key is exactly 16 characters, as the chart demands", async () => {
		// goharbor's values.yaml: "The secret key used for encryption. Must be a string of 16
		// chars." A shorter or longer value is not a style question — Harbor refuses to start.
		const { getAddOn: get, generateAddonSecrets } = await load();
		const { decryptSecret } = await import("@/lib/crypto/secrets");
		const def = get("harbor") as AddOnDef;
		for (let i = 0; i < 25; i++) {
			const stored = generateAddonSecrets(def, {});
			const plain = decryptSecret(stored.secretKey as never).secretKey;
			expect(plain).toHaveLength(16);
		}
	});

	it("neither chart default appears anywhere in the resolved spec", async () => {
		const { getAddOn: get, resolveAddOnInstall, generateAddonSecrets } = await load();
		const def = get("harbor") as AddOnDef;
		const enabled = resolveAddOnInstall({
			addon_id: "harbor",
			mode: "managed",
			values: generateAddonSecrets(def, {}),
		});
		const json = JSON.stringify(enabled);
		expect(json).not.toContain("Harbor12345");
		expect(json).not.toContain("not-a-secure-key");
		// And no minted value either — only refs to them.
		const { decryptSecret } = await import("@/lib/crypto/secrets");
		const stored = generateAddonSecrets(def, {});
		expect(json).not.toContain(decryptSecret(stored.adminPassword as never).adminPassword);
	});

	it("a stored value is never rotated by a later save", async () => {
		const { getAddOn: get, generateAddonSecrets } = await load();
		const { decryptSecret } = await import("@/lib/crypto/secrets");
		const def = get("harbor") as AddOnDef;
		const first = generateAddonSecrets(def, {});
		const second = generateAddonSecrets(def, first);
		expect(decryptSecret(second.secretKey as never).secretKey).toBe(
			decryptSecret(first.secretKey as never).secretKey,
		);
	});
});

describe("generated fields are machine-owned", () => {
	it("harbor's secretKey is marked generated, and its admin password is NOT", () => {
		// The distinction that keeps the form usable: an admin password is something a user may
		// legitimately want to choose; an encryption key whose name the chart dictates is not.
		const fields = (getAddOn("harbor") as AddOnDef).fields;
		expect(fields.find((f) => f.key === "secretKey")?.generated).toBe(true);
		expect(fields.find((f) => f.key === "adminPassword")?.generated).toBeUndefined();
	});

	it("every generated field is also a secret field", () => {
		// A `generated` non-secret would be minted into the plain values and land in the deploy
		// snapshot as plaintext — the leak class this whole path exists to avoid.
		for (const def of [getAddOn("harbor") as AddOnDef]) {
			for (const f of def.fields.filter((x) => x.generated)) {
				expect(f.type === "secret" || f.secret, `${def.id}.${f.key}`).toBeTruthy();
			}
		}
	});
});

describe("the 16-character rule is enforced, not merely produced", () => {
	// `generated: true` hides the field from the configure form. It does NOT make it unsettable:
	// enableAddon validates incoming values BEFORE secrets are stripped, and every server action is
	// reachable as a POST. Relying on "our minting happens to produce 16" would leave a caller able
	// to store a length Harbor refuses to start on.
	const schema = (getAddOn("harbor") as AddOnDef).configSchema;

	it("accepts blank — the signal to mint one", () => {
		expect(schema.safeParse({ secretKey: "" }).success).toBe(true);
	});

	it("accepts exactly 16 characters", () => {
		expect(schema.safeParse({ secretKey: "0123456789abcdef" }).success).toBe(true);
	});

	it.each([
		["15 characters", "0123456789abcde"],
		["17 characters", "0123456789abcdefg"],
		["1 character", "x"],
		["a long passphrase", "correct-horse-battery-staple"],
	])("rejects %s", (_label, value) => {
		const result = schema.safeParse({ secretKey: value });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(JSON.stringify(result.error.issues)).toContain("16 characters");
		}
	});
});
