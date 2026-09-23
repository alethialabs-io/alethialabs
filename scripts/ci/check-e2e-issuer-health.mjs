#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Is the E2E assertion issuer (apps/e2e-issuer) healthy AS THE THING FOUR CLOUDS TRUST?
//
// WHY THIS EXISTS (#4226, maintainer ruling 2026-09-23). Four cloud trust stacks pin the issuer's
// origin byte for byte, and Alibaba additionally pins the SHA-1 fingerprints of the CA certificates
// in its TLS chain. Every way that trust breaks is SILENT until the nightly federates and is refused:
// the Worker is redeployed at another origin, the JWKS stops parsing, a key is never rotated, or
// Cloudflare re-issues the host's certificate from a different CA or intermediate — which it may do
// at any time and which no file in this repository records. So this asks, on a schedule, the
// questions the clouds will ask, and says which one failed.
//
// MODES
//
//   --expected-url <url>   LIVE. Every check below against the running issuer. Markdown report on
//                          stdout. Exit 0 healthy · 2 unhealthy (findings) · 1 BLIND — the instrument
//                          itself could not look (bad arguments, an unreadable pin file, no openssl).
//                          "Could not look" is never rendered as "fine", and an issuer that does not
//                          answer is a FINDING (2), not blindness: it is exactly what is watched.
//     --checks a,b         restrict to named checks (the deploy workflow's post-deploy probe uses
//                          config,discovery,jwks — the TLS pin, key age and latency are the schedule's)
//     --retry-seconds N    re-probe discovery until it answers or N seconds pass (a fresh deploy or a
//                          fresh custom-domain certificate takes a moment to serve)
//   --preflight --expected-url <url>
//                          BEFORE a deploy: refuse to deploy unless the origin is the committed one,
//                          is not a workers.dev origin while wrangler.jsonc disables workers.dev, and
//                          already routes to this Worker. Exit 0 go · 1 no-go, with the reason.
//   --static               HERMETIC. The committed copies of the issuer origin agree: the stack's
//                          hostname, tls-ca-pin.json, and the four trust stacks' e2e_broker_issuer_url.
//                          And tls-ca-pin.json is well formed. Exit 0 · 1.
//   --print-pin --expected-url <url>
//                          Read the live served chain and print a tls-ca-pin.json for REVIEW. It never
//                          writes the file: the pin is a trust decision and lands in a reviewed PR.
//   --self-test            Every check goes red on a fixture built to trip it, the healthy fixture is
//                          green, and the fingerprint matches `openssl x509 -fingerprint -sha1`.
//
// Plain node, no dependencies: it runs before `pnpm install` in the scheduled job.

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Repository paths this reads. One list, so the blindness guard can name each. */
export const PATHS = {
	stackTfvars: "infra/e2e-issuer/terraform.tfvars",
	pin: "infra/e2e-issuer/tls-ca-pin.json",
	wrangler: "apps/e2e-issuer/wrangler.jsonc",
	trustTfvars: [
		"infra/aws-oidc/terraform.tfvars",
		"infra/gcp-e2e/terraform.tfvars",
		"infra/azure-e2e/terraform.tfvars",
		"infra/alibaba-e2e/terraform.tfvars",
	],
};

/** Every live check, in report order. */
export const CHECKS = ["config", "discovery", "jwks", "keys", "tls-pin", "latency"];

/** Alibaba RAM accepts at most five OIDC provider fingerprints (RAM docs, "Manage an OIDC IdP"). */
export const MAX_PIN = 5;

/** Thresholds. Named so the report can quote them. */
export const LIMITS = {
	/** Median of three discovery GETs. The clouds' own fetch timeouts are ~5s; half that is a warning sign. */
	latencyMs: 2500,
	/**
	 * The newest published key is older than this → rotate. The README's rotation takes two days of
	 * waits, so a year leaves ample runway; the point is that "never rotated" becomes visible.
	 */
	maxKeyAgeDays: 365,
	/** Cloudflare renews edge certificates well before expiry; under this, renewal is stuck (a CAA refusal looks exactly like this). */
	minLeafDaysLeft: 14,
};

/** RFC 7517/7518 private-key members. Any of them in the PUBLIC JWKS is a key leak. */
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

// ── small readers ───────────────────────────────────────────────────────────────────────────────

/** Whether `url` is a bare lowercase https origin: no path, port, query, fragment or trailing slash. */
export function isBareOrigin(url) {
	return typeof url === "string" && /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(url);
}

/**
 * Read exactly ONE `key = "value"` (or `key = null`) assignment from a tfvars text. Zero or several
 * matches throw: a reader that stops matching must not report "agrees" by comparing nothing.
 * @returns {string|null}
 */
export function readTfvar(text, key, file) {
	const re = new RegExp(`^\\s*${key}\\s*=\\s*(null|"([^"]*)")\\s*(#.*)?$`, "gm");
	const hits = [...text.matchAll(re)];
	if (hits.length !== 1) throw new Error(`${file}: expected exactly one \`${key} = ...\` line, found ${hits.length}`);
	return hits[0][1] === "null" ? null : hits[0][2];
}

