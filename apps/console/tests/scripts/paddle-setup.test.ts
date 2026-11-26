// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// scripts/paddle-setup.ts as a plan/apply tool (Paddle Billing plan, lane L2), against an in-memory
// Paddle account. Pinned: `--plan` writes nothing; `--apply` converges and a second plan is empty;
// prices are the catalog's amounts (USD with an EUR override for the euro area); a drifted amount
// or override is replaced (new price, old archived), never PATCHed; the environment follows the key
// prefix and a live key needs `--live`; the destination's secret reaches a 0600 file and never the
// output; the webhook event list is pinned; the env names printed are the ones the console reads
// (lib/billing/paddle/env-names.ts); `--client-token` keeps exactly one Paddle.js token.

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiPlanUnitAmountCents, planUnitAmountCents } from "@repo/plan-catalog";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PADDLE_PRICE_ENV, PADDLE_PRODUCT_ENV } from "../../lib/billing/paddle/env-names";
import { runCheckCli } from "../../scripts/paddle-check";
import {
	CLIENT_TOKEN_NAME,
	catalogEnvLines,
	computePlan,
	createPaddleClient,
	DESIRED_PRICES,
	DESIRED_PRODUCTS,
	environmentRefusal,
	EUROZONE_COUNTRIES,
	type FetchLike,
	type NotificationCreateBody,
	type Observed,
	PADDLE_WEBHOOK_EVENTS,
	type PaddleClient,
	type PaddleClientToken,
	type PaddleKeyEnv,
	type PaddleNotificationSetting,
	type PaddlePrice,
	type PaddleProduct,
	type PriceCreateBody,
	priceEnvVar,
	readState,
	resolveKey,
	runSetup,
} from "../../scripts/paddle-setup";

const SANDBOX_KEY = "pdl_sdbx_apikey_unit_000";
const LIVE_KEY = "pdl_live_apikey_unit_000";
const URL = "https://alethialabs.io/api/webhooks/paddle";
const FAKE_SECRET = "pdl_ntfset_unit_secret_000";

/** An in-memory Paddle account. */
interface FakeAccount {
	products: PaddleProduct[];
	prices: PaddlePrice[];
	notifications: PaddleNotificationSetting[];
	clientTokens: PaddleClientToken[];
	/** Every write, in order, as "<verb> <id>". */
	writes: string[];
	/** The tax mode a created price reads back as (Paddle resolves `account_setting`). */
	resolvedTaxMode: string;
}

/** An empty account. */
function emptyAccount(): FakeAccount {
	return { products: [], prices: [], notifications: [], clientTokens: [], writes: [], resolvedTaxMode: "location" };
}

/** A PaddleClient over `acct`, mimicking Paddle's id prefixes and its tax-mode resolution. */
function fakeClient(acct: FakeAccount): PaddleClient {
	let n = 0;
	const nextId = (prefix: string) => `${prefix}_${String(++n).padStart(4, "0")}`;
	/** Finds a price or throws like Paddle's 404. */
	const price = (id: string) => {
		const p = acct.prices.find((x) => x.id === id);
		if (!p) throw new Error(`not found ${id}`);
		return p;
	};
	return {
		listProducts: async () => acct.products.filter((p) => p.status === "active"),
		createProduct: async (body) => {
			const p: PaddleProduct = { id: nextId("pro"), status: "active", ...body };
			acct.products.push(p);
			acct.writes.push(`product.create ${p.id}`);
			return p;
		},
		updateProduct: async (id, body) => {
			const p = acct.products.find((x) => x.id === id);
			if (!p) throw new Error(`not found ${id}`);
			Object.assign(p, body);
			acct.writes.push(`product.update ${id}`);
			return p;
		},
		listPrices: async () => acct.prices.filter((p) => p.status === "active"),
		createPrice: async (body: PriceCreateBody) => {
			const p: PaddlePrice = { id: nextId("pri"), status: "active", ...body, tax_mode: acct.resolvedTaxMode };
			acct.prices.push(p);
			acct.writes.push(`price.create ${p.id}`);
			return p;
		},
		updatePrice: async (id, body) => {
			const p = price(id);
			if ("status" in body) {
				p.status = body.status;
				acct.writes.push(`price.archive ${id}`);
			} else {
				p.name = body.name;
				p.description = body.description;
				acct.writes.push(`price.update ${id}`);
			}
			return p;
		},
		listNotificationSettings: async () => acct.notifications,
		createNotificationSetting: async (body: NotificationCreateBody) => {
			const s: PaddleNotificationSetting = {
				id: nextId("ntfset"),
				description: body.description,
				type: body.type,
				destination: body.destination,
				active: true,
				subscribed_events: body.subscribed_events.map((name) => ({ name })),
			};
			acct.notifications.push(s);
			acct.writes.push(`notification.create ${s.id}`);
			return { ...s, endpoint_secret_key: FAKE_SECRET };
		},
		updateNotificationSetting: async (id, body) => {
			const s = acct.notifications.find((x) => x.id === id);
			if (!s) throw new Error(`not found ${id}`);
			s.subscribed_events = body.subscribed_events.map((name) => ({ name }));
			s.active = body.active;
			acct.writes.push(`notification.update ${id}`);
			return s;
		},
		listClientTokens: async () => acct.clientTokens.filter((t) => t.status === "active"),
		createClientToken: async (body) => {
			const t: PaddleClientToken = { id: nextId("ctkn"), token: `test_${String(n).padStart(4, "0")}`, status: "active", ...body };
			acct.clientTokens.push(t);
			acct.writes.push(`client_token.create ${t.id}`);
			return t;
		},
	};
}

