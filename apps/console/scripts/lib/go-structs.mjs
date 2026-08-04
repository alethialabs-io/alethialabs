// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reading the config-snapshot CONTRACT out of Go: which `json:` keys a struct actually models.
//
// This exists for one defect shape, and it is the quietest one in the stack. The console collects a
// value, the CLI accepts it, the column stores it, `buildConfigSnapshot` serialises it — and the
// runner's `json.Unmarshal` drops it on the floor, because no field on the target struct carries that
// key. Nothing errors. `encoding/json` ignores unknown keys by design, so the deploy is clean, the
// plan is identical, and the only symptom is that the setting did nothing. #1981 shipped a cache
// allow-list that way (the AWS template was fully wired; the Go struct had no field), and #1982
// shipped a DynamoDB global-table region list the same way.
//
// So the question this reader answers is narrow and exact: given a struct name, which `json:` tags
// does it model, INCLUDING through embedded structs? `Placement` is embedded in nearly every
// component config, and a reader that stops at the outer struct reports `region` as unmodelled on
// fifteen kinds — a wall of false accusations from one missing recursion.
//
// TEXT parse, not a Go parse, for the reason go-source.mjs states: a Go program emitting JSON puts a
// compile step between a one-line source edit and the guard meant to catch it. The safety comes from
// failing LOUDLY — `assertParsed` and `selfCheck` below — never from defaulting. A reader that parses
// nothing models nothing, and "models nothing" and "models everything" are equally silent unless
// something asserts in both directions.

import { bracedBodyAt, neutralizeBracesInStrings, stripComments } from "./go-source.mjs";

/**
 * Index every top-level `type <Name> struct { … }` in one Go file.
 *
 * @param {string} text  the file's source
 * @returns {Map<string, Array<{name?: string, type?: string, tag?: string, embed?: string}>>}
 *          struct name → its fields, in declaration order. A field is either `{name, type, tag}`
 *          (tag is the json name with `,omitempty` and friends stripped, or `""` when untagged) or
 *          `{embed}` for an embedded struct type.
 */
