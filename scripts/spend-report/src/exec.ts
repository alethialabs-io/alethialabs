// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { execFile } from "node:child_process";

/**
 * Runs a CLI (`aws`, `az`) and returns its stdout. stdout is NEVER echoed — a secret read comes
 * through here. On failure the error carries the command name and the first meaningful stderr line
 * (the provider's error code), which is what the report prints as the reason.
 */
export function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(`${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim() + ` failed: ${firstLine(stderr) || err.message}`));
				return;
			}
			resolve(stdout);
		});
	});
}

/** Runs a CLI and parses its stdout as JSON. */
export async function runJson(cmd: string, args: string[], timeoutMs?: number): Promise<unknown> {
	const out = await run(cmd, args, timeoutMs);
	return JSON.parse(out);
}

/** The first non-empty line of a CLI's stderr, trimmed to something an email can carry. */
export function firstLine(text: string): string {
	const line = text
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return (line ?? "").slice(0, 300);
}

/** Fetches JSON, turning a non-2xx into an Error carrying the status and the provider's message. */
export async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
	const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(60_000) });
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${providerMessage(text)}`);
	}
	return text === "" ? {} : JSON.parse(text);
}

/** Pulls the human-readable message out of a provider error body (Google, Azure, Hetzner, Alibaba shapes). */
export function providerMessage(body: string): string {
	try {
		const j: unknown = JSON.parse(body);
		if (isRecord(j)) {
			const e = j.error;
			if (isRecord(e) && typeof e.message === "string") return e.message.slice(0, 300);
			if (typeof j.Message === "string") return `${typeof j.Code === "string" ? `${j.Code}: ` : ""}${j.Message}`.slice(0, 300);
			if (typeof j.message === "string") return j.message.slice(0, 300);
		}
	} catch {
		/* not JSON — fall through to the raw text */
	}
	return body.slice(0, 300);
}

/** Narrows an unknown to a plain object. */
export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads a numeric field that a provider may send as a number or a decimal string. */
export function num(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return null;
}
