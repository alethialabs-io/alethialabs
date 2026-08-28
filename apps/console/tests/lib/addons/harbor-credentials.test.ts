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

// Every secret harbor mints, sorted. #2846 established the first two; #2823 added the seven that
// the chart would otherwise generate at RENDER time. Written out rather than derived from the def
// so that adding a field to the catalog has to be a deliberate change here too — a test that asks
// the catalog what it contains cannot notice the catalog gaining something.
const MINTED_KEYS = [
	"CSRF_KEY",
	"JOBSERVICE_SECRET",
	"REGISTRY_HTPASSWD",
	"REGISTRY_HTTP_SECRET",
	"REGISTRY_PASSWD",
	"adminPassword",
	"secret",
	"secretKey",
	"tls.key",
];

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
		expect(Object.keys(stored).sort()).toEqual(MINTED_KEYS);
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
		expect(enabled?.secretRef?.keys.sort()).toEqual(MINTED_KEYS);
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

// #2823: harbor also regenerated seven values on EVERY render — the token-signing keypair, the
// ingress TLS cert, core's secret and CSRF key, jobservice's secret, the registry's HTTP secret
// and a re-salted registry htpasswd. ArgoCD re-renders on every reconcile, so the Application sat
// permanently OutOfSync and the `checksum/secret` pod-template annotations rolled core, jobservice,
// registry and trivy forever. The rotating token key is the load-bearing one: it signs the
// registry's auth tokens, so rotating it invalidates every `docker pull` credential ever issued.
describe("harbor render determinism (#2823)", () => {
	it("points every rotating value at the add-on Secret instead of a chart default", async () => {
		const { getAddOn: get, resolveAddOnInstall, generateAddonSecrets } = await load();
		const def = get("harbor") as AddOnDef;
		const enabled = resolveAddOnInstall({
			addon_id: "harbor",
			mode: "managed",
			values: generateAddonSecrets(def, {}),
		});
		const v = enabled?.values as Record<string, Record<string, unknown>>;

		// The four keys the chart HARDCODES, so the Secret's data key must match exactly.
		expect(v.core.existingSecret).toBe("alethia-addon-harbor"); // reads `secret`
		expect(v.core.secretName).toBe("alethia-addon-harbor"); // mounts subPath tls.key
		expect((v.registry.credentials as Record<string, unknown>).existingSecret).toBe(
			"alethia-addon-harbor",
		); // reads REGISTRY_PASSWD + REGISTRY_HTPASSWD

		// The three with a companion *Key value.
		expect(v.core.existingXsrfSecretKey).toBe("CSRF_KEY");
		expect(v.jobservice.existingSecretKey).toBe("JOBSERVICE_SECRET");
		expect(v.registry.existingSecretKey).toBe("REGISTRY_HTTP_SECRET");

		// The DEFAULT path exposes over clusterIP, so there is no ingress TLS Secret for
		// genSignedCert to re-mint and TLS is off — enabling it would promise an https
		// `externalURL` that nothing terminates.
		expect(v.expose.type).toBe("clusterIP");
		expect((v.expose.tls as Record<string, unknown>).enabled).toBe(false);
	});

	// #2823's actual fix lives on the INGRESS path, and that is where it is asserted — the default
	// changed to clusterIP (an Ingress no controller claims never gets a load-balancer address, so
	// ArgoCD held addon-harbor Progressing forever), and asserting the default alone would have
	// silently stopped covering the non-determinism this suite exists for.
	it("keeps certSource none on the INGRESS path, where genSignedCert would otherwise re-mint every render", async () => {
		const { getAddOn: get, resolveAddOnInstall, generateAddonSecrets } = await load();
		const def = get("harbor") as AddOnDef;
		const enabled = resolveAddOnInstall({
			addon_id: "harbor",
			mode: "managed",
			values: { ...generateAddonSecrets(def, {}), exposeType: "ingress" },
		});
		const v = enabled?.values as Record<string, Record<string, unknown>>;

		expect(v.expose.type).toBe("ingress");
		// certSource `auto` — the chart default — is what called genSignedCert every render.
		expect((v.expose.tls as Record<string, unknown>).certSource).toBe("none");
		// …and TLS stays ENABLED here, so `externalURL` remains https. `tls.enabled: false` would
		// also be deterministic and would silently make the advertised scheme wrong.
		expect((v.expose.tls as Record<string, unknown>).enabled).toBe(true);
	});

	it("mints the registry htpasswd as bcrypt OF the registry password it stores", async () => {
		// Not a formatting nicety: docker distribution's htpasswd access controller accepts bcrypt
		// only, and the line must name `registry.credentials.username`, which we leave at the
		// chart's default. A mismatch here fails at `docker login`, not at deploy.
		const { getAddOn: get, generateAddonSecrets } = await load();
		const { decryptSecret } = await import("@/lib/crypto/secrets");
		const { compareSync } = await import("bcryptjs");
		const def = get("harbor") as AddOnDef;
		const stored = generateAddonSecrets(def, {});

		const password = decryptSecret(stored.REGISTRY_PASSWD as never).REGISTRY_PASSWD;
		const line = decryptSecret(stored.REGISTRY_HTPASSWD as never).REGISTRY_HTPASSWD;
		const [user, ...rest] = line.split(":");
		const hash = rest.join(":");

		expect(user).toBe("harbor_registry_user");
		expect(hash).toMatch(/^\$2[aby]\$/);
		expect(compareSync(password, hash)).toBe(true);
		// The salt is what made the chart's own htpasswd non-deterministic, so prove the stored
		// hash verifies the stored password and NOT a different one.
		expect(compareSync(`${password}x`, hash)).toBe(false);
	});

	it("mints a real RSA private key for the token signer", async () => {
		const { createPrivateKey } = await import("node:crypto");
		const { getAddOn: get, generateAddonSecrets } = await load();
		const { decryptSecret } = await import("@/lib/crypto/secrets");
		const def = get("harbor") as AddOnDef;
		const stored = generateAddonSecrets(def, {});
		const pem = decryptSecret(stored["tls.key"] as never)["tls.key"];

		expect(pem).toContain("BEGIN RSA PRIVATE KEY");
		const key = createPrivateKey(pem);
		expect(key.asymmetricKeyType).toBe("rsa");
		expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048);
	});

	it("carries every stored value forward, so a reconfigure never rotates one", async () => {
		// The whole point: a value that changes is a value that rolls harbor's pods and breaks its
		// issued tokens. A save of an unrelated knob must not touch any of these.
		const { getAddOn: get, generateAddonSecrets } = await load();
		const { decryptSecret } = await import("@/lib/crypto/secrets");
		const def = get("harbor") as AddOnDef;
		const first = generateAddonSecrets(def, {});
		const second = generateAddonSecrets(def, first);
		for (const key of MINTED_KEYS) {
			expect(
				decryptSecret(second[key] as never)[key],
				`${key} rotated on re-save`,
			).toBe(decryptSecret(first[key] as never)[key]);
		}
	});

	it("REGISTRY_PASSWD and REGISTRY_HTPASSWD are minted as a pair", async () => {
		// `generateSecrets` is handed the set of keys that are PRESENT, never their values, so it
		// cannot mint an htpasswd matching a password it cannot read. Minting them together is
		// what keeps the two consistent — mint one alone and `docker login` fails silently.
		const { getAddOn: get, generateAddonSecrets } = await load();
		const def = get("harbor") as AddOnDef;
		const both = generateAddonSecrets(def, {});
		const carried = generateAddonSecrets(def, both);

		// Present already → neither is re-minted.
		expect(carried.REGISTRY_PASSWD).toEqual(both.REGISTRY_PASSWD);
		expect(carried.REGISTRY_HTPASSWD).toEqual(both.REGISTRY_HTPASSWD);
		// Absent → both appear.
		expect(Object.keys(both)).toContain("REGISTRY_PASSWD");
		expect(Object.keys(both)).toContain("REGISTRY_HTPASSWD");
	});

	it("no minted value reaches the resolved spec — only refs to them", async () => {
		const { getAddOn: get, resolveAddOnInstall, generateAddonSecrets } = await load();
		const { decryptSecret } = await import("@/lib/crypto/secrets");
		const def = get("harbor") as AddOnDef;
		const stored = generateAddonSecrets(def, {});
		const json = JSON.stringify(
			resolveAddOnInstall({ addon_id: "harbor", mode: "managed", values: stored }),
		);
		for (const key of MINTED_KEYS) {
			expect(json, `${key} leaked into the spec`).not.toContain(
				decryptSecret(stored[key] as never)[key],
			);
		}
		// And the chart's published registry credential is gone with them (#2846's class).
		expect(json).not.toContain("harbor_registry_password");
	});
});
