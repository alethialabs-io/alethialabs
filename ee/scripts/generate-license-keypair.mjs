#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// Generates an Alethia Labs licence signing keypair (ed25519) on the maintainer's machine.
//
// The SIGNING half goes straight into the macOS login Keychain, under the exact entry the
// credential broker reads for the `license-signing` profile (service `alethia-creds`, account
// `license-signing/ALETHIA_LICENSE_SIGNING_KEY`, value base64 of the PKCS8 PEM — the form
// ee/scripts/issue-license.ts accepts). It is never printed, written to a file, or put in the
// environment of anything else. The VERIFICATION half is printed as an SPKI PEM, ready to add to
// BUILT_IN_LICENSE_KEYS in ee/src/license-keys.ts.
//
// Usage (maintainer, from a terminal):
//   ! node ee/scripts/generate-license-keypair.mjs --id 2026-12-a
//   ! node ee/scripts/generate-license-keypair.mjs --id 2027-06-b --replace   # rotation only
//
// It refuses to overwrite an existing signing key unless --replace is passed, because the old key
// is the only thing that can sign licences verifiable by images already in the field.

import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";

const SERVICE = "alethia-creds";
const ACCOUNT = "license-signing/ALETHIA_LICENSE_SIGNING_KEY";

/** Prints a message to stderr and exits non-zero. */
function die(message) {
	process.stderr.write(`generate-license-keypair: ${message}\n`);
	process.exit(1);
}

/** Parses `--id <name>` and `--replace` from argv. */
function parseArgs(argv) {
	const out = { id: "", replace: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--replace") out.replace = true;
		else if (a === "--id") out.id = argv[++i] ?? "";
		else if (a.startsWith("--id=")) out.id = a.slice(5);
		else if (a === "--help" || a === "-h") {
			process.stdout.write(
				"usage: node ee/scripts/generate-license-keypair.mjs --id <key-id> [--replace]\n",
			);
			process.exit(0);
		} else die(`unknown argument: ${a}`);
	}
	if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(out.id)) {
		die("--id is required: a short stable name such as 2026-12-a (lowercase, digits, dashes).");
	}
	return out;
}

/** True when the Keychain already holds a signing key under the broker's entry. */
function keychainHasKey() {
	const res = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT], {
		stdio: "ignore",
	});
	return res.status === 0;
}

/** Stores the value under the broker's entry, replacing any existing one. Never echoes it. */
function keychainStore(value) {
	const res = spawnSync(
		"security",
		["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", value],
		{ stdio: "ignore" },
	);
	if (res.status !== 0) die(`could not store the signing key in the Keychain (security exited ${res.status}).`);
}

/** Generates the keypair, stores the private half, prints the public half. */
function main() {
	const args = parseArgs(process.argv.slice(2));
	if (process.platform !== "darwin") die("this stores the key in the macOS Keychain; run it on the maintainer's Mac.");
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		die("run this from a terminal (it is a maintainer action: `! node ee/scripts/generate-license-keypair.mjs …`).");
	}
	if (keychainHasKey() && !args.replace) {
		die(
			"a licence signing key is already stored. Pass --replace only when rotating, and keep the old " +
				"public key in BUILT_IN_LICENSE_KEYS until every licence it signed has been reissued.",
		);
	}

	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	const spki = publicKey.export({ type: "spki", format: "pem" }).toString().trim();
	keychainStore(Buffer.from(pkcs8, "utf8").toString("base64"));
	if (!keychainHasKey()) die("the Keychain did not keep the signing key; nothing was changed in the repo.");

	process.stdout.write(
		[
			"Stored the signing key in the Keychain (profile `license-signing`). It was not printed.",
			"",
			"Add this entry to BUILT_IN_LICENSE_KEYS in ee/src/license-keys.ts:",
			"",
			`\t{\n\t\tid: "${args.id}",\n\t\tspkiPem: \`${spki}\`,\n\t},`,
			"",
			"Back the signing key up offline now (Keychain Access → alethia-creds → license-signing/…).",
			"",
		].join("\n"),
	);
}

main();
