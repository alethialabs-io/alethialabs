// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ── The self-hosted start-up configuration check (EDN-H2) ───────────────────────────────────────
// A self-hosted console checks, before it serves anything, that every value its edition needs is
// present and has the shape the code that reads it expects. One error names every variable that is
// not usable and how to fix it. No value — and no part of a connection URL — is ever in it.
//
// It builds on lib/crypto/secrets.ts: the instance-secret names and generators come from
// CONSOLE_INSTANCE_SECRETS, and the placeholder rule is instanceSecretProblem. What this module adds
// is which of those secrets a self-hosted console cannot start without, the shape of the
// fixed-format keys, and the connection settings.
//
// WHEN IT APPLIES: a production process (`NODE_ENV=production`) on an instance whose environment
// DECLARES `ALETHIA_DEPLOYMENT_MODE=self-managed`. deploy/install.sh copies .env.example, which
// declares it, into the box's .env. Unset, deploymentMode() still answers "self-managed", but this
// check stays off: the CI end-to-end jobs run `next start` without that line and without most
// instance secrets, and the hosted deploy declares `hosted`. Every production process, hosted or
// not, still refuses a template placeholder through assertInstanceSecrets (instrumentation.ts).

import { createPrivateKey } from "node:crypto";
import {
	CONSOLE_INSTANCE_SECRETS,
	type ConsoleInstanceSecret,
	instanceSecretProblem,
} from "@/lib/crypto/secrets";

/** The environment the check reads: a plain name → value map (process.env in production). */
export type ConfigEnv = Readonly<Record<string, string | undefined>>;

/**
 * The console instance secrets a self-hosted console cannot start without: the manifest entries
 * marked `required` whose consumers include `app` (the database passwords reach the console inside
 * the connection URLs, checked below). A unit test holds this equal to deploy/selfhost/secrets.manifest.
 */
export const SELF_HOSTED_REQUIRED_SECRETS = [
	"BETTER_AUTH_SECRET",
	"CLI_JWT_SECRET",
	"ALETHIA_CRED_ENCRYPTION_KEY",
	"ALETHIA_STORAGE_ACCESS_KEY_ID",
	"ALETHIA_STORAGE_SECRET_ACCESS_KEY",
	"ALETHIA_SNAPSHOT_HMAC_KEY",
	"ALETHIA_CRON_SECRET",
	"ALETHIA_RUNNER_BOOTSTRAP_TOKEN",
	"ALETHIA_OIDC_SIGNING_KEY",
	"ALETHIA_RECEIPT_SIGNING_KEY",
] as const satisfies readonly ConsoleInstanceSecret[];

/** Whether the self-hosted start-up check applies to a process with this environment. */
export function selfHostedConfigCheckApplies(env: ConfigEnv): boolean {
	return env.NODE_ENV === "production" && env.ALETHIA_DEPLOYMENT_MODE === "self-managed";
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The bytes a strict standard-base64 string decodes to, or null when it is not one. */
function decodeBase64(value: string): Buffer | null {
	if (value.length % 4 !== 0 || !BASE64.test(value)) return null;
	return Buffer.from(value, "base64");
}

/** Whether `value` base64-decodes to a PEM private key of the given type that node:crypto parses. */
function isPemPrivateKey(value: string, type: "rsa" | "ec"): boolean {
	const bytes = decodeBase64(value);
	if (bytes === null) return false;
	const pem = bytes.toString("utf8");
	if (!pem.includes("-----BEGIN") || !pem.includes("PRIVATE KEY-----")) return false;
	try {
		return createPrivateKey(pem).asymmetricKeyType === type;
	} catch {
		return false;
	}
}

/**
 * Why a SET value of `name` does not have the shape the code that reads it needs, or null. Only
 * the fixed-format keys are checked. The hex secrets are read as opaque strings, and an older
 * install may hold one in another shape, so any non-placeholder value of theirs is accepted.
 */
function shapeProblem(name: ConsoleInstanceSecret, value: string): string | null {
	const generator = CONSOLE_INSTANCE_SECRETS[name];
	const regenerate = `Replace it with: sh deploy/selfhost/rotate-secret.sh ${name}`;
	switch (generator) {
		case "base64-32": {
			const bytes = decodeBase64(value);
			return bytes?.length === 32
				? null
				: `${name} must be the base64 of 32 random bytes. ${regenerate}`;
		}
		case "ed25519-raw": {
			const bytes = decodeBase64(value);
			return bytes?.length === 64
				? null
				: `${name} must be the base64 of a 64-byte ed25519 private key. ${regenerate}`;
		}
		case "rsa-2048-pem":
			return isPemPrivateKey(value, "rsa")
				? null
				: `${name} must be the base64 of a PEM RSA private key. ${regenerate}`;
		case "ec-p256-pem":
			return isPemPrivateKey(value, "ec")
				? null
				: `${name} must be the base64 of a PEM EC private key. ${regenerate}`;
		default:
			return null;
	}
}

const REQUIRED = new Set<string>(SELF_HOSTED_REQUIRED_SECRETS);

/** Whether `name` is one a self-hosted console cannot start without. */
function isRequired(name: ConsoleInstanceSecret): boolean {
	return REQUIRED.has(name);
}

/** Type guard: `name` is one of CONSOLE_INSTANCE_SECRETS. */
function isConsoleInstanceSecret(name: string): name is ConsoleInstanceSecret {
	return Object.hasOwn(CONSOLE_INSTANCE_SECRETS, name);
}

/**
 * Why the connection URL in `name` is not usable, or null. The URL carries a password, so the
 * message names the variable and the part that is wrong, never the URL.
 */
function urlProblem(
	name: string,
	value: string | undefined,
	protocols: readonly string[],
	fix: string,
): string | null {
	const raw = (value ?? "").trim();
	if (raw === "") return `${name} is not set. ${fix}`;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return `${name} is not a valid URL. ${fix}`;
	}
	if (!protocols.includes(url.protocol)) {
		return `${name} must start with ${protocols.map((p) => `${p}//`).join(" or ")}. ${fix}`;
	}
	if (url.hostname === "") return `${name} has no host. ${fix}`;
	return null;
}

