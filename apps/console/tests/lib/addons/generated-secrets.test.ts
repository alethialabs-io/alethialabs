// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #2822 / #2823: a chart that generates its own credential does so at RENDER time, and ArgoCD
// re-renders on every reconcile — so the Application is permanently OutOfSync and the credential
// rotates under the running workload. `generateAddonSecrets` mints the value ONCE at enable time
// instead.
//
// The invariant this module owns is narrow and absolute: it may fill an unset secret key, and it
// may never touch anything else. Most of what follows is about that boundary, not about minting.
//
// The keyring is cached at module scope, so each run resets modules and re-imports with the env it
// wants (mirrors addon-secrets.test.ts and the crypto test).

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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
	const { generateAddonSecrets, hasStoredSecret, randomCredential } =
		await import("@/lib/addons/secrets");
	const { decryptSecret } = await import("@/lib/crypto/secrets");
	const { getAddOn, resolveAddOnInstall } = await import("@/lib/addons/catalog");
	return {
		generateAddonSecrets,
		hasStoredSecret,
		randomCredential,
		decryptSecret,
		getAddOn,
		resolveAddOnInstall,
	};
}

/** A minimal def with one secret key, one plain key, and a generator we can steer per test. */
function defWith(
	generateSecrets?: AddOnDef["generateSecrets"],
): AddOnDef<z.ZodTypeAny> {
	return {
		id: "test-addon",
		name: "Test",
		category: "platform",
		icon: "Boxes",
		summary: "",
		docsUrl: "",
		license: "Apache-2.0",
		chartRepo: "https://example.invalid",
		chart: "test",
		version: "1.0.0",
		namespace: "test",
		configSchema: z.object({
			plain: z.string().default("p"),
			token: z.string().default(""),
		}),
		fields: [
			{ key: "plain", label: "Plain", type: "string", default: "p" },
			{ key: "token", label: "Token", type: "secret", secret: true },
		],
		syncWave: 1,
		...(generateSecrets ? { generateSecrets } : {}),
	} as unknown as AddOnDef<z.ZodTypeAny>;
}

describe("generateAddonSecrets", () => {
	it("mints an unset declared secret, and stores it as an envelope rather than plaintext", async () => {
		const { generateAddonSecrets, hasStoredSecret, decryptSecret } = await load();
		const out = generateAddonSecrets(defWith(() => ({ token: "MINTED-VALUE" })), {
			plain: "p",
		});
		expect(hasStoredSecret(out.token)).toBe(true);
		// Envelope-shaped, and the plaintext is not recoverable by reading the stored field.
		expect(JSON.stringify(out.token)).not.toContain("MINTED-VALUE");
		expect(decryptSecret(out.token as never).token).toBe("MINTED-VALUE");
	});

	it("leaves a stored secret alone — a reconfigure must never rotate a live credential", async () => {
		const { generateAddonSecrets, decryptSecret } = await load();
		// The shape `mergeAddonSecrets` produces for a value the user set earlier.
		const existing = generateAddonSecrets(defWith(() => ({ token: "SUPPLIED" })), {});
		const out = generateAddonSecrets(defWith(() => ({ token: "MINTED-VALUE" })), existing);
		expect(decryptSecret(out.token as never).token).toBe("SUPPLIED");
	});

	it("is idempotent — enabling twice does not produce a second credential", async () => {
		const { generateAddonSecrets, randomCredential, decryptSecret } = await load();
		const def = defWith(() => ({ token: randomCredential() }));
		const once = generateAddonSecrets(def, {});
		const twice = generateAddonSecrets(def, once);
		expect(decryptSecret(twice.token as never).token).toBe(
			decryptSecret(once.token as never).token,
		);
	});

	it("ignores a generator key that is not a declared SECRET field", async () => {
		// Otherwise a generator could smuggle a credential into a plain knob, which lands in the
		// deploy snapshot as plaintext. The guard belongs here, not in each definition.
		const { generateAddonSecrets, decryptSecret } = await load();
		const out = generateAddonSecrets(
			defWith(() => ({ plain: "LEAKED", token: "ok" })),
			{},
		);
		expect(out.plain).toBeUndefined();
		expect(decryptSecret(out.token as never).token).toBe("ok");
	});

	it("ignores an empty minted value rather than storing a blank envelope", async () => {
		const { generateAddonSecrets, hasStoredSecret } = await load();
		const out = generateAddonSecrets(defWith(() => ({ token: "" })), {});
		expect(out.token).toBeUndefined();
		expect(hasStoredSecret(out.token)).toBe(false);
	});

	it("is a no-op for an add-on that declares no generator", async () => {
		const { generateAddonSecrets } = await load();
		expect(generateAddonSecrets(defWith(), { plain: "p" })).toEqual({ plain: "p" });
	});

	it("does not mutate its input", async () => {
		const { generateAddonSecrets } = await load();
		const input = { plain: "p" };
		generateAddonSecrets(defWith(() => ({ token: "MINTED-VALUE" })), input);
		expect(input).toEqual({ plain: "p" });
	});

	it("tells the generator which keys are already set", async () => {
		const { generateAddonSecrets } = await load();
		const seen: string[][] = [];
		const def = defWith((present) => {
			seen.push([...present]);
			return {};
		});
		generateAddonSecrets(def, {});
		const withToken = generateAddonSecrets(defWith(() => ({ token: "x" })), {});
		generateAddonSecrets(def, withToken);
		expect(seen).toEqual([[], ["token"]]);
	});
});