export function readGoStructs(text) {
	// Comments first: a field that only exists in a doc comment is not a field, and the brace matcher
	// must not see a `{` from prose. Then neutralize braces inside string literals so a struct tag
	// containing one cannot end the body early — the tags themselves stay readable, which matters
	// because the tag IS the thing being read here.
	const src = neutralizeBracesInStrings(stripComments(text));
	const out = new Map();
	for (const m of src.matchAll(/\btype\s+(\w+)\s+struct\s*\{/g)) {
		const body = bracedBodyAt(src, m.index + m[0].length - 1);
		const fields = [];
		for (const raw of body.split("\n")) {
			const line = raw.trim();
			if (!line) continue;
			// `Name Type `json:"tag"`` — the tag is optional, and a field with none is still a field
			// (it just carries no json key, e.g. `CloudAccountID string `json:"-"``).
			const f = line.match(/^(\w+)\s+([^\s`]+)(?:\s+`([^`]*)`)?/);
			if (f) {
				const jsonTag = f[3]?.match(/json:"([^"]*)"/);
				fields.push({ name: f[1], type: f[2], tag: jsonTag ? jsonTag[1].split(",")[0] : "" });
				continue;
			}
			// An embedded struct is a bare type name on its own line (`Placement`). Anything else on
			// its own line is not a field shape this reader knows, and is skipped rather than guessed
			// at — a guess here would invent a json key nothing carries.
			if (/^\*?\w+$/.test(line)) fields.push({ embed: line.replace(/^\*/, "") });
		}
		out.set(m[1], fields);
	}
	return out;
}

/**
 * The json keys a struct models, flattened through embedded structs.
 *
 * @param {Map<string, Array<object>>} structs  the index from `readGoStructs`
 * @param {string} name                         struct to flatten
 * @returns {Map<string, {field: string, owner: string}>} json key → the Go field carrying it and the
 *          struct that declares it. The owner is what lets a caller tell an own field from one
 *          inherited via `Placement`, which is the difference between a resource KNOB and the
 *          resource's placement — two different questions with two different answers.
 */
export function jsonTagsOf(structs, name, seen = new Set()) {
	const out = new Map();
	if (seen.has(name) || !structs.has(name)) return out;
	seen.add(name);
	for (const f of structs.get(name)) {
		if (f.embed) {
			for (const [k, v] of jsonTagsOf(structs, f.embed, seen)) if (!out.has(k)) out.set(k, v);
			continue;
		}
		if (f.tag && f.tag !== "-") out.set(f.tag, { field: f.name, owner: name });
	}
	return out;
}

/** The element type behind a Go field type — `[]ProjectCacheConfig` / `*NodeSize` → the bare name. */
export const elementType = (type) => type.replace(/^[\[\]*]+/, "");

/**
 * The tripwire. An index with no structs models no key, and a guard built on it reports every field
 * as dropped — a wall of false accusations, or worse, a wall of exclusion entries added to silence
 * them. Named struct required too: `ProjectConfig` is the root every kind resolves through, so its
 * absence means the file moved or the parse broke, not that the product lost its config.
 *
 * @param {Map<string, Array<object>>} structs
 * @param {string} required  a struct name that must be present
 */
export function assertParsed(structs, required) {
	if (structs.size === 0) {
		throw new Error(
			"go-structs parsed 0 structs — the reader is broken, not the contract. A reader that models " +
				"nothing reports every field as dropped by json.Unmarshal.",
		);
	}
	if (!structs.has(required)) {
		throw new Error(
			`go-structs found no \`type ${required} struct\` — every component kind resolves through it, ` +
				"so without it the field surface collapses to nothing and the guard passes on an empty set.",
		);
	}
}

/**
 * Pin the reader against the shapes that have actually bitten, in BOTH directions.
 *
 * Both directions, because the two failure modes are equally silent: a reader that sees nothing
 * accuses everything, and a reader that sees everything accuses nothing. Only asserting a key is
 * ABSENT catches the second.
 */
export function selfCheck() {
	const fixture = `
package types

type Placement struct {
	CloudProvider   CloudProvider \`json:"cloud_provider"\`
	CloudIdentityID string        \`json:"cloud_identity_id"\`
	Region          string        \`json:"region"\`
}

type ProjectCacheConfig struct {
	Placement
	Name string \`json:"name"\`
	// AllowedCidrBlocks []string \`json:"allowed_cidr_blocks"\`  — #1981: commented out is NOT modelled
	MemoryGB      float64 \`json:"memory_gb"\`
	MultiAz       *bool   \`json:"multi_az"\`
	Dropped       string  \`json:"-"\`
	Untagged      string
}

type ProjectConfig struct {
	Caches []ProjectCacheConfig \`json:"caches"\`
	DNS    ProjectDNSConfig     \`json:"dns"\`
	Secret string               \`json:"git_access_token"\`
}
`;
	const fail = (why) => {
		throw new Error(`go-structs self-check failed: ${why}. The reader is wrong; do not trust this run.`);
	};
	const structs = readGoStructs(fixture);
	if (!structs.has("ProjectCacheConfig")) fail("did not index ProjectCacheConfig");
	if (structs.size !== 3) fail(`indexed ${structs.size} structs, expected 3`);

	const tags = jsonTagsOf(structs, "ProjectCacheConfig");
	// The embedded struct's keys must arrive, or every kind reads as dropping `region`.
	if (tags.get("region")?.owner !== "Placement") fail("did not flatten the embedded Placement");
	if (tags.get("cloud_identity_id")?.field !== "CloudIdentityID") fail("lost the embedded field name");
	// The own field must be attributed to the struct itself — the owner is what tells a knob apart
	// from placement, and both are needed by the caller.
	if (tags.get("memory_gb")?.owner !== "ProjectCacheConfig") fail("misattributed an own field");
	if (tags.get("multi_az")?.field !== "MultiAz") fail("lost a pointer field's name");
	// THE #1981 DIRECTION. A field that exists only in a comment must not model a key, or the guard
	// reads a deleted (or never-written) field as present and the defect stays invisible.
	if (tags.has("allowed_cidr_blocks")) fail("read a COMMENTED-OUT field as modelled (#1981's shape)");
	// `json:"-"` is an explicit refusal to carry the value; counting it would launder a dropped field.
	if (tags.has("-")) fail("modelled a `json:\"-\"` field as a carried key");
	if ([...tags.keys()].some((k) => k === "")) fail("modelled an untagged field as a key");

	// The root's own fields carry the kind → struct mapping, so they must survive with their TYPES.
	const root = structs.get("ProjectConfig");
	const caches = root.find((f) => f.tag === "caches");
	if (elementType(caches.type) !== "ProjectCacheConfig") fail("lost the slice element type");
	if (elementType(root.find((f) => f.tag === "dns").type) !== "ProjectDNSConfig") fail("lost a struct field type");

	// And the tripwire itself must fire — an assert that never fires is decoration.
	let threw = false;
	try {
		assertParsed(new Map(), "ProjectConfig");
	} catch {
		threw = true;
	}
	if (!threw) fail("assertParsed accepted an empty index");
}