/** Read wrangler.jsonc's top-level `workers_dev` (exactly one), as a boolean. */
export function readWorkersDev(text) {
	const hits = [...text.matchAll(/^\s*"workers_dev"\s*:\s*(true|false)\s*,?\s*$/gm)];
	if (hits.length !== 1) throw new Error(`${PATHS.wrangler}: expected exactly one "workers_dev": true|false, found ${hits.length}`);
	return hits[0][1] === "true";
}

/**
 * Parse and validate tls-ca-pin.json. Throws on anything malformed — a pin the instrument cannot
 * read is blindness, never "nothing pinned".
 * @returns {{issuer_url: string, algorithm: string, fingerprints: {sha1: string, subject?: string}[]}}
 */
export function parsePin(text) {
	const pin = JSON.parse(text);
	if (!pin || typeof pin !== "object") throw new Error("pin: not an object");
	if (!isBareOrigin(pin.issuer_url)) throw new Error(`pin: issuer_url must be a bare https origin, got ${JSON.stringify(pin.issuer_url)}`);
	if (pin.algorithm !== "sha1") throw new Error(`pin: algorithm must be "sha1" (what Alibaba RAM pins), got ${JSON.stringify(pin.algorithm)}`);
	if (!Array.isArray(pin.fingerprints)) throw new Error("pin: fingerprints must be an array");
	if (pin.fingerprints.length > MAX_PIN) throw new Error(`pin: ${pin.fingerprints.length} fingerprints — Alibaba RAM accepts at most ${MAX_PIN}`);
	const seen = new Set();
	for (const f of pin.fingerprints) {
		if (!f || typeof f.sha1 !== "string" || !/^[0-9a-f]{40}$/.test(f.sha1)) {
			throw new Error(`pin: every fingerprint needs a 40-char lowercase hex sha1, got ${JSON.stringify(f)}`);
		}
		if (seen.has(f.sha1)) throw new Error(`pin: duplicate fingerprint ${f.sha1}`);
		seen.add(f.sha1);
	}
	return pin;
}

/** Read a repository file relative to the root. */
function readRepo(rel, root = ROOT) {
	return fs.readFileSync(path.join(root, rel), "utf8");
}

/** The committed issuer origin: https:// + infra/e2e-issuer's hostname. */
export function committedIssuerUrl(root = ROOT) {
	const host = readTfvar(readRepo(PATHS.stackTfvars, root), "hostname", PATHS.stackTfvars);
	if (host === null) throw new Error(`${PATHS.stackTfvars}: hostname is null`);
	return `https://${host}`;
}

// ── STATIC: the committed copies agree ──────────────────────────────────────────────────────────

/**
 * Compare every committed copy of the issuer origin. Pure over a `read(rel)` function so the
 * self-test can feed it mutated files.
 * @param {(rel: string) => string} read
 * @returns {string[]} problems; empty = agree
 */
export function staticProblems(read) {
	const problems = [];
	const host = readTfvar(read(PATHS.stackTfvars), "hostname", PATHS.stackTfvars);
	const url = host === null ? null : `https://${host}`;
	if (!isBareOrigin(url)) problems.push(`${PATHS.stackTfvars}: hostname must make a bare https origin, got ${JSON.stringify(url)}`);
	const pin = parsePin(read(PATHS.pin));
	if (pin.issuer_url !== url) problems.push(`${PATHS.pin}: issuer_url is ${pin.issuer_url}, the stack serves ${url}`);
	for (const file of PATHS.trustTfvars) {
		const v = readTfvar(read(file), "e2e_broker_issuer_url", file);
		// null is the deliberate "trust off" posture and is allowed; any other value must be THIS origin.
		if (v !== null && v !== url) problems.push(`${file}: e2e_broker_issuer_url is ${v}, the stack serves ${url}`);
	}
	return problems;
}

// ── LIVE: observe, then evaluate ────────────────────────────────────────────────────────────────

/**
 * Parse the PEM blocks `openssl s_client -showcerts` printed, IN SERVED ORDER (leaf first).
 * @returns {{sha1: string, ca: boolean, subject: string, issuer: string, validTo: string}[]}
 */
export function parseChain(text) {
	const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
	return blocks.map((pem) => {
		const cert = new crypto.X509Certificate(pem);
		return {
			// SHA-1 over the DER certificate, lowercase, no colons — the same bytes Alibaba's documented
			// `openssl x509 -fingerprint -sha1` procedure hashes, and hashicorp/tls's sha1_fingerprint.
			sha1: cert.fingerprint.replaceAll(":", "").toLowerCase(),
			ca: cert.ca,
			subject: cert.subject.replaceAll("\n", ", "),
			issuer: cert.issuer.replaceAll("\n", ", "),
			validTo: cert.validTo,
		};
	});
}

/** Read the served chain for `host`. Throws when openssl is absent (blind), returns [] when nothing was served. */
function readChain(host) {
	const r = spawnSync("openssl", ["s_client", "-connect", `${host}:443`, "-servername", host, "-showcerts"], {
		input: "",
		encoding: "utf8",
		timeout: 20000,
	});
	if (r.error && r.error.code === "ENOENT") throw new Error("openssl is not on PATH — the TLS pin cannot be read");
	return parseChain(r.stdout ?? "");
}

