// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #2846: an add-on whose chart supplies a PUBLISHED DEFAULT credential ships that credential to
// users, and nothing notices — because a constant produces no drift. ArgoCD stays Synced, the
// Application reports Healthy, and #2824's render-determinism guard agrees with itself, since it
// compares two renders of the same chart and a constant is identical in both.
//
// Grafana was the case: the catalog said "empty = the chart generates one" and the chart in fact
// uses `admin` / `prom-operator`, a constant in its values.yaml on GitHub.
//
// The rule these tests pin: every secret-typed field whose help offers to generate a value must
// have a generator behind that offer.

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADDON_CATALOG, getAddOn } from "@/lib/addons/catalog";
import { secretFieldKeys } from "@/lib/addons/secrets";
import type { AddOnDef } from "@/lib/addons/types";

// The crypto keyring is cached at module scope, so anything that ENCRYPTS resets modules and
// re-imports with the env it wants (mirrors addon-secrets.test.ts).
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

describe("kube-prometheus-stack grafana admin password (#2846)", () => {
	it("declares a generator, so a blank field is not the published default", () => {
		expect(getAddOn("kube-prometheus-stack")?.generateSecrets).toBeTypeOf("function");
	});

	it("resolves to an existingSecret once enabled", async () => {
		const { getAddOn, resolveAddOnInstall, generateAddonSecrets } = await load();
		// Both ends. Before: no secret, so the chart's `prom-operator` stands and the Application
		// is Healthy while accepting a password anyone can look up.
		const bare = resolveAddOnInstall({
			addon_id: "kube-prometheus-stack",
			mode: "managed",
		});
		expect(bare?.secretRef).toBeUndefined();

		const def = getAddOn("kube-prometheus-stack") as AddOnDef;
		const enabled = resolveAddOnInstall({
			addon_id: "kube-prometheus-stack",
			mode: "managed",
			values: generateAddonSecrets(def, {}),
		});
		expect(enabled?.secretRef?.keys).toEqual(["adminPassword"]);
		// The username is not a secret and pairs in from the same Secret.
		expect(enabled?.secretRef?.staticData).toEqual({ adminUser: "admin" });

		const grafana = enabled?.values.grafana as
			| { admin?: { existingSecret?: string; passwordKey?: string } }
			| undefined;
		expect(grafana?.admin?.existingSecret).toBe(
			"alethia-addon-kube-prometheus-stack",
		);
		expect(grafana?.admin?.passwordKey).toBe("adminPassword");
	});

	it("never puts the minted password into the resolved values", async () => {
		const { getAddOn, resolveAddOnInstall, generateAddonSecrets } = await load();
		const def = getAddOn("kube-prometheus-stack") as AddOnDef;
		const stored = generateAddonSecrets(def, {});
		const enabled = resolveAddOnInstall({
			addon_id: "kube-prometheus-stack",
			mode: "managed",
			values: stored,
		});
		expect(JSON.stringify(enabled)).not.toContain("prom-operator");
	});
});

