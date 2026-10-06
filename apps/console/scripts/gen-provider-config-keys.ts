// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Writes apps/cli/cmd/provider_config_keys.json — the provider_config keys `alethia export` may
// write into alethia.yaml (#5531) — from the console's ONE definition of a settable key,
// `settableProviderConfigKnobs` (lib/cli/provider-config-knobs.ts): the canvas's offerable knobs,
// credentials excluded (`isCredentialKnob`), reserved `alethia_*` keys excluded.
//
// Why a file and not a route: the CLI has no read that publishes the settable keys, and #5531 is
// held to existing read routes. The export is an ALLOW-LIST over this file, so a stored key that is
// not in it — a credential stored before #5571, a key no template reads — is never written.
//
// tests/lib/cli/provider-config-keys-golden.test.ts fails when the file names a key that is no longer
// settable (the direction that could write a credential). A key that BECAME settable and is missing
// here only makes the export leave it out — named in the file's header, kept by apply — so a template
// lane adding a knob is not made to touch apps/cli. Run this to bring the file up to date either way.
//
// Run: pnpm -C apps/console exec tsx scripts/gen-provider-config-keys.ts

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { settableProviderConfigKnobs, hasProviderConfig } from "@/lib/cli/provider-config-knobs";
import { COMPONENT_KINDS } from "@/lib/cli/project-components";
import { CLOUD_PROVIDER_SLUGS } from "@/lib/cloud-providers/provider-slug";

/** Absolute path of the allow-list the CLI embeds. */
export const PROVIDER_CONFIG_KEYS_FILE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../cli/cmd/provider_config_keys.json",
);

/** The command that regenerates the file — named in the drift test's failure message. */
export const REGENERATE_COMMAND = "pnpm -C apps/console exec tsx scripts/gen-provider-config-keys.ts";

/** cloud → CLI component kind → the settable provider_config keys, sorted. Empty lists are left out. */
type ProviderConfigKeys = Record<string, Record<string, string[]>>;

/** The settable keys for every cloud and every CLI kind with a provider_config column. */
export function providerConfigKeys(): ProviderConfigKeys {
	const out: ProviderConfigKeys = {};
	for (const cloud of [...CLOUD_PROVIDER_SLUGS].sort()) {
		const kinds: Record<string, string[]> = {};
		for (const kind of [...COMPONENT_KINDS].sort()) {
			if (!hasProviderConfig(kind)) continue;
			const keys = settableProviderConfigKnobs(cloud, kind)
				.map((k) => k.name)
				.sort();
			if (keys.length > 0) kinds[kind] = keys;
		}
		if (Object.keys(kinds).length > 0) out[cloud] = kinds;
	}
	return out;
}

/** Renders the file's exact bytes. */
export function renderProviderConfigKeys(): string {
	const doc = {
		generatedBy: REGENERATE_COMMAND,
		keys: providerConfigKeys(),
	};
	return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Writes the file, reporting whether its bytes changed. */
function main(): void {
	const next = renderProviderConfigKeys();
	let previous = "";
	try {
		previous = readFileSync(PROVIDER_CONFIG_KEYS_FILE, "utf8");
	} catch {
		// First write: there is nothing to compare against.
	}
	writeFileSync(PROVIDER_CONFIG_KEYS_FILE, next);
	console.log(`${previous === next ? "unchanged" : "wrote"} apps/cli/cmd/provider_config_keys.json`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