/** One timed GET. Never throws: a failure is an observation. */
async function timedGet(url) {
	const started = performance.now();
	try {
		const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { accept: "application/json" } });
		const body = await res.text();
		return { status: res.status, body, ms: Math.round(performance.now() - started) };
	} catch (err) {
		return { status: 0, body: "", ms: Math.round(performance.now() - started), error: String(err?.cause?.code ?? err?.message ?? err) };
	}
}

/** Collect everything the checks read from the live issuer. */
async function observe(url, { checks, retrySeconds }) {
	const deadline = Date.now() + retrySeconds * 1000;
	// Settled = 200 AND naming this origin: right after a deploy the previous version can still answer
	// 200 as another issuer for a moment, and that is not yet a finding worth failing on.
	const settled = (d) => {
		try {
			return d.status === 200 && JSON.parse(d.body).issuer === url;
		} catch {
			return false;
		}
	};
	let discovery = await timedGet(`${url}/.well-known/openid-configuration`);
	while (!settled(discovery) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10000));
		discovery = await timedGet(`${url}/.well-known/openid-configuration`);
	}
	const obs = { discovery, jwks: null, chain: null, latencySamples: [] };
	let jwksUri = null;
	try {
		jwksUri = JSON.parse(discovery.body).jwks_uri ?? null;
	} catch {
		// reported by the discovery check
	}
	if (typeof jwksUri === "string" && /^https:\/\//.test(jwksUri)) obs.jwks = await timedGet(jwksUri);
	if (checks.includes("tls-pin")) obs.chain = readChain(new URL(url).host);
	if (checks.includes("latency")) {
		obs.latencySamples.push(discovery.ms);
		for (let i = 0; i < 2; i++) obs.latencySamples.push((await timedGet(`${url}/.well-known/openid-configuration`)).ms);
	}
	return obs;
}

/** Median of a non-empty numeric list. */
function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

/**
 * The verdict. PURE: every input is passed in, so the self-test can trip each check.
 *
 * @param {object} obs      what observe() collected
 * @param {object} cfg
 * @param {string} cfg.expectedUrl    the origin the issuer is configured at (vars.E2E_ISSUER_URL)
 * @param {string} cfg.committedUrl   the origin infra/e2e-issuer serves
 * @param {object} cfg.pin            parsed tls-ca-pin.json
 * @param {string[]} cfg.checks       which checks to run
 * @param {Date} cfg.now
 * @returns {{check: string, detail: string}[]} findings; empty = healthy
 */
