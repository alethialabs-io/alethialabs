// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sortItems } from "../aggregate";
import { fetchJson, isRecord, num } from "../exec";
import { hcloudLeaks, type HcloudLabelled } from "../leaks";
import type { CloudResult, Leak, LeakResult, LineItem } from "../types";

/**
 * Hetzner has no billing API, so this is an ESTIMATE and says so everywhere it appears: every
 * resource that exists RIGHT NOW in the project the token belongs to, priced from the project's own
 * `GET /pricing` list prices (net, excl. VAT). Seven days is `min(hourly × 168, monthly)` — Hetzner
 * bills hourly up to a monthly cap. Anything created and deleted during the week is invisible, and
 * traffic overage is not counted.
 */
const API = "https://api.hetzner.cloud/v1";

/** A price pair as the pricing endpoint returns it: decimal strings, net and gross. */
interface PricePair {
	net?: string;
	gross?: string;
}

/** Reads the `net` of a price pair. */
function net(p: unknown): number | null {
	return isRecord(p) ? num((p as PricePair).net) : null;
}

/** The location a resource lives in — the API has carried it as `location`, `datacenter.location` and `home_location`. */
export function hcloudLocation(r: Record<string, unknown>): string | null {
	for (const v of [r.location, isRecord(r.datacenter) ? r.datacenter.location : undefined, r.home_location]) {
		if (isRecord(v) && typeof v.name === "string") return v.name;
		if (typeof v === "string") return v;
	}
	return null;
}

/** Finds the hourly + monthly net price for a location in a `prices[]` list. */
function priceAt(prices: unknown, location: string | null): { hourly: number | null; monthly: number | null } | null {
	if (!Array.isArray(prices)) return null;
	const p = prices.find((x) => isRecord(x) && (x.location === location || x.datacenter === location)) ?? (prices.length === 1 ? prices[0] : undefined);
	if (!isRecord(p)) return null;
	return { hourly: net(p.price_hourly), monthly: net(p.price_monthly) };
}

/** Seven days of a resource billed hourly with a monthly cap. */
export function sevenDays(hourly: number | null, monthly: number | null): number | null {
	if (hourly !== null && monthly !== null) return Math.min(hourly * 168, monthly);
	if (monthly !== null) return (monthly * 7) / 30;
	if (hourly !== null) return hourly * 168;
	return null;
}

/** Everything that currently exists in the project, as the list endpoints return it. */
export interface HcloudInventory {
	servers: Record<string, unknown>[];
	volumes: Record<string, unknown>[];
	primaryIps: Record<string, unknown>[];
	floatingIps: Record<string, unknown>[];
	loadBalancers: Record<string, unknown>[];
	snapshots: Record<string, unknown>[];
}

/** The estimate: per-resource 7-day and monthly figures, and what could not be priced. */
export interface HcloudEstimate {
	currency: string;
	weekly: number;
	monthly: number;
	lineItems: LineItem[];
	unpriced: string[];
}

