// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertSelfHostedConfig,
	type ConfigEnv,
	SELF_HOSTED_REQUIRED_SECRETS,
	selfHostedConfigCheckApplies,
	selfHostedConfigProblems,
} from "@/lib/config/selfhost-secrets";
import { CONSOLE_INSTANCE_SECRETS } from "@/lib/crypto/secrets";

const REPO = resolve(__dirname, "../../../../..");
const MANIFEST = readFileSync(resolve(REPO, "deploy/selfhost/secrets.manifest"), "utf8");

/** The manifest's `secret` records as [name, presence, consumers]. */
function manifestSecrets(): Array<[string, string, string[]]> {
	return MANIFEST.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter((f) => f[0] === "secret")
		.map((f): [string, string, string[]] => [f[1] ?? "", f[3] ?? "", (f[5] ?? "").split(",")]);
}

/** base64 of a PKCS#8 PEM private key, the shape the manifest's PEM generators make. */
function pemKey(type: "rsa" | "ec"): string {
	const { privateKey } =
		type === "rsa"
			? generateKeyPairSync("rsa", { modulusLength: 2048 })
			: generateKeyPairSync("ec", { namedCurve: "P-256" });
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	return Buffer.from(pem, "utf8").toString("base64");
}

const RSA_KEY = pemKey("rsa");

/** A generated value for each required secret, of its manifest generator's shape. */
function generatedSecrets(): Record<string, string> {
	const hex = (n: number) => randomBytes(n).toString("hex");
	return {
		BETTER_AUTH_SECRET: hex(32),
		CLI_JWT_SECRET: hex(32),
		ALETHIA_CRED_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
		ALETHIA_STORAGE_ACCESS_KEY_ID: hex(16),
		ALETHIA_STORAGE_SECRET_ACCESS_KEY: hex(32),
		ALETHIA_SNAPSHOT_HMAC_KEY: hex(32),
		ALETHIA_CRON_SECRET: hex(32),
		ALETHIA_RUNNER_BOOTSTRAP_TOKEN: hex(32),
		ALETHIA_OIDC_SIGNING_KEY: RSA_KEY,
		ALETHIA_RECEIPT_SIGNING_KEY: randomBytes(64).toString("base64"),
	};
}

/** A complete, usable self-hosted environment (what deploy/install.sh plus the overlay produce). */
function usableEnv(): Record<string, string> {
	return {
		NODE_ENV: "production",
		ALETHIA_DEPLOYMENT_MODE: "self-managed",
		ALETHIA_DATABASE_URL: `postgres://alethia:${randomBytes(24).toString("hex")}@postgres:5432/alethia`,
		ALETHIA_APP_DATABASE_URL: `postgres://alethia_app:${randomBytes(24).toString("hex")}@postgres:5432/alethia`,
		ALETHIA_STORAGE_ENDPOINT: "http://seaweedfs:8333",
		...generatedSecrets(),
	};
}