let dir: string;
let lines: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "paddle-setup-"));
	lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the CLI against `acct`, collecting output. */
function run(acct: FakeAccount, argv: string[], env: PaddleKeyEnv = { PADDLE_API_KEY: SANDBOX_KEY }) {
	return runSetup(argv, env, () => fakeClient(acct), (l) => lines.push(l), join(dir, "secrets"));
}

/** A converged account: apply once to an empty one. */
async function converged(): Promise<FakeAccount> {
	const acct = emptyAccount();
	expect(await run(acct, ["--apply"])).toBe(0);
	acct.writes = [];
	lines = [];
	return acct;
}

/** The single active price carrying `key`. */
function activePrice(acct: FakeAccount, key: string): PaddlePrice {
	const found = acct.prices.filter((p) => p.status === "active" && p.custom_data?.alethia_key === key);
	expect(found).toHaveLength(1);
	const [p] = found;
	if (!p) throw new Error(`no active price ${key}`);
	return p;
}

describe("keys and environments", () => {
	it("reads the environment from the key prefix", () => {
		expect(resolveKey({ PADDLE_API_KEY: SANDBOX_KEY })).toEqual({ ok: true, key: SANDBOX_KEY, environment: "sandbox" });
		expect(resolveKey({ PADDLE_API_KEY: LIVE_KEY })).toEqual({ ok: true, key: LIVE_KEY, environment: "live" });
	});

	it("refuses no key and an unknown prefix, without echoing the key", () => {
		expect(resolveKey({})).toMatchObject({ ok: false });
		const odd = resolveKey({ PADDLE_API_KEY: "pdl_other_secretvalue" });
		expect(odd.ok).toBe(false);
		expect(JSON.stringify(odd)).not.toContain("secretvalue");
	});

	it("refuses a live key without --live, and --live with a sandbox key", () => {
		expect(environmentRefusal("live", false)).toMatch(/LIVE/);
		expect(environmentRefusal("sandbox", true)).toMatch(/SANDBOX/);
		expect(environmentRefusal("live", true)).toBeNull();
		expect(environmentRefusal("sandbox", false)).toBeNull();
	});

	it("a live key without --live exits 2 before any Paddle call", async () => {
		let made = false;
		const code = await runSetup(
			["--plan"],
			{ PADDLE_API_KEY: LIVE_KEY },
			() => {
				made = true;
				return fakeClient(emptyAccount());
			},
			(l) => lines.push(l),
		);
		expect(code).toBe(2);
		expect(made).toBe(false);
		expect(lines.join("\n")).not.toContain(LIVE_KEY);
	});

	it("an unknown prefix exits 2, and so does paddle:check", async () => {
		expect(await run(emptyAccount(), ["--plan"], { PADDLE_API_KEY: "sk_test_x" })).toBe(2);
		expect(await runCheckCli([], { PADDLE_API_KEY: "sk_test_x" }, () => fakeClient(emptyAccount()), () => {})).toBe(2);
	});

	it("prints the target environment, never the key", async () => {
		await run(emptyAccount(), ["--plan"]);
		expect(lines[0]).toBe("→ Paddle SANDBOX · https://sandbox-api.paddle.com");
		expect(lines.join("\n")).not.toContain(SANDBOX_KEY);
	});

	it("needs exactly one of --plan or --apply, refuses unknown flags and a non-https webhook URL", async () => {
		expect(await run(emptyAccount(), [])).toBe(2);
		expect(await run(emptyAccount(), ["--plan", "--apply"])).toBe(2);
		expect(await run(emptyAccount(), ["--plan", "--nope"])).toBe(2);
		expect(await run(emptyAccount(), ["--plan", "--webhook-url=http://x"])).toBe(2);
	});
});

