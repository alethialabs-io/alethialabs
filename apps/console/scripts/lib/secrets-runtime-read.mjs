// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One reader for which secrets providers can serve secrets to a cluster at runtime — decided in
// packages/core/categories/secrets_*.go by which store hook each provider registers.
//
// The question the console has to answer before it renders the picker is "if the user selects this
// store, will workloads actually resolve values from it?". Go answers it in two places, because there
// are two ways to be readable in-cluster and they are NOT interchangeable:
//
//   · saasSecretStore    — credential-based ESO ClusterSecretStore read with a seeded token
//                          (vault / doppler / generic). REPLACES the project's native store.
//   · keylessSecretStore — cross-account read with the cluster's own workload identity, no stored
//                          key (the *-xacct slugs). ADDITIVE to the native store.
//
// Either one means the cluster can read. Neither means selecting the store is WORSE than doing
// nothing — it flips `secrets_provider` off "native", so every per-cloud custom_secrets.tf stops
// creating the native secrets, while no ClusterSecretStore renders to read from instead. That is the
// state the canvas greys out, and until #1621 it was a hand-written TS list of two slugs that nothing
// tied to the Go hooks.
//
// Registering a hook is therefore the WHOLE definition, which is what makes this derivable: there is
// no separate declaration to keep in sync, only the code that implements it.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { bracedBodyAt, neutralizeBracesInStrings, stripComments } from "./go-source.mjs";

/** The two hooks that mean "the cluster can read this store". Order is display order, not precedence. */
export const RUNTIME_READ_HOOKS = ["saasSecretStore", "keylessSecretStore"];

/** Field names at the TOP level of a Go composite-literal body.
 *
 * Depth-aware rather than a flat `/\bfoo:/` scan: every `behavior{}` here holds func literals holding
 * further composite literals, and a hook name mentioned inside one of those (a struct field being
 * built, a map key) is not the same fact as the hook being REGISTERED. Reading it as one would report
 * a provider as cluster-readable because some nested literal happens to name it — the fail-OPEN
 * direction, which is the one that lets the canvas offer a store the cluster cannot resolve. */
export function topLevelFields(body) {
	const fields = new Set();
	let depth = 0;
	let line = "";
	const take = () => {
		const m = line.match(/^\s*(\w+)\s*:/);
		if (m && depth === 0) fields.add(m[1]);
		line = "";
	};
	for (const ch of body) {
		if (ch === "{" || ch === "(" || ch === "[") {
			take();
			depth++;
		} else if (ch === "}" || ch === ")" || ch === "]") {
			depth--;
			line = "";
		} else if (ch === "\n" || ch === ",") {
			take();
		} else {
			line += ch;
		}
	}
	take();
	return fields;
}

/**
 * Parse every `register("secrets", "<slug>", behavior{ … })` in one Go file.
 *
 * @returns {{slug: string, hooks: string[]}[]} — hooks present, in RUNTIME_READ_HOOKS order.
 */
export function parseSecretsRegistrations(goSrc) {
	// Braces inside string literals are blanked, but the literals themselves survive — the slug is
	// read OUT of one (`register("secrets", "vault"`), so blanking whole strings would erase the
	// thing being parsed. Comments go so a hook merely described in prose never counts as registered.
	const src = stripComments(neutralizeBracesInStrings(goSrc));
	const found = [];
	for (const m of src.matchAll(/register\(\s*"secrets"\s*,\s*"([^"]+)"\s*,\s*behavior\{/g)) {
		const body = bracedBodyAt(src, m.index);
		if (body === "") {
			throw new Error(
				`register("secrets", "${m[1]}", behavior{ …) has no brace-matched body — the file is ` +
					"unreadable by this parser, which is a hard stop rather than a provider with no hooks.",
			);
		}
		const fields = topLevelFields(body);
		found.push({ slug: m[1], hooks: RUNTIME_READ_HOOKS.filter((h) => fields.has(h)) });
	}
	return found;
}

/**
 * Read every secrets registration in packages/core/categories.
 *
 * Scans the whole directory rather than a `secrets_*.go` glob: the filename is a convention, the
 * `register("secrets", …)` call is the fact. A provider registered from a differently-named file
 * would be invisible to a glob, and invisible reads as "no decision recorded" — see #1510, where a
 * cloud came to be excluded by simply being absent from a table.
 *
 * @returns {Map<string, string[]>} slug → the runtime-read hooks it registers (possibly empty).
 */
export function readSecretsRuntimeRead(dir) {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))
		.sort();
	const out = new Map();
	for (const file of files) {
		for (const { slug, hooks } of parseSecretsRegistrations(readFileSync(join(dir, file), "utf8"))) {
			if (out.has(slug)) {
				throw new Error(
					`secrets slug "${slug}" is registered twice (second in ${file}) — Go's register() panics ` +
						"on a duplicate, so this parse has gone wrong rather than found a real second provider.",
				);
			}
			out.set(slug, hooks);
		}
	}
	if (out.size === 0) {
		throw new Error(
			`no register("secrets", …) calls found under ${dir} — the generator reads that call by shape; ` +
				"if the registration helper was renamed, update parseSecretsRegistrations.",
		);
	}
	return out;
}