/** The message assertSelfHostedConfig throws for `env`, or "" when it does not throw. */
function refusal(env: ConfigEnv): string {
	try {
		assertSelfHostedConfig(env);
		return "";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

describe("when the self-hosted check applies", () => {
	it("applies to a production process that declares self-managed, and to nothing else", () => {
		expect(selfHostedConfigCheckApplies({ NODE_ENV: "production", ALETHIA_DEPLOYMENT_MODE: "self-managed" })).toBe(true);
		// The CI end-to-end jobs run `next start` with the mode unset and most secrets absent.
		expect(selfHostedConfigCheckApplies({ NODE_ENV: "production" })).toBe(false);
		expect(selfHostedConfigCheckApplies({ NODE_ENV: "production", ALETHIA_DEPLOYMENT_MODE: "hosted" })).toBe(false);
		expect(selfHostedConfigCheckApplies({ NODE_ENV: "development", ALETHIA_DEPLOYMENT_MODE: "self-managed" })).toBe(false);
	});
});

describe("the required set", () => {
	it("is every required manifest secret the console reads from its own environment", () => {
		// The database passwords reach the console only inside the connection URLs.
		const viaUrl = new Set(["ALETHIA_DB_PASSWORD", "ALETHIA_APP_DB_PASSWORD"]);
		const expected = manifestSecrets()
			.filter(([name, presence, consumers]) => presence === "required" && consumers.includes("app") && !viaUrl.has(name))
			.map(([name]) => name)
			.sort();
		expect([...SELF_HOSTED_REQUIRED_SECRETS].sort()).toEqual(expected);
	});
});

describe("selfHostedConfigProblems", () => {
	it("accepts a generated configuration", () => {
		expect(selfHostedConfigProblems(usableEnv())).toEqual([]);
		expect(refusal(usableEnv())).toBe("");
	});

	it.each([...SELF_HOSTED_REQUIRED_SECRETS])("refuses a missing %s, naming it", (name) => {
		const env = usableEnv();
		delete env[name];
		expect(refusal(env)).toContain(`${name} is not set`);
	});

	it.each(Object.keys(CONSOLE_INSTANCE_SECRETS))(
		"refuses a placeholder for %s, naming it and never echoing the value",
		(name) => {
			const value = "<replace with a generated value>";
			const message = refusal({ ...usableEnv(), [name]: value });
			expect(message).toContain(`${name} holds a template placeholder`);
			expect(message).not.toContain(value);
		},
	);

	it.each([
		["ALETHIA_CRED_ENCRYPTION_KEY", randomBytes(16).toString("base64")],
		["ALETHIA_CRED_ENCRYPTION_KEY", "not base64 at all!"],
		["ALETHIA_RECEIPT_SIGNING_KEY", randomBytes(32).toString("base64")],
		["ALETHIA_OIDC_SIGNING_KEY", randomBytes(64).toString("base64")],
		["ALETHIA_OIDC_SIGNING_KEY", pemKey("ec")],
		["ALETHIA_RECEIPT_ANCHOR_KEY", RSA_KEY],
		["NEXT_SERVER_ACTIONS_ENCRYPTION_KEY", randomBytes(8).toString("base64")],
	])("refuses a malformed %s, naming it and never echoing the value", (name, value) => {
		const message = refusal({ ...usableEnv(), [name]: value });
		expect(message).toContain(`${name} must be`);
		expect(message).not.toContain(value);
	});

	it("accepts the optional keys unset, and set to a generated value", () => {
		const env = {
			...usableEnv(),
			ALETHIA_RECEIPT_ANCHOR_KEY: pemKey("ec"),
			NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
			ALETHIA_STATUS_PROBE_TOKEN: randomBytes(32).toString("hex"),
		};
		expect(selfHostedConfigProblems(env)).toEqual([]);
	});

	it("accepts a hex secret of another shape, which an older install may hold", () => {
		expect(selfHostedConfigProblems({ ...usableEnv(), BETTER_AUTH_SECRET: randomBytes(32).toString("base64") })).toEqual([]);
	});

	it.each([
		["ALETHIA_DATABASE_URL", "", "is not set"],
		["ALETHIA_DATABASE_URL", "mysql://u:p@db:3306/x", "must start with postgres://"],
		["ALETHIA_APP_DATABASE_URL", "postgres//no-scheme", "is not a valid URL"],
		["ALETHIA_STORAGE_ENDPOINT", "", "is not set"],
		["ALETHIA_STORAGE_ENDPOINT", "s3://bucket", "must start with http://"],
		["BETTER_AUTH_URL", "console.internal", "is not a valid URL"],
	])("refuses %s=%j, naming it and never echoing a URL", (name, value, reason) => {
		const env = { ...usableEnv(), [name]: value };
		const message = refusal(env);
		expect(message).toContain(`${name} ${reason}`);
		// Neither the value nor a configured database URL (they carry passwords) appears.
		const leaked = [value, env.ALETHIA_DATABASE_URL, env.ALETHIA_APP_DATABASE_URL].filter(
			(v) => v !== "" && message.includes(v),
		);
		expect(leaked).toEqual([]);
	});

	it("names every problem in one refusal", () => {
		const env = usableEnv();
		delete env.CLI_JWT_SECRET;
		delete env.ALETHIA_DATABASE_URL;
		const message = refusal(env);
		expect(message).toContain("CLI_JWT_SECRET is not set");
		expect(message).toContain("ALETHIA_DATABASE_URL is not set");
	});
});