describe("computePlan", () => {
	it("on an empty account creates every product and price and nothing else", () => {
		const obs: Observed = { products: new Map(), prices: new Map(), notifications: [], webhookUrl: undefined, manageClientToken: false, clientTokens: [] };
		const plan = computePlan(obs);
		expect(plan.errors).toEqual([]);
		expect(plan.actions.filter((a) => a.kind === "product.create").map((a) => a.summary)).toHaveLength(DESIRED_PRODUCTS.length);
		expect(plan.actions.filter((a) => a.kind === "price.create")).toHaveLength(DESIRED_PRICES.length);
		expect(plan.actions).toHaveLength(DESIRED_PRODUCTS.length + DESIRED_PRICES.length);
	});

	it("plans the notification destination only when a URL is given", () => {
		const obs: Observed = { products: new Map(), prices: new Map(), notifications: [], webhookUrl: URL, manageClientToken: false, clientTokens: [] };
		expect(computePlan(obs).actions.filter((a) => a.kind === "notification.create")).toHaveLength(1);
	});

	it("reports an active price whose key left the catalog as a note, and never touches it", async () => {
		const acct = await converged();
		const pro = activePrice(acct, "alethia_pro_monthly");
		acct.prices.push({ ...pro, id: "pri_old_pack", custom_data: { alethia_key: "alethia_ai_credits_s" } });
		const plan = computePlan(await readState(fakeClient(acct), undefined));
		expect(plan.errors).toEqual([]);
		expect(plan.actions).toEqual([]);
		expect(plan.notes.join("\n")).toMatch(/alethia_ai_credits_s is active \(pri_old_pack\)/);
	});

	it("blocks on two active products with one tag", async () => {
		const acct = await converged();
		const pro = acct.products.find((p) => p.custom_data?.alethia === "pro");
		if (!pro) throw new Error("no pro product");
		acct.products.push({ ...pro, id: "pro_dupe" });
		expect(await run(acct, ["--apply"])).toBe(1);
		expect(acct.writes).toEqual([]);
	});
});