describe("no add-on offers to generate a credential it cannot generate", () => {
	// THE GENERAL RULE, and the reason this file is not just about Grafana. Help text that says
	// "leave it empty and something will generate one" is read by users as a security promise. It
	// was false for Grafana (a published constant) and true-but-harmful for minio (regenerated on
	// every reconcile, #2822). Both are now minted; this keeps a third from appearing.
	const OFFERS = /Alethia mints one|Alethia generates one/i;

	it.each(
		ADDON_CATALOG.flatMap((def) =>
			def.fields
				.filter((f) => (f.type === "secret" || f.secret) && OFFERS.test(f.help ?? ""))
				.map((f) => [def.id, f.key] as const),
		),
	)("%s.%s promises minting and has a generator that supplies it", (id, key) => {
		const def = getAddOn(id) as AddOnDef;
		expect(def.generateSecrets, `${id} promises minting with no generator`).toBeTypeOf(
			"function",
		);
		const minted = Object.keys(def.generateSecrets?.(new Set<string>()) ?? {});
		expect(minted).toContain(key);
	});

	it("every generated key is a declared SECRET field of its add-on", () => {
		// A generator returning a key that is not a secret field would be silently dropped by
		// generateAddonSecrets — the value would never be stored and the chart would quietly keep
		// its default, which is exactly the failure being fixed, wearing a fix's clothes.
		for (const def of ADDON_CATALOG) {
			if (!def.generateSecrets) continue;
			const keys = secretFieldKeys(def);
			for (const minted of Object.keys(def.generateSecrets(new Set<string>()))) {
				expect(keys, `${def.id} mints ${minted}, which is not a secret field`).toContain(
					minted,
				);
			}
		}
	});

	// THE CONTRAPOSITIVE, and the hole the rule above had (#2856).
	//
	// `OFFERS` matches only the SAFE phrasing — "Alethia mints one". A field whose help promises
	// generation by the CHART is filtered out before any assertion runs, so the one sentence that is
	// actually dangerous was the one sentence the guard could not see. It is the exact wording that
	// shipped Grafana with `prom-operator`: a user reads "the chart generates one", leaves the field
	// blank, and receives a published constant.
	//
	// So the rule is stated the other way round: no secret field may promise generation by anything
	// other than Alethia. The two rules catch different things and both are worth having — one
	// checks that a promise is kept, this one checks that no promise is made on someone else's
	// behalf.
	// A BLACKLIST OF WORDINGS IS COMPLETE ONLY AGAINST THE WORDINGS IN HAND, which is the same
	// mistake the first pass at #2846 made: a regex over known-weak passwords missed
	// `harbor_registry_password` because it did not look like one. The fix there was to stop
	// enumerating bad values and compare against the chart itself. The equivalent here is to stop
	// enumerating bad phrasings.
	//
	// So: MENTIONING generation at all puts a secret field under an obligation, and the only way to
	// discharge it is to name Alethia. "the chart will generate one", "generated by Helm if left
	// blank", "a value is generated automatically", "blank = self-generated" all fail — not because
	// each is listed, but because none of them promises Alethia.
	const MENTIONS_GENERATION = /generat|mint/i;
	const PROMISES_ALETHIA = /Alethia\s+(?:mints|generates)/i;

	const offendingFields = () =>
		ADDON_CATALOG.flatMap((def) =>
			def.fields
				.filter((f) => f.type === "secret" || f.secret)
				.filter((f) => {
					const text = `${f.help ?? ""} ${f.label ?? ""}`;
					return MENTIONS_GENERATION.test(text) && !PROMISES_ALETHIA.test(text);
				})
				.map((f) => `${def.id}.${f.key}`),
		);

	it("a secret field that mentions generation names ALETHIA as the one doing it", () => {
		expect(offendingFields()).toEqual([]);
	});

	it("the rule is bounded, not a list — it catches wordings nobody enumerated", () => {
		// Guards the guard. Each of these is a real phrasing a reviewer suggested and NONE is in a
		// pattern above; they fail on the obligation, not on recognition.
		for (const text of [
			"Empty = the chart generates one.",
			"empty = chart-generated",
			"the chart will generate one",
			"generated by Helm if left blank",
			"a value is generated automatically",
			"blank = self-generated",
			"auto-generated by the operator",
		]) {
			expect(
				MENTIONS_GENERATION.test(text) && !PROMISES_ALETHIA.test(text),
				`should be an offender: ${text}`,
			).toBe(true);
		}
	});

	it("and does NOT fire on the safe phrasing, or every corrected field becomes an offender", () => {
		for (const text of [
			"Leave it empty and Alethia mints one for you, ONCE.",
			"empty = Alethia generates one",
		]) {
			expect(
				MENTIONS_GENERATION.test(text) && !PROMISES_ALETHIA.test(text),
				`should be safe: ${text}`,
			).toBe(false);
		}
	});

	it("a field that never mentions generation is not under the obligation at all", () => {
		// The bound that keeps this from becoming a style rule: silence is fine. Only a PROMISE
		// creates a duty to say who keeps it.
		const text = "Stored encrypted; delivered to the cluster as a k8s Secret.";
		expect(MENTIONS_GENERATION.test(text)).toBe(false);
	});

	it("the suite is not vacuous — at least two add-ons make the promise", () => {
		const promising = ADDON_CATALOG.filter((def) =>
			def.fields.some((f) => (f.type === "secret" || f.secret) && OFFERS.test(f.help ?? "")),
		);
		expect(promising.length).toBeGreaterThanOrEqual(2);
	});
});
