// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one edit Alethia proposes to a GitOps add-on's seeded `addons/<id>.yaml` (#6549): move
// `spec.source.targetRevision` to a newer chart version, and change NOTHING else in the file.
//
// A YAML round-trip (parse, set, stringify) would satisfy "the value changed" and fail "the rest of
// the file is byte-identical": it re-indents, re-quotes, reflows comments and normalises line
// endings. So the edit is textual: parse the file only to FIND the one scalar and to check that the
// file is what Alethia seeded, then splice the new version into that scalar's exact source range,
// keeping its quoting style. The result is then verified twice: the bytes outside the range are the
// original bytes, and a re-parse is the original document with that one value changed.
//
// It refuses rather than guesses, with the same "only when sure" rule as the runner's drift check
// (`gitopsAddOnDrift`, packages/core/provisioner/addons_gitops.go). The two read one fixture table,
// packages/core/provisioner/testdata/addon_bump/cases.json, so they cannot drift apart unnoticed.
// The edit is STRICTER than the drift check in two places, both refusals: a file that also carries
// `spec.sources`, and a `targetRevision` written with a tag, an alias, an anchor (on the value or on
// any map above it) or a block scalar. Those are files the customer has shaped, so they get the
// manual instruction instead of a pull request.

import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, parseAllDocuments, type Document, type Node } from "yaml";
import { compareChartVersions } from "@/lib/addons/update-notice";

/** Why the edit was not made. Each is a file Alethia cannot be sure it may change. */
export type BumpEditRefusal =
	| "not-utf8"
	| "byte-order-mark"
	| "not-yaml"
	| "not-one-document"
	| "not-an-application"
	| "multi-source"
	| "no-source"
	| "different-chart"
	| "revision-not-plain"
	| "revision-not-semver"
	| "target-not-semver"
	| "not-older"
	| "verify-failed";

/** The edit's outcome: the new file bytes, or why there are none. */
export type BumpEditResult =
	| { ok: true; bytes: Uint8Array; from: string }
	| { ok: false; refusal: BumpEditRefusal };

// SemVer 2.0.0 exactly, with an optional leading `v`: no shorthand (`4.11`), no leading zeros, no
// ranges. The same set golang.org/x/mod/semver accepts as a full version, which is the set the
// runner's drift check reports.
const STRICT_SEMVER =
	/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Reports whether `v` is a full SemVer version, optionally `v`-prefixed. */
export function isStrictSemver(v: string): boolean {
	return STRICT_SEMVER.test(v);
}

/**
 * Reports whether any node on the path to the version carries an anchor. An anchored node may be
 * read again by an alias elsewhere in the file, and that copy would change with the splice. The
 * re-parse check below cannot see it: it compares against the original document with the value
 * set, and that clone resolves the alias to the same edited node, so both agree.
 */
function anchoredOnPath(nodes: (Node | null | undefined)[]): boolean {
	return nodes.some((n) => n !== null && n !== undefined && typeof n.anchor === "string" && n.anchor !== "");
}

/** The `spec.source.targetRevision` scalar and the document around it, or the refusal. */
function locateRevision(
	text: string,
	chart: string,
):
	| { ok: true; doc: Document; start: number; end: number; value: string; style: "PLAIN" | "QUOTE_SINGLE" | "QUOTE_DOUBLE" }
	| { ok: false; refusal: BumpEditRefusal } {
	const docs = parseAllDocuments(text);
	if (!Array.isArray(docs)) return { ok: false, refusal: "not-yaml" };
	if (docs.length !== 1) return { ok: false, refusal: "not-one-document" };
	const doc = docs[0];
	if (!doc || doc.errors.length > 0 || doc.warnings.length > 0) return { ok: false, refusal: "not-yaml" };
	const root = doc.contents;
	if (!isMap(root) || doc.get("kind") !== "Application") return { ok: false, refusal: "not-an-application" };
	const spec = doc.get("spec", true);
	if (!isMap(spec)) return { ok: false, refusal: "no-source" };
	if (spec.has("sources")) return { ok: false, refusal: "multi-source" };
	const source = spec.get("source", true);
	if (!isMap(source)) return { ok: false, refusal: "no-source" };
	if (source.get("chart") !== chart) return { ok: false, refusal: "different-chart" };
	const node = source.get("targetRevision", true);
	if (!isScalar(node) || typeof node.value !== "string" || node.tag !== undefined || !node.range) {
		return { ok: false, refusal: "revision-not-plain" };
	}
	if (node.type !== "PLAIN" && node.type !== "QUOTE_SINGLE" && node.type !== "QUOTE_DOUBLE") {
		return { ok: false, refusal: "revision-not-plain" };
	}
	if (anchoredOnPath([root, spec, source, node])) return { ok: false, refusal: "revision-not-plain" };
	const [start, end] = node.range;
	const quote = node.type === "QUOTE_DOUBLE" ? '"' : node.type === "QUOTE_SINGLE" ? "'" : "";
	// The source text of the scalar must BE its value, quoted at most: no escapes, no folding, no
	// comment inside the range. Anything else and the splice below would not be the edit it claims.
	if (text.slice(start, end) !== `${quote}${node.value}${quote}`) return { ok: false, refusal: "revision-not-plain" };
	return { ok: true, doc, start, end, value: node.value, style: node.type };
}

/**
 * Returns `file` with `spec.source.targetRevision` set to `to`, every other byte unchanged, or the
 * reason it will not. `chart` is the catalog chart the file must install. Refuses unless the file's
 * version is a full SemVer version strictly OLDER than `to`.
 */
export function bumpTargetRevision(file: Uint8Array, chart: string, to: string): BumpEditResult {
	if (!isStrictSemver(to)) return { ok: false, refusal: "target-not-semver" };
	if (file[0] === 0xef && file[1] === 0xbb && file[2] === 0xbf) return { ok: false, refusal: "byte-order-mark" };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file);
	} catch {
		return { ok: false, refusal: "not-utf8" };
	}
	const found = locateRevision(text, chart);
	if (!found.ok) return found;
	if (!isStrictSemver(found.value)) return { ok: false, refusal: "revision-not-semver" };
	const order = compareChartVersions(found.value, to);
	if (order === null || order >= 0) return { ok: false, refusal: "not-older" };

	const quote = found.style === "QUOTE_DOUBLE" ? '"' : found.style === "QUOTE_SINGLE" ? "'" : "";
	const next = `${text.slice(0, found.start)}${quote}${to}${quote}${text.slice(found.end)}`;

	// Verify, rather than trust the splice: the untouched halves are the original's, and the edited
	// document is the original document with exactly that one value changed.
	const tail = text.length - found.end;
	if (next.slice(0, found.start) !== text.slice(0, found.start) || next.slice(next.length - tail) !== text.slice(found.end)) {
		return { ok: false, refusal: "verify-failed" };
	}
	const again = locateRevision(next, chart);
	if (!again.ok || again.value !== to || again.style !== found.style) return { ok: false, refusal: "verify-failed" };
	const expected = found.doc.clone();
	expected.setIn(["spec", "source", "targetRevision"], to);
	const want: unknown = expected.toJS();
	const got: unknown = again.doc.toJS();
	if (!isDeepStrictEqual(got, want)) return { ok: false, refusal: "verify-failed" };

	return { ok: true, bytes: new TextEncoder().encode(next), from: found.value };
}