describe("--plan and --apply", () => {
	it("--plan on an empty account writes nothing", async () => {
		const acct = emptyAccount();
		expect(await run(acct, ["--plan"])).toBe(0);
		expect(acct.writes).toEqual([]);
		expect(lines.join("\n")).toMatch(/\+ price alethia_pro_monthly/);
	});

	it("--apply converges, and a plan after it is empty", async () => {
		const acct = await converged();
		expect(await run(acct, ["--plan"])).toBe(0);
		expect(acct.writes).toEqual([]);
		const obs = await readState(fakeClient(acct), undefined);
		const plan = computePlan(obs);
		expect(plan.actions).toEqual([]);
		expect(plan.errors).toEqual([]);
	});

	it("creates prices at the catalog amounts: USD unit price, EUR override for the euro area, monthly plans", async () => {
		const acct = await converged();
		const pro = activePrice(acct, "alethia_pro_monthly");
		expect(pro.unit_price).toEqual({ amount: String(planUnitAmountCents("team")), currency_code: "USD" });
		expect(pro.unit_price_overrides).toEqual([
			{ country_codes: [...EUROZONE_COUNTRIES], unit_price: { amount: String(planUnitAmountCents("team", "eur")), currency_code: "EUR" } },
		]);
		expect(pro.billing_cycle).toEqual({ interval: "month", frequency: 1 });
		expect(pro.quantity).toEqual({ minimum: 1, maximum: 100 });
		expect(pro.custom_data).toMatchObject({ alethia_tax_mode: "account_setting" });
		expect(activePrice(acct, "alethia_ai_max_monthly").unit_price.amount).toBe(String(aiPlanUnitAmountCents("ai_max")));
		const tagged = acct.products.map((p) => p.custom_data?.alethia).sort();
		expect(tagged).toEqual(DESIRED_PRODUCTS.map((d) => d.tag).sort());
		expect(acct.products.every((p) => p.tax_category === "saas")).toBe(true);
	});

	it("prints the env lines with the resulting ids", async () => {
		const acct = emptyAccount();
		await run(acct, ["--apply"]);
		const out = lines.join("\n");
		expect(out).toContain(`PADDLE_PRICE_TEAM=${activePrice(acct, "alethia_pro_monthly").id}`);
		expect(out).toMatch(/PADDLE_PRICE_AI_PLUS=pri_/);
		expect(out).toMatch(/PADDLE_PRICE_AI_MAX=pri_/);
		expect(out).toMatch(/PADDLE_PRODUCT_RUNNER_MINUTES=pro_/);
		expect(out).toMatch(/PADDLE_PRODUCT_AI_CREDITS=pro_/);
		expect(out).not.toMatch(/PADDLE_PRICE_PRO=|PADDLE_PRICE_CREDITS_/);
	});

	it("every env name it prints is one the console's config reads", async () => {
		const acct = await converged();
		const obs = await readState(fakeClient(acct), undefined, true);
		const printed = catalogEnvLines(obs).map((l) => l.split("=")[0]);
		const read = new Set([...Object.values(PADDLE_PRICE_ENV), ...Object.values(PADDLE_PRODUCT_ENV), "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN"]);
		expect(printed.filter((name) => !read.has(name ?? ""))).toEqual([]);
		expect(DESIRED_PRICES.map(priceEnvVar)).toContain("PADDLE_PRICE_TEAM");
	});

	it("replaces a price whose amount drifted: new price first, then the old one archived, never PATCHed", async () => {
		const acct = await converged();
		const old = activePrice(acct, "alethia_pro_monthly");
		old.unit_price = { amount: "1500", currency_code: "USD" };
		expect(await run(acct, ["--apply"])).toBe(0);
		const fresh = activePrice(acct, "alethia_pro_monthly");
		expect(fresh.id).not.toBe(old.id);
		expect(fresh.unit_price.amount).toBe(String(planUnitAmountCents("team")));
		expect(old.status).toBe("archived");
		expect(acct.writes).toEqual([`price.create ${fresh.id}`, `price.archive ${old.id}`]);
	});

	it("replaces a price whose EUR override drifted (amount or countries)", async () => {
		const acct = await converged();
		const old = activePrice(acct, "alethia_ai_plus_monthly");
		old.unit_price_overrides = [{ country_codes: ["DE", "FR"], unit_price: { amount: "1800", currency_code: "EUR" } }];
		const plan = computePlan(await readState(fakeClient(acct), undefined));
		expect(plan.actions).toHaveLength(1);
		expect(plan.actions[0]).toMatchObject({ kind: "price.create", key: "alethia_ai_plus_monthly", replaces: [old.id] });
		expect(plan.actions[0]?.summary).toMatch(/EUR override/);
		expect(await run(acct, ["--apply"])).toBe(0);
		expect(old.status).toBe("archived");
	});

	it("updates a price's name in place (a descriptive field), and archives a duplicate active price", async () => {
		const acct = await converged();
		const p = activePrice(acct, "alethia_ai_max_monthly");
		p.name = "edited in the dashboard";
		acct.prices.push({ ...p, id: "pri_dupe", name: "dupe" });
		expect(await run(acct, ["--apply"])).toBe(0);
		expect(acct.writes.sort()).toEqual([`price.archive pri_dupe`, `price.update ${p.id}`].sort());
	});

	it("treats a price not created as account_setting as drift", async () => {
		const acct = await converged();
		const p = activePrice(acct, "alethia_ai_plus_monthly");
		p.custom_data = { alethia_key: "alethia_ai_plus_monthly" };
		p.tax_mode = "external";
		const plan = computePlan(await readState(fakeClient(acct), undefined));
		expect(plan.actions[0]).toMatchObject({ kind: "price.create", replaces: [p.id] });
	});
});