export function evaluate(obs, cfg) {
	const findings = [];
	const add = (check, detail) => findings.push({ check, detail });
	const on = (c) => cfg.checks.includes(c);
	const url = cfg.expectedUrl;

	if (on("config")) {
		if (!isBareOrigin(url)) add("config", `E2E_ISSUER_URL must be a bare https origin — got ${JSON.stringify(url)}`);
		if (url !== cfg.committedUrl) {
			add("config", `E2E_ISSUER_URL is ${url}, but infra/e2e-issuer serves ${cfg.committedUrl} and the four trust stacks pin that. Finish the migration runbook (infra/e2e-issuer/README.md).`);
		}
	}

	let discovery = null;
	if (on("discovery") || on("jwks") || on("keys")) {
		const d = obs.discovery;
		if (d.status !== 200) {
			add("discovery", `${url}/.well-known/openid-configuration answered ${d.status || `nothing (${d.error ?? "no response"})`}${d.body ? `: ${d.body.slice(0, 200)}` : ""}`);
		} else {
			try {
				discovery = JSON.parse(d.body);
			} catch {
				add("discovery", "discovery is not JSON");
			}
		}
		if (discovery && on("discovery")) {
			if (discovery.issuer !== url) add("discovery", `discovery says issuer = ${JSON.stringify(discovery.issuer)}; every cloud compares \`iss\` with ${url} byte for byte`);
			if (discovery.jwks_uri !== `${url}/.well-known/jwks.json`) add("discovery", `discovery jwks_uri = ${JSON.stringify(discovery.jwks_uri)}, expected ${url}/.well-known/jwks.json`);
			if (!Array.isArray(discovery.id_token_signing_alg_values_supported) || !discovery.id_token_signing_alg_values_supported.includes("RS256")) {
				add("discovery", "discovery does not advertise RS256 in id_token_signing_alg_values_supported");
			}
		}
	}

	let keys = null;
	if (discovery && (on("jwks") || on("keys"))) {
		const j = obs.jwks;
		if (!j) add("jwks", `discovery's jwks_uri ${JSON.stringify(discovery.jwks_uri)} was not fetched (not an https URL)`);
		else if (j.status !== 200) add("jwks", `${discovery.jwks_uri} answered ${j.status || `nothing (${j.error ?? "no response"})`}`);
		else {
			try {
				const parsed = JSON.parse(j.body);
				if (!Array.isArray(parsed.keys)) add("jwks", "the JWKS has no `keys` array");
				else keys = parsed.keys;
			} catch {
				add("jwks", "the JWKS is not JSON");
			}
		}
	}

	if (keys && on("jwks")) {
		const leaked = keys.filter((k) => PRIVATE_JWK_MEMBERS.some((m) => k && m in k)).map((k) => k.kid);
		if (leaked.length) add("jwks", `PRIVATE KEY MATERIAL is published for kid(s) ${JSON.stringify(leaked)} — rotate those keys now`);
		const usable = keys.filter(
			(k) => k && k.kty === "RSA" && k.alg === "RS256" && (k.use === undefined || k.use === "sig") && typeof k.kid === "string" && k.kid && typeof k.n === "string" && k.n && typeof k.e === "string" && k.e,
		);
		if (usable.length === 0) add("jwks", `the JWKS carries no usable RS256 signing key (kty RSA, alg RS256, use sig, kid, n, e) — ${keys.length} key(s) published`);
		const kids = keys.map((k) => k?.kid);
		if (new Set(kids).size !== kids.length) add("jwks", `duplicate kid in the JWKS: ${JSON.stringify(kids)} — a verifier cannot tell the keys apart`);
	}

	if (keys && on("keys")) {
		// The Worker's JWKS does not say which key is ACTIVE (activeKid is private). The README's
		// convention names each key by the month it was minted (`YYYY-MM`), so the NEWEST kid bounds the
		// active key's age from above: a staged key is newer than the active one, never older.
		const dated = [];
		for (const k of keys) {
			const m = /^(\d{4})-(\d{2})$/.exec(k?.kid ?? "");
			if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) add("keys", `kid ${JSON.stringify(k?.kid)} does not follow the YYYY-MM convention (apps/e2e-issuer/README.md), so its age cannot be measured`);
			else dated.push({ kid: k.kid, at: Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) });
		}
		if (dated.length) {
			const newest = dated.reduce((a, b) => (a.at >= b.at ? a : b));
			const ageDays = Math.floor((cfg.now.getTime() - newest.at) / 86400000);
			if (ageDays > LIMITS.maxKeyAgeDays) add("keys", `the newest signing key (${newest.kid}) is ~${ageDays} days old (limit ${LIMITS.maxKeyAgeDays}) — rotate it (apps/e2e-issuer/README.md, "Rotate a signing key")`);
			if (newest.at > cfg.now.getTime() + 31 * 86400000) add("keys", `kid ${newest.kid} is dated in the future — the age check would be meaningless`);
		}
	}

	if (on("tls-pin")) {
		const pinned = new Set(cfg.pin.fingerprints.map((f) => f.sha1));
		if (cfg.pin.issuer_url !== url) add("tls-pin", `tls-ca-pin.json is for ${cfg.pin.issuer_url}, not ${url}`);
		if (pinned.size === 0) add("tls-pin", "tls-ca-pin.json pins nothing yet — run `node scripts/ci/check-e2e-issuer-health.mjs --print-pin --expected-url <url>` and commit the reviewed result before the Alibaba trust apply");
		const chain = obs.chain ?? [];
		if (chain.length === 0) add("tls-pin", `no certificate chain was served by ${url}`);
		else {
			const cas = chain.filter((c) => c.ca);
			if (cas.length === 0) add("tls-pin", "the served chain carries no CA certificate — only a leaf, which must never be pinned");
			for (const c of cas) {
				if (pinned.size && !pinned.has(c.sha1)) {
					add("tls-pin", `served CA certificate ${c.sha1} (${c.subject}, issued by ${c.issuer}) is NOT in tls-ca-pin.json — Alibaba RAM may refuse the issuer. Add it (--print-pin), re-apply infra/alibaba-e2e, and keep the old one until the chain is confirmed (RAM docs: add the new fingerprint at least a day before rotating).`);
				}
			}
			const leaf = chain[0];
			const daysLeft = Math.floor((Date.parse(leaf.validTo) - cfg.now.getTime()) / 86400000);
			if (!(daysLeft >= LIMITS.minLeafDaysLeft)) add("tls-pin", `the leaf certificate expires in ${daysLeft} day(s) (${leaf.validTo}) — Cloudflare renewal looks stuck; a CAA set that excludes the issuing CA produces exactly this`);
		}
	}

	if (on("latency") && obs.latencySamples.length) {
		const m = median(obs.latencySamples);
		if (m > LIMITS.latencyMs) add("latency", `discovery median response time ${m} ms over ${obs.latencySamples.length} requests (limit ${LIMITS.latencyMs} ms): ${obs.latencySamples.join(", ")} ms`);
	}

	return findings;
}