const POSTGRES = ["postgres:", "postgresql:"] as const;
const HTTP = ["http:", "https:"] as const;
const COMPOSE_FIX =
	"The self-host overlay sets it (deploy/selfhost/docker-compose.selfhost.yml); set it in .env only for an external service.";

/**
 * Every reason this environment cannot run a self-hosted console: each instance secret that is
 * missing (when required), a template placeholder, or of the wrong shape, and each connection
 * setting that is missing or malformed. Empty when the configuration is usable. Messages name
 * variables, never values.
 */
export function selfHostedConfigProblems(env: ConfigEnv): string[] {
	const problems: string[] = [];
	for (const name of Object.keys(CONSOLE_INSTANCE_SECRETS).filter(isConsoleInstanceSecret)) {
		const value = (env[name] ?? "").trim();
		const problem =
			instanceSecretProblem(name, value, isRequired(name)) ??
			(value === "" ? null : shapeProblem(name, value));
		if (problem) problems.push(problem);
	}
	for (const name of ["ALETHIA_DATABASE_URL", "ALETHIA_APP_DATABASE_URL"]) {
		const problem = urlProblem(name, env[name], POSTGRES, COMPOSE_FIX);
		if (problem) problems.push(problem);
	}
	const storage = urlProblem("ALETHIA_STORAGE_ENDPOINT", env.ALETHIA_STORAGE_ENDPOINT, HTTP, COMPOSE_FIX);
	if (storage) problems.push(storage);
	// The public origin is optional (an IP-only first look has none), but a set one must parse.
	for (const name of ["BETTER_AUTH_URL", "NEXT_PUBLIC_APP_URL"]) {
		if ((env[name] ?? "").trim() === "") continue;
		const problem = urlProblem(name, env[name], HTTP, "Set it to this instance's public origin, e.g. https://alethia.example.com.");
		if (problem) problems.push(problem);
	}
	return problems;
}

/**
 * The self-hosted start-up check: throws one error naming every unusable value, or returns.
 * Callers run it only when selfHostedConfigCheckApplies(env) holds.
 */
export function assertSelfHostedConfig(env: ConfigEnv): void {
	const problems = selfHostedConfigProblems(env);
	if (problems.length === 0) return;
	throw new Error(
		`Refusing to start: this self-hosted instance's configuration is not usable.\n${problems
			.map((p) => `  - ${p}`)
			.join("\n")}\n` +
			"Instance secrets are generated per install from deploy/selfhost/secrets.manifest: re-run " +
			"deploy/install.sh to fill a missing one, and replace a set one with deploy/selfhost/rotate-secret.sh.",
	);
}