describe("notification destination", () => {
	it("writes the endpoint secret to a 0600 file and never prints it", async () => {
		const acct = emptyAccount();
		expect(await run(acct, ["--apply", `--webhook-url=${URL}`])).toBe(0);
		const [dest] = acct.notifications;
		if (!dest) throw new Error("no destination");
		const path = join(dir, "secrets", `sandbox-${dest.id}.secret`);
		expect(readFileSync(path, "utf8").trim()).toBe(FAKE_SECRET);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "secrets")).mode & 0o777).toBe(0o700);
		expect(lines.join("\n")).not.toContain(FAKE_SECRET);
		expect(lines.join("\n")).toContain(path);
		expect(dest.subscribed_events.map((e) => e.name)).toEqual([...PADDLE_WEBHOOK_EVENTS]);
	});

	it("sets an existing destination's events to exactly PADDLE_WEBHOOK_EVENTS", async () => {
		const acct = await converged();
		acct.notifications.push({
			id: "ntfset_x",
			type: "url",
			destination: URL,
			active: false,
			subscribed_events: [{ name: "transaction.completed" }, { name: "customer.created" }],
		});
		expect(await run(acct, ["--apply", `--webhook-url=${URL}`])).toBe(0);
		expect(acct.writes).toEqual(["notification.update ntfset_x"]);
		expect(acct.notifications[0]?.subscribed_events.map((e) => e.name)).toEqual([...PADDLE_WEBHOOK_EVENTS]);
		expect(acct.notifications[0]?.active).toBe(true);
	});
});

describe("client-side token", () => {
	it("--client-token creates one token, prints it as NEXT_PUBLIC_PADDLE_CLIENT_TOKEN, and a second apply changes nothing", async () => {
		const acct = await converged();
		expect(await run(acct, ["--apply", "--client-token"])).toBe(0);
		expect(acct.clientTokens).toHaveLength(1);
		expect(acct.clientTokens[0]?.name).toBe(CLIENT_TOKEN_NAME);
		expect(lines.join("\n")).toContain(`NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=${acct.clientTokens[0]?.token}`);
		acct.writes = [];
		expect(await run(acct, ["--apply", "--client-token"])).toBe(0);
		expect(acct.writes).toEqual([]);
	});

	it("is not planned (nor listed) without --client-token", async () => {
		const acct = await converged();
		const client = fakeClient(acct);
		let listed = false;
		const spy: PaddleClient = {
			...client,
			listClientTokens: async () => {
				listed = true;
				return [];
			},
		};
		expect(computePlan(await readState(spy, undefined)).actions).toEqual([]);
		expect(listed).toBe(false);
	});

	it("blocks on two active tokens with the name, and ignores revoked ones", async () => {
		const acct = await converged();
		const base = { name: CLIENT_TOKEN_NAME, description: null };
		acct.clientTokens.push({ ...base, id: "ctkn_a", token: "test_a", status: "revoked" });
		acct.clientTokens.push({ ...base, id: "ctkn_b", token: "test_b", status: "active" });
		expect(computePlan(await readState(fakeClient(acct), undefined, true)).actions).toEqual([]);
		acct.clientTokens.push({ ...base, id: "ctkn_c", token: "test_c", status: "active" });
		expect(await run(acct, ["--apply", "--client-token"])).toBe(1);
		expect(acct.writes).toEqual([]);
	});
});

describe("paddle:check", () => {
	it("exits 0 on a converged account and 1 on an empty one", async () => {
		const acct = await converged();
		expect(await runCheckCli([], { PADDLE_API_KEY: SANDBOX_KEY }, () => fakeClient(acct), (l) => lines.push(l))).toBe(0);
		expect(lines).toContain("matches_catalog: yes");
		expect(await runCheckCli([], { PADDLE_API_KEY: SANDBOX_KEY }, () => fakeClient(emptyAccount()), () => {})).toBe(1);
	});
});