/** Prices an inventory against a `GET /pricing` response. Pure. */
export function estimateHcloud(pricingResponse: unknown, inv: HcloudInventory): HcloudEstimate {
	const pricing = isRecord(pricingResponse) && isRecord(pricingResponse.pricing) ? pricingResponse.pricing : null;
	if (!pricing) throw new Error("hcloud /pricing returned no pricing object");
	const currency = typeof pricing.currency === "string" ? pricing.currency : "EUR";
	const items: LineItem[] = [];
	const unpriced: string[] = [];
	let weekly = 0;
	let monthly = 0;
	/** Adds one priced resource, or records it as unpriced. */
	const add = (label: string, wk: number | null, mo: number | null) => {
		if (wk === null) {
			unpriced.push(label);
			return;
		}
		weekly += wk;
		monthly += mo ?? (wk * 30) / 7;
		items.push({ label, amount: wk });
	};
	const typeList = (k: string): Record<string, unknown>[] => (Array.isArray(pricing[k]) ? (pricing[k] as unknown[]).filter(isRecord) : []);
	const backupPct = isRecord(pricing.server_backup) ? (num(pricing.server_backup.percentage) ?? 0) : 0;

	for (const s of inv.servers) {
		const type = isRecord(s.server_type) && typeof s.server_type.name === "string" ? s.server_type.name : "?";
		const loc = hcloudLocation(s);
		const p = priceAt(typeList("server_types").find((t) => t.name === type)?.prices, loc);
		let wk = p ? sevenDays(p.hourly, p.monthly) : null;
		let mo = p?.monthly ?? null;
		const backups = s.backup_window !== null && s.backup_window !== undefined;
		if (backups && wk !== null) {
			wk *= 1 + backupPct / 100;
			if (mo !== null) mo *= 1 + backupPct / 100;
		}
		add(`server ${String(s.name ?? s.id)} (${type}, ${loc ?? "?"}${backups ? ", backups" : ""})`, wk, mo);
	}
	const perGb = isRecord(pricing.volume) ? net(pricing.volume.price_per_gb_month) : null;
	for (const v of inv.volumes) {
		const size = num(v.size);
		const mo = perGb !== null && size !== null ? perGb * size : null;
		add(`volume ${String(v.name ?? v.id)} (${size ?? "?"} GB)`, mo === null ? null : (mo * 7) / 30, mo);
	}
	for (const ip of inv.primaryIps) {
		const type = typeof ip.type === "string" ? ip.type : "ipv4";
		const loc = hcloudLocation(ip);
		const p = priceAt(typeList("primary_ips").find((t) => t.type === type)?.prices, loc);
		add(`primary IP ${String(ip.name ?? ip.id)} (${type}${ip.assignee_id ? "" : ", UNASSIGNED"})`, p ? sevenDays(p.hourly, p.monthly) : null, p?.monthly ?? null);
	}
	for (const ip of inv.floatingIps) {
		const type = typeof ip.type === "string" ? ip.type : "ipv4";
		const loc = hcloudLocation(ip);
		const p = priceAt(typeList("floating_ips").find((t) => t.type === type)?.prices, loc);
		add(`floating IP ${String(ip.name ?? ip.id)} (${type})`, p ? sevenDays(p.hourly, p.monthly) : null, p?.monthly ?? null);
	}
	for (const lb of inv.loadBalancers) {
		const type = isRecord(lb.load_balancer_type) && typeof lb.load_balancer_type.name === "string" ? lb.load_balancer_type.name : "?";
		const loc = hcloudLocation(lb);
		const p = priceAt(typeList("load_balancer_types").find((t) => t.name === type)?.prices, loc);
		add(`load balancer ${String(lb.name ?? lb.id)} (${type}, ${loc ?? "?"})`, p ? sevenDays(p.hourly, p.monthly) : null, p?.monthly ?? null);
	}
	const imgGb = isRecord(pricing.image) ? net(pricing.image.price_per_gb_month) : null;
	for (const img of inv.snapshots) {
		const size = num(img.image_size);
		const mo = imgGb !== null && size !== null ? imgGb * size : null;
		add(`snapshot ${String(img.description || img.id)} (${size === null ? "?" : size.toFixed(1)} GB)`, mo === null ? null : (mo * 7) / 30, mo);
	}
	return { currency, weekly, monthly, lineItems: sortItems(items), unpriced };
}

/** Fetches every page of one hcloud list endpoint. */
async function listAll(token: string, path: string, key: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for (let page = 1; page <= 50; page++) {
		const sep = path.includes("?") ? "&" : "?";
		const body = await fetchJson(`${API}${path}${sep}page=${page}&per_page=50`, { headers: { authorization: `Bearer ${token}` } });
		if (!isRecord(body)) break;
		const items = body[key];
		if (Array.isArray(items)) out.push(...items.filter(isRecord));
		const pag = isRecord(body.meta) && isRecord(body.meta.pagination) ? body.meta.pagination : null;
		if (!pag || pag.next_page === null || pag.next_page === undefined) break;
	}
	return out;
}

