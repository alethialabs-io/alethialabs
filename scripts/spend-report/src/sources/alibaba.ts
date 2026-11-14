// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHmac, randomUUID } from "node:crypto";
import { sortItems } from "../aggregate";
import type { ReportWindow } from "../dates";
import { fetchJson, isRecord, num, providerMessage } from "../exec";
import type { CloudResult, LineItem } from "../types";

/**
 * Alibaba month-to-date spend from the BSS OpenAPI `QueryBillOverview`, attempted with the EXISTING
 * e2e RAM role (infra/alibaba-e2e) and nothing new. Today that is expected to report "not readable",
 * for two independent reasons the email names as it meets them:
 *
 *   1. the role's trust admits `repo:<repo>:ref:refs/heads/main` (and the e2e-dev environment), and
 *      the spend-report job presents `…:environment:spend-report` — so AssumeRoleWithOIDC refuses it;
 *   2. the role's policy (alethia-e2e … -provision) grants no `bss:*`.
 *
 * Both are left as they are on purpose: widening an ACK-provisioning role's trust to a reporting job
 * would be the wrong trade, and the brief was to read Alibaba only if the e2e role already can.
 */

/** RFC 3986 percent-encoding as Alibaba's RPC signature defines it (`~` unescaped, space as %20). */
export function percentEncode(s: string): string {
	return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Signs an Alibaba RPC request (signature version 1.0, HMAC-SHA1). Returns the Signature value. */
export function signRpc(method: "GET" | "POST", params: Record<string, string>, accessKeySecret: string): string {
	const canonical = Object.keys(params)
		.sort()
		.map((k) => `${percentEncode(k)}=${percentEncode(params[k] ?? "")}`)
		.join("&");
	const stringToSign = `${method}&${percentEncode("/")}&${percentEncode(canonical)}`;
	return createHmac("sha1", `${accessKeySecret}&`).update(stringToSign).digest("base64");
}

/** Parses QueryBillOverview into per-product line items and a total. */
export function parseBillOverview(body: unknown): { currency: string | null; total: number; items: LineItem[] } {
	const data = isRecord(body) && isRecord(body.Data) ? body.Data : null;
	const list = data && isRecord(data.Items) && Array.isArray(data.Items.Item) ? data.Items.Item : [];
	const byProduct = new Map<string, number>();
	let currency: string | null = null;
	let total = 0;
	for (const it of list) {
		if (!isRecord(it)) continue;
		const amount = num(it.PretaxAmount) ?? num(it.PaymentAmount);
		if (amount === null) continue;
		if (typeof it.Currency === "string" && it.Currency !== "") currency = it.Currency;
		const label = typeof it.ProductName === "string" && it.ProductName ? it.ProductName : String(it.ProductCode ?? "?");
		byProduct.set(label, (byProduct.get(label) ?? 0) + amount);
		total += amount;
	}
	return { currency, total, items: sortItems([...byProduct].map(([label, amount]) => ({ label, amount }))) };
}

/** Alibaba read configuration. */
export interface AlibabaConfig {
	roleArn: string;
	oidcProviderArn: string;
	/** BSS endpoint; international accounts use business.ap-southeast-1.aliyuncs.com. */
	bssEndpoint: string;
	/** The Actions runtime's OIDC request URL + bearer (present when the job has id-token: write). */
	oidcRequestUrl: string | undefined;
	oidcRequestToken: string | undefined;
}

/** Requests a GitHub OIDC token for `audience` from the Actions runtime. */
async function githubOidcToken(audience: string, url: string | undefined, bearer: string | undefined): Promise<string> {
	if (!url || !bearer) throw new Error("no GitHub OIDC token available (not running in Actions with id-token: write)");
	const body = await fetchJson(`${url}&audience=${encodeURIComponent(audience)}`, { headers: { authorization: `Bearer ${bearer}` } });
	if (!isRecord(body) || typeof body.value !== "string") throw new Error("GitHub OIDC token response had no value");
	return body.value;
}

/** The ISO timestamp format the RPC APIs require (no milliseconds). */
function rpcTimestamp(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Reads Alibaba. Never throws. */
export async function readAlibaba(w: ReportWindow, cfg: AlibabaConfig): Promise<CloudResult> {
	if (!cfg.roleArn || !cfg.oidcProviderArn) {
		return { cloud: "alibaba", status: "unreadable", reason: "E2E_ALIBABA_ROLE_ARN / E2E_ALIBABA_OIDC_PROVIDER_ARN are unset" };
	}
	let creds: { id: string; secret: string; token: string };
	try {
		const oidc = await githubOidcToken("sts.aliyuncs.com", cfg.oidcRequestUrl, cfg.oidcRequestToken);
		const form = new URLSearchParams({
			Action: "AssumeRoleWithOIDC",
			Format: "JSON",
			Version: "2015-04-01",
			Timestamp: rpcTimestamp(),
			RoleArn: cfg.roleArn,
			OIDCProviderArn: cfg.oidcProviderArn,
			OIDCToken: oidc,
			RoleSessionName: "spend-report",
			DurationSeconds: "900",
		});
		const res = await fetch("https://sts.aliyuncs.com/", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form.toString(),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await res.text();
		if (!res.ok) {
			return {
				cloud: "alibaba",
				status: "unreadable",
				reason: `the e2e RAM role refused this job (${providerMessage(text)}). Its trust admits the main-branch ref subject, not the spend-report environment — expected; see scripts/spend-report/README.md.`,
			};
		}
		const j: unknown = JSON.parse(text);
		const c = isRecord(j) && isRecord(j.Credentials) ? j.Credentials : null;
		if (!c || typeof c.AccessKeyId !== "string" || typeof c.AccessKeySecret !== "string" || typeof c.SecurityToken !== "string") {
			throw new Error("AssumeRoleWithOIDC returned no credentials");
		}
		creds = { id: c.AccessKeyId, secret: c.AccessKeySecret, token: c.SecurityToken };
	} catch (err) {
		return { cloud: "alibaba", status: "unreadable", reason: err instanceof Error ? err.message : String(err) };
	}
	try {
		const params: Record<string, string> = {
			Action: "QueryBillOverview",
			Format: "JSON",
			Version: "2017-12-14",
			AccessKeyId: creds.id,
			SecurityToken: creds.token,
			SignatureMethod: "HMAC-SHA1",
			SignatureVersion: "1.0",
			SignatureNonce: randomUUID(),
			Timestamp: rpcTimestamp(),
			BillingCycle: w.billingMonth,
		};
		params.Signature = signRpc("GET", params, creds.secret);
		const qs = Object.entries(params)
			.map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
			.join("&");
		const res = await fetch(`https://${cfg.bssEndpoint}/?${qs}`, { signal: AbortSignal.timeout(30_000) });
		const text = await res.text();
		if (!res.ok) {
			return {
				cloud: "alibaba",
				status: "unreadable",
				reason: `BSS QueryBillOverview refused (${providerMessage(text)}) — the e2e role holds no bss:* read.`,
			};
		}
		const bill = parseBillOverview(JSON.parse(text));
		return {
			cloud: "alibaba",
			status: "ok",
			currency: bill.currency ?? "USD",
			last7: null,
			prior7: null,
			mtd: bill.total,
			estimate: false,
			lineItemBasis: "mtd",
			lineItems: bill.items,
			breakdowns: [],
			notes: ["BSS bills by month: month-to-date only, no 7-day or week-on-week figure."],
		};
	} catch (err) {
		return { cloud: "alibaba", status: "unreadable", reason: err instanceof Error ? err.message : String(err) };
	}
}
