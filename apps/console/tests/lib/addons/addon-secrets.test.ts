// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W4: proves add-on secret knobs are encrypted-at-rest — a secret field is stored as an
// EncryptedSecret envelope (never plaintext), round-trips back to its value, and non-secret /
// empty / pre-W4-plaintext values are handled tolerantly. The encryption key is cached at module
// scope, so each run resets modules + re-imports with the env it wants (mirrors the crypto test).

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
	const { encryptAddonSecrets, decryptAddonSecrets, hasStoredSecret, stripAddonSecrets } =
		await import("@/lib/addons/secrets");
	const { getAddOn, resolveAddOnInstall } = await import("@/lib/addons/catalog");
	const externalDns = getAddOn("external-dns");
	const minio = getAddOn("minio");
	if (!externalDns || !minio) throw new Error("expected catalog add-ons missing");
	return {
		encryptAddonSecrets,
		decryptAddonSecrets,
		hasStoredSecret,
		stripAddonSecrets,
		resolveAddOnInstall,
		externalDns,
		minio,
	};
}

describe("add-on secret encrypt-at-rest", () => {
	it("encrypts a secret field into an envelope (never plaintext) and decrypts it back", async () => {
		const { encryptAddonSecrets, decryptAddonSecrets, externalDns } = await load();

		const stored = encryptAddonSecrets(externalDns, {
			provider: "cloudflare",
			apiToken: "cf-secret-abc",
		});
		// Non-secret field untouched; the token is an EncryptedSecret envelope, not plaintext.
		expect(stored.provider).toBe("cloudflare");
		expect(typeof stored.apiToken).toBe("object");
		expect(JSON.stringify(stored.apiToken)).not.toContain("cf-secret-abc");

		const back = decryptAddonSecrets(externalDns, stored);
		expect(back.apiToken).toBe("cf-secret-abc");
		expect(back.provider).toBe("cloudflare");
	});

	it("drops an empty secret (no blank envelope) and tolerates pre-W4 plaintext on decrypt", async () => {
		const { encryptAddonSecrets, decryptAddonSecrets, externalDns } = await load();

		const stored = encryptAddonSecrets(externalDns, {
			provider: "hetzner",
			apiToken: "",
		});
		expect("apiToken" in stored).toBe(false);

		// A pre-W4 row may hold a plaintext token — decrypt must pass it through, not throw.
		expect(
			decryptAddonSecrets(externalDns, { apiToken: "legacy-plain" }).apiToken,
		).toBe("legacy-plain");
	});

	it("no-ops for an add-on with no secret fields", async () => {
		const { encryptAddonSecrets, minio } = await load();
		const vals = { storageGb: 100, mode: "standalone" };
		// Same reference back — nothing to encrypt.
		expect(encryptAddonSecrets(minio, vals)).toBe(vals);
	});

	it("strips secret fields (envelope AND legacy plaintext) so resolution never sees them", async () => {
		const { encryptAddonSecrets, stripAddonSecrets, hasStoredSecret, externalDns } =
			await load();
		const stored = encryptAddonSecrets(externalDns, {
			provider: "cloudflare",
			apiToken: "cf-secret-abc",
		});
		expect(hasStoredSecret(stored.apiToken)).toBe(true);
		expect(hasStoredSecret("legacy-plain")).toBe(true);
		expect(hasStoredSecret("")).toBe(false);
		expect(hasStoredSecret(undefined)).toBe(false);

		const stripped = stripAddonSecrets(externalDns, stored);
		expect("apiToken" in stripped).toBe(false);
		expect(stripped.provider).toBe("cloudflare");
		// Legacy plaintext rows are stripped too — never resolved into values.
		expect("apiToken" in stripAddonSecrets(externalDns, { apiToken: "legacy" })).toBe(false);
	});
});

// The W4.5 (#640) contract: `resolveAddOnInstall` NEVER resolves a secret into `values`
// — not from an envelope, not from a legacy plaintext row — and instead emits a
// `secretRef` + the chart's SecretKeyRef wiring. This is the test that closes the
// config-snapshot + manifest + gitops-repo plaintext leaks at their source.
describe("resolveAddOnInstall secret diversion (#640)", () => {
	it("emits secretRef + secretKeyRef wiring and no plaintext for an enveloped token", async () => {
		const { encryptAddonSecrets, resolveAddOnInstall, externalDns } = await load();
		const stored = encryptAddonSecrets(externalDns, {
			provider: "cloudflare",
			apiToken: "SENTINEL-cf-token-9f3a",
		});
		const spec = resolveAddOnInstall({
			addon_id: "external-dns",
			mode: "managed",
			values: stored,
		});
		expect(spec).not.toBeNull();
		// The whole spec — values included — must not carry the plaintext OR the envelope.
		const wire = JSON.stringify(spec);
		expect(wire).not.toContain("SENTINEL-cf-token-9f3a");
		expect(wire).not.toContain('"iv"');
		// The chart is wired at the runner-seeded Secret instead.
		expect(spec?.secretRef).toEqual({
			secretName: "alethia-addon-external-dns",
			namespace: "external-dns",
			keys: ["apiToken"],
		});
		expect(spec?.values.env).toEqual([
			{
				name: "CF_API_TOKEN",
				valueFrom: {
					secretKeyRef: { name: "alethia-addon-external-dns", key: "apiToken" },
				},
			},
		]);
	});

	it("diverts a legacy pre-W4 plaintext row the same way (still no plaintext in the spec)", async () => {
		const { resolveAddOnInstall } = await load();
		const spec = resolveAddOnInstall({
			addon_id: "external-dns",
			mode: "managed",
			values: { provider: "cloudflare", apiToken: "SENTINEL-legacy-token" },
		});
		expect(JSON.stringify(spec)).not.toContain("SENTINEL-legacy-token");
		expect(spec?.secretRef?.keys).toEqual(["apiToken"]);
	});

	it("emits NO secretRef (and no env wiring) when the token was never stored", async () => {
		const { resolveAddOnInstall } = await load();
		const spec = resolveAddOnInstall({
			addon_id: "external-dns",
			mode: "managed",
			values: { provider: "cloudflare" },
		});
		expect(spec?.secretRef).toBeUndefined();
		expect(spec?.values.env).toBeUndefined();
	});

	it("emits NO secretRef for an add-on without secret fields", async () => {
		const { resolveAddOnInstall } = await load();
		const spec = resolveAddOnInstall({ addon_id: "minio", mode: "managed" });
		expect(spec).not.toBeNull();
		expect(spec?.secretRef).toBeUndefined();
	});
});