/** Reads the inventory once; both the estimate and the leak scan use it. */
export async function readHcloudInventory(token: string): Promise<HcloudInventory> {
	const [servers, volumes, primaryIps, floatingIps, loadBalancers, snapshots] = await Promise.all([
		listAll(token, "/servers", "servers"),
		listAll(token, "/volumes", "volumes"),
		listAll(token, "/primary_ips", "primary_ips"),
		listAll(token, "/floating_ips", "floating_ips"),
		listAll(token, "/load_balancers", "load_balancers"),
		listAll(token, "/images?type=snapshot", "images"),
	]);
	return { servers, volumes, primaryIps, floatingIps, loadBalancers, snapshots };
}

/** Every resource in the inventory carrying an e2e label handle. */
export function hcloudInventoryLeaks(inv: HcloudInventory): Leak[] {
	const asLabelled = (xs: Record<string, unknown>[]): HcloudLabelled[] =>
		xs.flatMap((x) => {
			const id = x.id;
			if (typeof id !== "number" && typeof id !== "string") return [];
			const labels: Record<string, string> = {};
			if (isRecord(x.labels)) for (const [k, v] of Object.entries(x.labels)) if (typeof v === "string") labels[k] = v;
			return [{ id, name: typeof x.name === "string" ? x.name : undefined, labels }];
		});
	return [
		...hcloudLeaks("server", asLabelled(inv.servers)),
		...hcloudLeaks("volume", asLabelled(inv.volumes)),
		...hcloudLeaks("primary_ip", asLabelled(inv.primaryIps)),
		...hcloudLeaks("floating_ip", asLabelled(inv.floatingIps)),
		...hcloudLeaks("load_balancer", asLabelled(inv.loadBalancers)),
		...hcloudLeaks("image", asLabelled(inv.snapshots)),
	];
}

/** Reads the Hetzner estimate and leak list. Never throws. */
export async function readHetzner(token: string | undefined): Promise<{ result: CloudResult; leaks: LeakResult }> {
	if (!token) {
		const reason = "HCLOUD_TOKEN (repo secret) is unset";
		return { result: { cloud: "hetzner", status: "unreadable", reason }, leaks: { cloud: "hetzner", status: "unreadable", reason } };
	}
	try {
		const [pricing, inv] = await Promise.all([fetchJson(`${API}/pricing`, { headers: { authorization: `Bearer ${token}` } }), readHcloudInventory(token)]);
		const est = estimateHcloud(pricing, inv);
		const notes = [
			`ESTIMATE from list prices (net, excl. VAT) of the ${est.lineItems.length + est.unpriced.length} resource(s) that exist now in the project HCLOUD_TOKEN belongs to (the e2e project). Monthly run-rate: ${est.currency} ${est.monthly.toFixed(2)}. Traffic and anything created and deleted during the week are not counted.`,
		];
		if (est.unpriced.length > 0) notes.push(`Not priced (no list price matched): ${est.unpriced.join("; ")}.`);
		return {
			result: {
				cloud: "hetzner",
				status: "ok",
				currency: est.currency,
				last7: est.weekly,
				prior7: null,
				mtd: null,
				estimate: true,
				lineItemBasis: "est-7d",
				lineItems: est.lineItems,
				breakdowns: [],
				notes,
			},
			leaks: { cloud: "hetzner", status: "ok", leaks: hcloudInventoryLeaks(inv), scope: "labels on servers, volumes, IPs, load balancers, snapshots" },
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { result: { cloud: "hetzner", status: "unreadable", reason }, leaks: { cloud: "hetzner", status: "unreadable", reason } };
	}
}