describe("the fetch client", () => {
	it("follows pagination, sends bearer auth to the environment's host, and never puts the key in an error", async () => {
		const calls: { url: string; auth: string | undefined }[] = [];
		const product = { id: "pro_1", name: "A", tax_category: "saas", status: "active", custom_data: null };
		const fetchImpl: FetchLike = async (url, init) => {
			calls.push({ url, auth: init.headers.Authorization });
			if (url.includes("/products") && !url.includes("after=")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						data: [product],
						meta: { pagination: { has_more: true, next: "https://sandbox-api.paddle.com/products?after=pro_1" } },
					}),
				};
			}
			if (url.includes("after=")) {
				return { ok: true, status: 200, json: async () => ({ data: [{ ...product, id: "pro_2" }], meta: { pagination: { has_more: false, next: null } } }) };
			}
			return { ok: false, status: 403, json: async () => ({ error: { code: "forbidden", detail: "no permission" } }) };
		};
		const client = createPaddleClient(SANDBOX_KEY, "sandbox", fetchImpl);
		expect((await client.listProducts()).map((p) => p.id)).toEqual(["pro_1", "pro_2"]);
		expect(calls.every((c) => c.url.startsWith("https://sandbox-api.paddle.com/"))).toBe(true);
		expect(calls[0]?.auth).toBe(`Bearer ${SANDBOX_KEY}`);
		const message = await client.listPrices().then(
			() => "resolved",
			(e: unknown) => (e instanceof Error ? e.message : String(e)),
		);
		expect(message).toMatch(/403 forbidden: no permission/);
		expect(message).not.toContain(SANDBOX_KEY);
	});

	it("refuses a pagination link off the API's origin", async () => {
		const fetchImpl: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [], meta: { pagination: { has_more: true, next: "https://evil.example/products" } } }),
		});
		await expect(createPaddleClient(SANDBOX_KEY, "sandbox", fetchImpl).listProducts()).rejects.toThrow(/origin/);
	});
});

describe("pinned constants", () => {
	it("PADDLE_WEBHOOK_EVENTS is exactly the handled set", () => {
		expect([...PADDLE_WEBHOOK_EVENTS]).toEqual([
			"subscription.created",
			"subscription.activated",
			"subscription.updated",
			"subscription.trialing",
			"subscription.past_due",
			"subscription.paused",
			"subscription.resumed",
			"subscription.canceled",
			"transaction.billed",
			"transaction.paid",
			"transaction.past_due",
			"transaction.completed",
			"transaction.payment_failed",
			"adjustment.created",
			"adjustment.updated",
		]);
	});

	it("EUROZONE_COUNTRIES is the 2026 euro area (21 members, Bulgaria and Croatia included)", () => {
		expect(EUROZONE_COUNTRIES).toHaveLength(21);
		expect(new Set(EUROZONE_COUNTRIES).size).toBe(21);
		expect(EUROZONE_COUNTRIES).toEqual(expect.arrayContaining(["BG", "HR", "DE", "FR"]));
		expect(EUROZONE_COUNTRIES).not.toContain("PL");
	});

	it("catalog amounts equal @repo/plan-catalog", () => {
		const byKey = new Map(DESIRED_PRICES.map((d) => [d.key, d]));
		expect(byKey.get("alethia_pro_monthly")).toMatchObject({ usd: planUnitAmountCents("team"), eur: planUnitAmountCents("team", "eur") });
		expect(byKey.get("alethia_ai_plus_monthly")).toMatchObject({
			usd: aiPlanUnitAmountCents("ai_plus"),
			eur: aiPlanUnitAmountCents("ai_plus", "eur"),
		});
		expect(byKey.get("alethia_ai_max_monthly")).toMatchObject({
			usd: aiPlanUnitAmountCents("ai_max"),
			eur: aiPlanUnitAmountCents("ai_max", "eur"),
		});
		// Credit packs are non-catalog lines on PADDLE_PRODUCT_AI_CREDITS (lib/billing/paddle/checkout.ts).
		expect(DESIRED_PRICES).toHaveLength(3);
	});
});