describe("randomCredential", () => {
	it("is URL-safe, long, and different every call", async () => {
		const { randomCredential } = await load();
		const a = randomCredential();
		const b = randomCredential();
		expect(a).not.toBe(b);
		expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
		// base64url of 24 bytes — enough that a chart's own `randAlphaNum 16` is not the weaker link.
		expect(a.length).toBeGreaterThanOrEqual(32);
	});
});

describe("minio (#2822)", () => {
	it("declares a generator for its root password", async () => {
		const { getAddOn } = await load();
		expect(getAddOn("minio")?.generateSecrets).toBeTypeOf("function");
	});

	it("resolves to an existingSecret once enabled, so the chart stops minting per render", async () => {
		const { getAddOn, resolveAddOnInstall, generateAddonSecrets } = await load();
		// Both ends are asserted on purpose. "The spec has an existingSecret" alone would still
		// pass if the generator never ran, and "the chart generates its own" is precisely the
		// defect — so the before state has to be pinned too.
		const bare = resolveAddOnInstall({ addon_id: "minio", mode: "managed" });
		expect(bare?.values.existingSecret).toBeUndefined();
		expect(bare?.secretRef).toBeUndefined();

		const minio = getAddOn("minio") as AddOnDef;
		const enabled = resolveAddOnInstall({
			addon_id: "minio",
			mode: "managed",
			values: generateAddonSecrets(minio, {}),
		});
		expect(enabled?.values.existingSecret).toBe("alethia-addon-minio");
		expect(enabled?.secretRef?.keys).toEqual(["rootPassword"]);
		// The username pairs in from the same Secret, and is NOT a secret.
		expect(enabled?.secretRef?.staticData).toEqual({ rootUser: "admin" });
	});

	it("never puts the password into the resolved values — only a ref to it", async () => {
		const { getAddOn, resolveAddOnInstall, generateAddonSecrets, decryptSecret } =
			await load();
		const minio = getAddOn("minio") as AddOnDef;
		const stored = generateAddonSecrets(minio, {});
		const plaintext = decryptSecret(stored.rootPassword as never).rootPassword;
		expect(plaintext).toBeTruthy();
		const enabled = resolveAddOnInstall({
			addon_id: "minio",
			mode: "managed",
			values: stored,
		});
		expect(JSON.stringify(enabled)).not.toContain(plaintext as string);
	});
});
