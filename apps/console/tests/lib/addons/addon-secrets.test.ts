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
	const {
		encryptAddonSecrets,
		decryptAddonSecrets,
		hasStoredSecret,
		stripAddonSecrets,
		redactAddonSecrets,
		mergeAddonSecrets,
	} = await import("@/lib/addons/secrets");
	const { getAddOn, resolveAddOnInstall } = await import("@/lib/addons/catalog");
	const externalDns = getAddOn("external-dns");
	const minio = getAddOn("minio");
	if (!externalDns || !minio) throw new Error("expected catalog add-ons missing");
	return {
		encryptAddonSecrets,
		decryptAddonSecrets,
		hasStoredSecret,
		stripAddonSecrets,
		redactAddonSecrets,
		mergeAddonSecrets,
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
		// minio gained a secret knob in #644, so the secret-free specimen is now loki.
		const { encryptAddonSecrets } = await load();
		const { getAddOn } = await import("@/lib/addons/catalog");
		const loki = getAddOn("loki");
		if (!loki) throw new Error("expected catalog add-on missing");
		const vals = { retentionDays: 7 };
		// Same reference back — nothing to encrypt.
		expect(encryptAddonSecrets(loki, vals)).toBe(vals);
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

// The client read (getProjectAddons) must not ship the stored ciphertext to the browser, while
// still telling the config sheet whether a secret is set. redactAddonSecrets replaces the envelope
// with a set-shaped marker that carries no ciphertext.
describe("redactAddonSecrets (client read)", () => {
	it("redacts a stored secret to a set-marker with no ciphertext, drops an unset one", async () => {
		const { encryptAddonSecrets, redactAddonSecrets, hasStoredSecret, externalDns } =
			await load();
		const stored = encryptAddonSecrets(externalDns, {
			provider: "cloudflare",
			apiToken: "SENTINEL-redact-token",
		});
		const redacted = redactAddonSecrets(externalDns, stored);
		// Non-secret field untouched; the secret still reads as "set" but carries no ciphertext.
		expect(redacted.provider).toBe("cloudflare");
		expect(hasStoredSecret(redacted.apiToken)).toBe(true);
		expect(redacted.apiToken).toEqual({ v: 0, iv: "", tag: "", data: "" });
		expect(JSON.stringify(redacted)).not.toContain("SENTINEL-redact-token");
		// An unset secret is dropped, never a blank marker.
		const noSecret = redactAddonSecrets(externalDns, { provider: "cloudflare" });
		expect("apiToken" in noSecret).toBe(false);
	});
});

// A reconfigure replaces the whole values object; mergeAddonSecrets preserves a secret the user
// left blank so re-saving other knobs never wipes it.
describe("mergeAddonSecrets (preserve untouched on reconfigure)", () => {
	it("encrypts a new value, preserves an untouched one, stays unset when neither exists", async () => {
		const {
			encryptAddonSecrets,
			mergeAddonSecrets,
			decryptAddonSecrets,
			externalDns,
		} = await load();
		const existing = encryptAddonSecrets(externalDns, {
			provider: "cloudflare",
			apiToken: "SENTINEL-old-token",
		});
		// Untouched secret (incoming empty) → the existing envelope carries forward.
		const kept = mergeAddonSecrets(
			externalDns,
			{ provider: "hetzner", apiToken: "" },
			existing,
		);
		expect(kept.apiToken).toEqual(existing.apiToken);
		expect(decryptAddonSecrets(externalDns, kept).apiToken).toBe(
			"SENTINEL-old-token",
		);
		expect(kept.provider).toBe("hetzner");
		// New plaintext → encrypted, replacing the old.
		const changed = mergeAddonSecrets(
			externalDns,
			{ provider: "cloudflare", apiToken: "SENTINEL-new-token" },
			existing,
		);
		expect(typeof changed.apiToken).toBe("object");
		expect(JSON.stringify(changed.apiToken)).not.toContain("SENTINEL-new-token");
		expect(decryptAddonSecrets(externalDns, changed).apiToken).toBe(
			"SENTINEL-new-token",
		);
		// Neither incoming nor existing → stays unset (no blank secret).
		const unset = mergeAddonSecrets(
			externalDns,
			{ provider: "cloudflare", apiToken: "" },
			null,
		);
		expect("apiToken" in unset).toBe(false);
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

	it("emits NO secretRef for an add-on without a stored secret", async () => {
		const { resolveAddOnInstall } = await load();
		const spec = resolveAddOnInstall({ addon_id: "minio", mode: "managed" });
		expect(spec).not.toBeNull();
		expect(spec?.secretRef).toBeUndefined();
	});
});

// The #644 consumer matrix: each secret-bearing add-on wires its chart's OWN
// existingSecret knob (shapes verified against the pinned charts via `helm template`),
// pairs non-secret usernames in via secretRef.staticData, and never lets the plaintext
// (or the envelope) into the spec. One sentinel-scan per add-on.
describe("secret-bearing add-on knobs (#644)", () => {
	const SENTINEL = "SENTINEL-644-secret";

	/** Resolve an add-on with an encrypted secret field and sentinel-scan the spec. */
	async function resolveWithSecret(
		addonId: string,
		values: Record<string, unknown>,
	) {
		const { encryptAddonSecrets, resolveAddOnInstall } = await load();
		const { getAddOn } = await import("@/lib/addons/catalog");
		const def = getAddOn(addonId);
		if (!def) throw new Error(`missing ${addonId}`);
		const spec = resolveAddOnInstall({
			addon_id: addonId,
			mode: "managed",
			values: encryptAddonSecrets(def, values),
		});
		expect(spec).not.toBeNull();
		const wire = JSON.stringify(spec);
		expect(wire).not.toContain(SENTINEL);
		expect(wire).not.toContain('"iv"');
		return spec;
	}

	it("kube-prometheus-stack: grafana.admin.existingSecret + username via staticData", async () => {
		const spec = await resolveWithSecret("kube-prometheus-stack", {
			adminUser: "ops",
			adminPassword: SENTINEL,
		});
		expect(spec?.secretRef).toEqual({
			secretName: "alethia-addon-kube-prometheus-stack",
			namespace: "monitoring",
			keys: ["adminPassword"],
			staticData: { adminUser: "ops" },
		});
		expect(spec?.values.grafana).toMatchObject({
			admin: {
				existingSecret: "alethia-addon-kube-prometheus-stack",
				userKey: "adminUser",
				passwordKey: "adminPassword",
			},
		});
	});

	it("minio: existingSecret with the chart-fixed rootUser/rootPassword keys", async () => {
		const spec = await resolveWithSecret("minio", {
			rootUser: "storage-admin",
			rootPassword: SENTINEL,
		});
		expect(spec?.secretRef).toEqual({
			secretName: "alethia-addon-minio",
			namespace: "minio",
			keys: ["rootPassword"],
			staticData: { rootUser: "storage-admin" },
		});
		expect(spec?.values.existingSecret).toBe("alethia-addon-minio");
	});

	it("harbor: existingSecretAdminPassword + key", async () => {
		const spec = await resolveWithSecret("harbor", { adminPassword: SENTINEL });
		expect(spec?.secretRef?.keys).toEqual(["adminPassword"]);
		expect(spec?.values.existingSecretAdminPassword).toBe("alethia-addon-harbor");
		expect(spec?.values.existingSecretAdminPasswordKey).toBe("adminPassword");
	});

	it("velero: credentials.existingSecret with the chart-fixed `cloud` key", async () => {
		const spec = await resolveWithSecret("velero", {
			provider: "aws",
			bucket: "backups",
			cloud: `[default]\naws_access_key_id=${SENTINEL}\naws_secret_access_key=${SENTINEL}`,
		});
		expect(spec?.secretRef?.keys).toEqual(["cloud"]);
		expect(spec?.values.credentials).toEqual({
			existingSecret: "alethia-addon-velero",
		});
		// The old plaintext path must never come back.
		expect(JSON.stringify(spec?.values)).not.toContain("secretContents");
	});

	it("no stored secret ⇒ no wiring for any of the four", async () => {
		const { resolveAddOnInstall } = await load();
		const wired = ["kube-prometheus-stack", "minio", "harbor", "velero"].map((id) => {
			const spec = resolveAddOnInstall({ addon_id: id, mode: "managed" });
			const wire = JSON.stringify(spec?.values);
			return {
				id,
				secretRef: spec?.secretRef,
				hasExisting: wire.includes("existingSecret") || wire.includes("alethia-addon-"),
			};
		});
		expect(wired).toEqual([
			{ id: "kube-prometheus-stack", secretRef: undefined, hasExisting: false },
			{ id: "minio", secretRef: undefined, hasExisting: false },
			{ id: "harbor", secretRef: undefined, hasExisting: false },
			{ id: "velero", secretRef: undefined, hasExisting: false },
		]);
	});
});