/** Render a findings list (and the context) as the tracker issue's Markdown body. */
export function renderReport(findings, cfg, obs) {
	const lines = [];
	lines.push(findings.length ? `**The E2E assertion issuer is UNHEALTHY** — ${findings.length} finding(s) against \`${cfg.expectedUrl}\`.` : `The E2E assertion issuer at \`${cfg.expectedUrl}\` is healthy.`);
	lines.push("");
	lines.push("| Check | Result |");
	lines.push("|---|---|");
	for (const c of cfg.checks) {
		const f = findings.filter((x) => x.check === c);
		lines.push(`| \`${c}\` | ${f.length ? f.map((x) => x.detail.replaceAll("|", "\\|")).join("<br>") : "ok"} |`);
	}
	if (obs?.chain?.length) {
		lines.push("");
		lines.push("Served chain (leaf first):");
		lines.push("");
		for (const c of obs.chain) lines.push(`- \`${c.sha1}\` ${c.ca ? "CA" : "leaf"} — ${c.subject} (issuer: ${c.issuer}; until ${c.validTo})`);
	}
	lines.push("");
	lines.push("Runbook: `infra/e2e-issuer/README.md`. Contract: #4226.");
	return lines.join("\n");
}

// ── PREFLIGHT: may this deploy go ahead? ────────────────────────────────────────────────────────

/**
 * PURE. `probe` is one GET of discovery at the target origin.
 * @returns {string[]} reasons to refuse; empty = go
 */
export function preflightProblems({ url, committedUrl, workersDev, probe }) {
	const out = [];
	if (!isBareOrigin(url)) out.push(`E2E_ISSUER_URL must be a bare https origin (no path, port or trailing slash) — got ${JSON.stringify(url)}`);
	if (!workersDev && /\.workers\.dev$/.test(url ?? "")) {
		out.push(`E2E_ISSUER_URL is a workers.dev origin (${url}) but apps/e2e-issuer/wrangler.jsonc has "workers_dev": false — this deploy would switch the only route off. Set E2E_ISSUER_URL to ${committedUrl} (infra/e2e-issuer/README.md, step 3).`);
	}
	if (url !== committedUrl) out.push(`E2E_ISSUER_URL is ${url}, but infra/e2e-issuer/terraform.tfvars serves ${committedUrl} — they must be the same origin.`);
	if (out.length) return out;
	// The origin must already route to THIS Worker. 200 with discovery, or the Worker's own
	// 503 issuer_origin_mismatch (the host is bound but the running build was deployed for another
	// origin — exactly the state this deploy fixes). Anything else means the custom domain is not
	// attached, and deploying with workers.dev off would leave the issuer reachable nowhere.
	let body = null;
	try {
		body = JSON.parse(probe.body);
	} catch {
		// not ours
	}
	const routed = (probe.status === 200 && body && typeof body.issuer === "string") || (probe.status === 503 && body?.error === "issuer_origin_mismatch");
	if (!routed) {
		out.push(
			`${url} does not route to the alethia-e2e-issuer Worker (discovery answered ${probe.status || `nothing: ${probe.error ?? "no response"}`}). The custom domain must exist BEFORE a deploy with workers_dev off: apply infra/e2e-issuer first (infra/e2e-issuer/README.md, step 2), then re-run this workflow.`,
		);
	}
	return out;
}

// ── self-test ───────────────────────────────────────────────────────────────────────────────────

function selfTest() {
	let fails = 0;
	const ok = (cond, name) => {
		if (cond) console.log(`  ok   ${name}`);
		else {
			fails++;
			console.error(`  FAIL ${name}`);
		}
	};
	const U = "https://e2e-issuer.alethialabs.io";
	const now = new Date("2026-09-23T00:00:00Z");
	const pin = { issuer_url: U, algorithm: "sha1", fingerprints: [{ sha1: "a".repeat(40) }, { sha1: "b".repeat(40) }] };
	const goodKey = { kid: "2026-09", kty: "RSA", alg: "RS256", use: "sig", n: "xyz", e: "AQAB" };
	const healthy = () => ({
		discovery: { status: 200, ms: 120, body: JSON.stringify({ issuer: U, jwks_uri: `${U}/.well-known/jwks.json`, id_token_signing_alg_values_supported: ["RS256"] }) },
		jwks: { status: 200, ms: 90, body: JSON.stringify({ keys: [goodKey] }) },
		chain: [
			{ sha1: "c".repeat(40), ca: false, subject: "CN=e2e-issuer.alethialabs.io", issuer: "CN=WE1", validTo: "Dec 20 00:00:00 2026 GMT" },
			{ sha1: "a".repeat(40), ca: true, subject: "CN=WE1", issuer: "CN=GTS Root R4", validTo: "Feb 20 00:00:00 2029 GMT" },
			{ sha1: "b".repeat(40), ca: true, subject: "CN=GTS Root R4", issuer: "CN=GlobalSign Root CA", validTo: "Jan 28 00:00:00 2028 GMT" },
		],
		latencySamples: [120, 110, 130],
	});
	const cfg = (over = {}) => ({ expectedUrl: U, committedUrl: U, pin, checks: CHECKS, now, ...over });
	const redOn = (obs, check, c = cfg()) => {
		const f = evaluate(obs, c);
		return f.length > 0 && f.every((x) => x.check === check);
	};

	console.log("live checks:");
	ok(evaluate(healthy(), cfg()).length === 0, "the healthy fixture is green");
	ok(evaluate(healthy(), cfg({ expectedUrl: "https://alethia-e2e-issuer.x.workers.dev" })).some((f) => f.check === "config"), "config: a var that is not the committed origin is red");
	ok(evaluate(healthy(), cfg({ expectedUrl: `${U}/` })).some((f) => f.check === "config"), "config: a trailing slash is red");

	let o = healthy();
	o.discovery = { status: 0, ms: 15000, body: "", error: "ENOTFOUND" };
	ok(evaluate(o, cfg()).some((f) => f.check === "discovery" && /ENOTFOUND/.test(f.detail)), "discovery: an unreachable issuer is red (a finding, not blindness)");
	o = healthy();
	o.discovery.body = JSON.stringify({ issuer: "https://alethia-e2e-issuer.x.workers.dev", jwks_uri: `${U}/.well-known/jwks.json`, id_token_signing_alg_values_supported: ["RS256"] });
	ok(redOn(o, "discovery"), "discovery: issuer != E2E_ISSUER_URL is red");
	o = healthy();
	o.discovery.body = JSON.stringify({ issuer: U, jwks_uri: "https://elsewhere.example/jwks.json", id_token_signing_alg_values_supported: ["RS256"] });
	ok(redOn(o, "discovery"), "discovery: a jwks_uri off the issuer is red");
	o = healthy();
	o.discovery.body = JSON.stringify({ issuer: U, jwks_uri: `${U}/.well-known/jwks.json`, id_token_signing_alg_values_supported: ["ES256"] });
	ok(redOn(o, "discovery"), "discovery: no RS256 advertised is red");
	o = healthy();
	o.discovery = { status: 503, ms: 50, body: '{"error":"issuer_origin_mismatch"}' };
	ok(evaluate(o, cfg()).some((f) => f.check === "discovery" && /503/.test(f.detail)), "discovery: the Worker's issuer_origin_mismatch is red");

	o = healthy();
	o.jwks = { status: 500, ms: 10, body: '{"error":"jwks_unavailable"}' };
	ok(redOn(o, "jwks"), "jwks: a 500 is red");
	o = healthy();
	o.jwks.body = "not json";
	ok(redOn(o, "jwks"), "jwks: unparseable is red");
	o = healthy();
	o.jwks.body = JSON.stringify({ keys: [{ ...goodKey, alg: "ES256", kty: "EC" }] });
	ok(redOn(o, "jwks"), "jwks: no RS256 key is red");
	o = healthy();
	o.jwks.body = JSON.stringify({ keys: [{ ...goodKey, d: "secret" }] });
	ok(evaluate(o, cfg()).some((f) => f.check === "jwks" && /PRIVATE/.test(f.detail)), "jwks: a published private exponent is red");
	o = healthy();
	o.jwks.body = JSON.stringify({ keys: [goodKey, { ...goodKey }] });
	ok(redOn(o, "jwks"), "jwks: duplicate kids are red");
	o = healthy();
	o.jwks = null;
	o.discovery.body = JSON.stringify({ issuer: U, jwks_uri: "http://insecure", id_token_signing_alg_values_supported: ["RS256"] });
	ok(evaluate(o, cfg()).some((f) => f.check === "jwks"), "jwks: a jwks_uri that was not fetched is red");

	o = healthy();
	o.jwks.body = JSON.stringify({ keys: [{ ...goodKey, kid: "2025-08" }] });
	ok(redOn(o, "keys"), "keys: a newest key older than the limit is red");
	o = healthy();
	o.jwks.body = JSON.stringify({ keys: [{ ...goodKey, kid: "prod-key" }] });
	ok(redOn(o, "keys"), "keys: an undatable kid is red (cannot measure is not fine)");
	o = healthy();
	o.jwks.body = JSON.stringify({ keys: [{ ...goodKey, kid: "2025-01" }, { ...goodKey, kid: "2026-08" }] });
	ok(evaluate(o, cfg()).length === 0, "keys: an old retained key beside a fresh one is green (the NEWEST bounds the age)");
	o = healthy();
	o.jwks.body = JSON.stringify({ keys: [{ ...goodKey, kid: "2031-01" }] });
	ok(redOn(o, "keys"), "keys: a future-dated kid is red");

	o = healthy();
	o.chain[1].sha1 = "d".repeat(40);
	ok(redOn(o, "tls-pin"), "tls-pin: an intermediate outside the pin is red");
	ok(redOn(healthy(), "tls-pin", cfg({ pin: { ...pin, fingerprints: [] } })), "tls-pin: an empty pin is red");
	ok(redOn(healthy(), "tls-pin", cfg({ pin: { ...pin, issuer_url: "https://other.alethialabs.io" } })), "tls-pin: a pin for another origin is red");
	o = healthy();
	o.chain = [];
	ok(redOn(o, "tls-pin"), "tls-pin: no chain served is red");
	o = healthy();
	o.chain = [o.chain[0]];
	ok(redOn(o, "tls-pin"), "tls-pin: a leaf-only chain is red");
	o = healthy();
	o.chain[0].validTo = "Sep 30 00:00:00 2026 GMT";
	ok(redOn(o, "tls-pin"), "tls-pin: a leaf expiring within the renewal floor is red");
	o = healthy();
	o.chain[0].sha1 = "e".repeat(40);
	ok(evaluate(o, cfg()).length === 0, "tls-pin: a rotated LEAF is green (only CA certificates are pinned)");

	o = healthy();
	o.latencySamples = [3000, 2900, 100];
	ok(redOn(o, "latency"), "latency: a slow median is red");
	o = healthy();
	o.latencySamples = [9000, 100, 120];
	ok(evaluate(o, cfg()).length === 0, "latency: one slow outlier is green (median, not max)");

	o = healthy();
	o.chain[1].sha1 = "d".repeat(40);
	ok(evaluate(o, cfg({ checks: ["discovery", "jwks", "keys"] })).length === 0, "--checks: an excluded check cannot go red");

	console.log("preflight:");
	const probe200 = { status: 200, body: JSON.stringify({ issuer: U }) };
	ok(preflightProblems({ url: U, committedUrl: U, workersDev: false, probe: probe200 }).length === 0, "go: committed origin, routed");
	ok(preflightProblems({ url: U, committedUrl: U, workersDev: false, probe: { status: 503, body: '{"error":"issuer_origin_mismatch"}' } }).length === 0, "go: bound but serving another origin (the state the deploy fixes)");
	ok(preflightProblems({ url: U, committedUrl: U, workersDev: false, probe: { status: 0, body: "", error: "ENOTFOUND" } }).length === 1, "no-go: the custom domain is not attached");
	ok(preflightProblems({ url: U, committedUrl: U, workersDev: false, probe: { status: 522, body: "<html>" } }).length === 1, "no-go: something other than the Worker answers");
	ok(preflightProblems({ url: "https://alethia-e2e-issuer.x.workers.dev", committedUrl: U, workersDev: false, probe: probe200 }).some((p) => /workers_dev/.test(p)), "no-go: workers.dev origin with workers_dev off");
	ok(preflightProblems({ url: `${U}/`, committedUrl: U, workersDev: false, probe: probe200 }).length > 0, "no-go: a trailing slash");
	ok(preflightProblems({ url: undefined, committedUrl: U, workersDev: false, probe: probe200 }).length > 0, "no-go: an unset variable");

	console.log("static:");
	const files = {
		[PATHS.stackTfvars]: 'zone_name = "alethialabs.io"\nhostname  = "e2e-issuer.alethialabs.io"\n',
		[PATHS.pin]: JSON.stringify({ issuer_url: U, algorithm: "sha1", fingerprints: [] }),
		...Object.fromEntries(PATHS.trustTfvars.map((f) => [f, `x = 1\ne2e_broker_issuer_url = "${U}"\n`])),
	};
	const reader = (over) => (rel) => (rel in over ? over[rel] : files[rel]);
	ok(staticProblems(reader({})).length === 0, "the agreeing fixture is clean");
	ok(staticProblems(reader({ [PATHS.trustTfvars[3]]: "e2e_broker_issuer_url = null\n" })).length === 0, "null (trust off) is allowed");
	ok(staticProblems(reader({ [PATHS.trustTfvars[1]]: 'e2e_broker_issuer_url = "https://alethia-e2e-issuer.x.workers.dev"\n' })).length === 1, "one trust stack on another origin is red");
	ok(staticProblems(reader({ [PATHS.pin]: JSON.stringify({ issuer_url: "https://x.alethialabs.io", algorithm: "sha1", fingerprints: [] }) })).length === 1, "a pin for another origin is red");
	const throws = (fn) => {
		try {
			fn();
			return false;
		} catch {
			return true;
		}
	};
	ok(throws(() => staticProblems(reader({ [PATHS.trustTfvars[0]]: "# e2e_broker_issuer_url moved\n" }))), "a trust tfvars with NO assignment throws (blind, never 'agrees')");
	ok(throws(() => staticProblems(reader({ [PATHS.trustTfvars[0]]: `e2e_broker_issuer_url = "${U}"\ne2e_broker_issuer_url = null\n` }))), "two assignments throw");
	ok(throws(() => parsePin(JSON.stringify({ issuer_url: U, algorithm: "sha1", fingerprints: Array.from({ length: 6 }, (_, i) => ({ sha1: String(i).repeat(40) })) }))), "a pin over Alibaba's five-fingerprint cap throws");
	ok(throws(() => parsePin(JSON.stringify({ issuer_url: U, algorithm: "sha1", fingerprints: [{ sha1: "AA:BB" }] }))), "a malformed fingerprint throws");
	ok(throws(() => parsePin(JSON.stringify({ issuer_url: U, algorithm: "sha256", fingerprints: [] }))), "a non-sha1 pin throws");
	ok(throws(() => readWorkersDev('{ "name": "x" }')), "wrangler.jsonc without workers_dev throws");
	ok(readWorkersDev('  "workers_dev": false,\n') === false, "workers_dev false is read");

	console.log("fingerprint (against openssl):");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issuer-health-"));
	try {
		const run = (args) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
		run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Self-test CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
		run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=e2e-issuer.test"]);
		run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2"]);
		const served = `depth=1 noise\n${fs.readFileSync(path.join(dir, "leaf.pem"), "utf8")}---\n${fs.readFileSync(path.join(dir, "ca.pem"), "utf8")}---\n`;
		const chain = parseChain(served);
		const expect = run(["x509", "-in", "ca.pem", "-fingerprint", "-sha1", "-noout"]).split("=")[1].trim().replaceAll(":", "").toLowerCase();
		ok(chain.length === 2 && chain[0].ca === false && chain[1].ca === true, "served order is kept and the CA flag is read");
		ok(chain[1].sha1 === expect, "the CA fingerprint equals `openssl x509 -fingerprint -sha1` (Alibaba's documented procedure)");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}

	console.log("committed files:");
	ok(staticProblems((rel) => readRepo(rel)).length === 0, "the repository's own copies agree");

	if (fails > 0) {
		console.error(`\ncheck-e2e-issuer-health self-test: ${fails} failure(s)`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

/** Read `--name value` from argv. */
function arg(name) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
	const argv = process.argv;
	if (argv.includes("--self-test")) return selfTest();

	if (argv.includes("--static")) {
		const problems = staticProblems((rel) => readRepo(rel));
		if (problems.length) {
			for (const p of problems) console.error(`::error::${p}`);
			process.exit(1);
		}
		console.log(`e2e issuer origin: ${committedIssuerUrl()} — the stack, the pin and the four trust stacks agree.`);
		return;
	}

	const url = arg("--expected-url");
	const committedUrl = committedIssuerUrl();

	if (argv.includes("--preflight")) {
		const workersDev = readWorkersDev(readRepo(PATHS.wrangler));
		const probe = isBareOrigin(url) ? await timedGet(`${url}/.well-known/openid-configuration`) : { status: 0, body: "" };
		const problems = preflightProblems({ url, committedUrl, workersDev, probe });
		if (problems.length) {
			for (const p of problems) console.error(`::error title=e2e issuer deploy refused::${p}`);
			process.exit(1);
		}
		console.log(`preflight: ${url} routes to the Worker; deploying.`);
		return;
	}

	if (!isBareOrigin(url)) {
		console.error(`--expected-url must be a bare https origin; got ${JSON.stringify(url)} (is vars.E2E_ISSUER_URL set?)`);
		process.exit(1);
	}

	if (argv.includes("--print-pin")) {
		const chain = readChain(new URL(url).host);
		const cas = chain.filter((c) => c.ca);
		if (cas.length === 0) {
			console.error(`no CA certificate in the chain served by ${url}`);
			process.exit(1);
		}
		const pin = parsePin(readRepo(PATHS.pin));
		const today = new Date().toISOString().slice(0, 10);
		// ADDITIVE for the same origin: a chain change is staged by pinning the new CA BESIDE the old one
		// (RAM docs: add the new fingerprint at least a day before the rotation, remove the old after).
		// Dropping an entry is a deliberate hand edit in the reviewed PR, never a side effect of this.
		const kept = pin.issuer_url === url ? pin.fingerprints : [];
		const added = cas.filter((c) => !kept.some((f) => f.sha1 === c.sha1)).map((c) => ({ sha1: c.sha1, subject: c.subject, issuer: c.issuer, not_after: c.validTo, observed_at: today }));
		const fingerprints = [...kept, ...added];
		if (fingerprints.length > MAX_PIN) {
			console.error(`${fingerprints.length} fingerprints (${kept.length} kept + ${added.length} served) — more than Alibaba's ${MAX_PIN}. Remove retired entries from ${PATHS.pin} by hand first.`);
			process.exit(1);
		}
		console.log(JSON.stringify({ ...pin, issuer_url: url, fingerprints }, null, 2));
		return;
	}

	const only = arg("--checks");
	const checks = only ? only.split(",").map((s) => s.trim()) : CHECKS;
	const unknown = checks.filter((c) => !CHECKS.includes(c));
	if (unknown.length) {
		console.error(`unknown check(s) ${unknown.join(", ")}; known: ${CHECKS.join(", ")}`);
		process.exit(1);
	}
	const pin = parsePin(readRepo(PATHS.pin));
	const obs = await observe(url, { checks, retrySeconds: Number(arg("--retry-seconds") ?? 0) });
	const cfg = { expectedUrl: url, committedUrl, pin, checks, now: new Date() };
	const findings = evaluate(obs, cfg);
	console.log(renderReport(findings, cfg, obs));
	if (findings.length) {
		for (const f of findings) console.error(`::error title=e2e issuer ${f.check}::${f.detail}`);
		process.exit(2);
	}
}

main().catch((err) => {
	// Anything thrown is the INSTRUMENT failing (unreadable pin, missing openssl, a moved tfvars) —
	// exit 1, which the workflow treats as blind, never as healthy or as an issuer finding.
	console.error(`::error title=e2e issuer health check is blind::${err?.message ?? err}`);
	process.exit(1);
});
