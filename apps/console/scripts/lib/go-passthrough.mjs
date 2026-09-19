// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where a component's `provider_config` JSONB actually LANDS, per cloud — read from the Go providers
// rather than remembered.
//
// This was a private function inside check-config-carriage.mjs, where it answered one narrow
// question ("which kinds does this cloud merge at ROOT level"), and its comment already said why it
// is derived instead of asserted: the claim "passthrough covers databases, cluster and DNS" is the
// kind of remembered fact that goes stale. It went stale the moment #4259 landed — seven leaf kinds
// gained a passthrough on five clouds and the old reader saw NONE of them, because they arrive
// through `mergeItemProviderConfig` and inside a builder function.
//
// It is lifted here because a SECOND guard now needs the same answer. `gen-template-knobs.mjs` asks
// it of every declared template variable ("is this knob reachable at all, or is it advertised and
// unsettable"), and a second copy of this reader is a second definition of what a passthrough IS —
// drifting on its own schedule, in the direction where the copy is quieter than the original.
//
// ── THE TWO SHAPES, and why the reader must tell them apart ─────────────────────────────────────
//
//   ROOT  `mergeProviderConfig(tfvars, cache.ProviderConfig, …)` — the component is modelled as
//         root-level VARIABLES (`redis_*`, `ecr_*`), so a key lands on a root tfvar and the question
//         "does the template declare it" is a question about `variables.tf`.
//   ITEM  `mergeItemProviderConfig(entry, b.ProviderConfig, …)` — the component is ONE ENTRY of a
//         map/list variable (`bucket_configuration`, `sqs_queues`), so a key lands on an ATTRIBUTE
//         of that variable's object type. A root variable of the same name would NOT be reached.
//
// Reading an item site as a root binding is the specific wrong answer the Go side renamed the helper
// to prevent (see `mergeItemProviderConfig`'s own comment). So `shape` is carried on every site, and
// the root tfvar the item belongs to is carried with it.
//
// ── ATTRIBUTION, in three steps, each one a way to be silently wrong ────────────────────────────
//
//   1. `config.<Field>.ProviderConfig` — direct. The field's json tag IS the schema key.
//   2. a local (`db`, `cache`, `r`) — the NEAREST binding of that name BEFORE the call, because one
//      body holds several and the FIRST would attribute the database's passthrough to whichever
//      collection happens to be looped first.
//   3. NEW: a local bound to `range <param>` inside a BUILDER — `q` in `buildSQSQueues` ranges over
//      the parameter `queues`, which says nothing on its own. The component is decided by the CALL
//      SITE: `"sqs_queues": buildSQSQueues(config.Queues, config.Topics)` binds parameter 0 to
//      `config.Queues`, so `q` is a queue and its keys land inside the `sqs_queues` root tfvar. This
//      hop is what makes gcp's `buildPubSubTopics(topics, queues)` legible at all — ONE builder with
//      TWO merge sites that belong to two different components.
//
// Anything else is left UNRESOLVED and returned, never guessed. In check-config-carriage passthrough
// only ever adds context to a finding, so an unread site cannot hide a gap there; in
// check-template-knobs an unresolved site is a FAILURE, because there the passthrough scope decides
// whether a knob is reachable and a missing site would silently mark a working knob unreachable.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { indexGoSource, reachableFrom, rootKeyForBuilder } from "./go-tfvars-trace.mjs";

/** A merge call and the receiver whose `provider_config` it merges. `mergeItemProviderConfig` is
 * matched by the SAME expression rather than a second one, so a future third helper named
 * `merge…ProviderConfig` cannot slip past by being spelled differently — the `Item` capture is what
 * decides the shape. */
const MERGE_SITE = /merge(Item)?ProviderConfig\(\s*\w+\s*,\s*([\w.]+)\.ProviderConfig((?:\s*,\s*"[a-z0-9_]+")*)/g;

/**
 * Parameter NAMES, in declaration order, for every top-level func in one Go source.
 *
 * Only the names, and only positionally: the call-site hop needs to turn `queues` into "argument 0",
 * nothing more. Go's grouped parameters (`a, b string`) are expanded, because a grouped pair still
 * occupies two argument positions and collapsing them would shift every later index by one.
 *
 * @param {Map<string, string[]>} into accumulator keyed by function NAME (not by receiver.name —
 *   a builder is a plain function, and the one method this ever asks about takes `config` alone)
 */
export function indexFuncParams(into, text) {
	for (const m of text.matchAll(/\nfunc\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s*)?(\w+)\s*\(([^)]*)\)/g)) {
		const list = m[2];
		// A parameter list holding a `(` never made it into `[^)]*` intact — a func-typed parameter
		// (`cb func(int) error`) truncates the match mid-list, and a truncated list shifts every index
		// after it. Record NO names rather than wrong ones: an index that resolves to nothing leaves
		// the site UNRESOLVED, which is loud, while a shifted index attributes a component to the
		// wrong collection, which is not.
		if (list.includes("(")) {
			into.set(m[1], []);
			continue;
		}
		const names = [];
		for (const group of list.split(",")) {
			const g = group.trim();
			if (!g) continue;
			// `queues []types.ProjectQueueConfig` → the name is the leading identifier. A grouped
			// `a, b string` splits into `a` (a bare identifier, still one argument position) and
			// `b string`. An unnamed parameter yields "" and holds its position.
			const named = g.match(/^([A-Za-z_]\w*)\s+\S/);
			if (named) names.push(named[1]);
			else names.push(/^[A-Za-z_]\w*$/.test(g) ? g : "");
		}
		into.set(m[1], names);
	}
	return into;
}

/** Every non-test Go file's parameter index for a package directory. */
export function readFuncParams(dir) {
	const out = new Map();
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".go") || entry.name.endsWith("_test.go")) continue;
		indexFuncParams(out, readFileSync(join(dir, entry.name), "utf8"));
	}
	return out;
}

/**
 * The argument expression bound to parameter `index` of `fn`, at the call site that assigns the
 * builder's result to a tfvars key — the only call site that matters, because a builder whose result
 * reaches no tfvars key reaches no plan.
 *
 * Split on top-level commas: `buildDDBTables(config.NosqlTables, "standard")` has a literal in it,
 * and a naive split would still work — but `f(g(a, b), c)` would not, and a call graph that already
 * nests one level is one edit from nesting two.
 */
function argAt(pkg, reachable, fnName, index) {
	for (const key of reachable) {
		const body = pkg.funcs.get(key)?.body ?? "";
		const call = body.match(new RegExp(`(?:\\w+\\.)?${fnName}\\s*\\(`));
		if (!call) continue;
		let i = call.index + call[0].length;
		let depth = 0;
		let start = i;
		const args = [];
		for (; i < body.length; i++) {
			const ch = body[i];
			if (ch === "(" || ch === "[" || ch === "{") depth++;
			else if (ch === ")" && depth === 0) break;
			else if (ch === ")" || ch === "]" || ch === "}") depth--;
			else if (ch === "," && depth === 0) {
				args.push(body.slice(start, i).trim());
				start = i + 1;
			}
		}
		args.push(body.slice(start, i).trim());
		if (args[index]) return args[index];
	}
	return null;
}

/**
 * Which components each cloud's provider carries a `provider_config` for, and where their keys land.
 *
 * @param {object} pkg the indexed Go package (`readGoPackage` from lib/go-tfvars-trace.mjs)
 * @param {Map<string, string[]>} params the parameter index (`readFuncParams`)
 * @param {Map<string, string>} fieldTag ProjectConfig's Go field name → its json tag (the schema key)
 * @param {string[]} clouds the clouds that HAVE a `<cloud>Provider.ProviderTfvars`
 * @returns {{byCloud: Record<string, Map<string, {shape: string, roots: string[]}>>, sites: object[],
 *   unresolved: {cloud: string, fn: string, expr: string}[]}}
 */
export function readPassthrough(pkg, params, fieldTag, clouds) {
	const byCloud = {};
	const sites = [];
	const unresolved = [];
	for (const cloud of clouds) {
		const found = (byCloud[cloud] = new Map());
		const reachable = reachableFrom(pkg, `${cloud}Provider.ProviderTfvars`);
		for (const key of reachable) {
			const fn = pkg.funcs.get(key);
			if (!fn) continue;
			for (const m of fn.body.matchAll(MERGE_SITE)) {
				const shape = m[1] ? "item" : "root";
				const expr = m[2];
				// The `reserved` names on the call — keys the typed code consumed under another tfvar
				// name, emitted conditionally, or WITHDRAWN. The merge skips them unconditionally, so a
				// reserved key is one no `provider_config` can ever set: the caller needs them to tell a
				// knob a user can reach from one the provider owns.
				const reserved = [...m[3].matchAll(/"([a-z0-9_]+)"/g)].map((r) => r[1]);
				const before = fn.body.slice(0, m.index);
				/** Record one attributed site under its schema key, keeping every root it lands in. */
				const record = (schemaKey, root) => {
					if (!found.has(schemaKey)) found.set(schemaKey, { shape, roots: [] });
					const e = found.get(schemaKey);
					// A component merged BOTH ways on one cloud is not a shape this reader can flatten,
					// and today none is. Say so rather than keeping whichever came first.
					if (e.shape !== shape) e.shape = "mixed";
					if (root && !e.roots.includes(root)) e.roots.push(root);
					sites.push({ cloud, fn: fn.name, schemaKey, shape, root: root ?? null, reserved });
				};

				// 1 · `config.<Field>.ProviderConfig`
				const direct = expr.match(/^config\.(\w+)$/);
				if (direct && fieldTag.has(direct[1])) {
					record(fieldTag.get(direct[1]), shape === "item" ? rootKeyForBuilder(pkg, reachable, fn.name) : null);
					continue;
				}

				// 2 · the NEAREST binding of that local to a `config.<Field>` — `db := config.Databases[0]`
				//     on three clouds and `for _, r := range config.ContainerRegistries` on others, so the
				//     match is on the BINDING, not on the loop keyword.
				const bind = [...before.matchAll(new RegExp(`\\b${expr}\\s*:=\\s*[^\\n]*config\\.(\\w+)`, "g"))].pop();
				if (bind && fieldTag.has(bind[1])) {
					record(fieldTag.get(bind[1]), shape === "item" ? rootKeyForBuilder(pkg, reachable, fn.name) : null);
					continue;
				}

				// 3 · a local bound to `range <param>` inside a builder — resolved through the CALL SITE.
				const ranged = [...before.matchAll(new RegExp(`\\b${expr}\\s*:=\\s*range\\s+([A-Za-z_]\\w*)\\b`, "g"))].pop();
				const idx = ranged ? (params.get(fn.name) ?? []).indexOf(ranged[1]) : -1;
				if (idx >= 0) {
					const arg = argAt(pkg, reachable, fn.name, idx);
					const viaParam = arg?.match(/^config\.(\w+)$/);
					if (viaParam && fieldTag.has(viaParam[1])) {
						record(fieldTag.get(viaParam[1]), rootKeyForBuilder(pkg, reachable, fn.name));
						continue;
					}
				}

				unresolved.push({ cloud, fn: fn.name, expr });
			}
		}
	}
	return { byCloud, sites, unresolved };
}

/** Every key RESERVED across a cloud's merge sites for one component — the keys its passthrough is
 * refused, whatever the template declares. Unioned across sites because a component can be merged at
 * more than one call (aws merges every native registry in a loop). */
export function reservedKeys(pt, cloud, schemaKey) {
	return new Set(pt.sites.filter((s) => s.cloud === cloud && s.schemaKey === schemaKey).flatMap((s) => s.reserved));
}

/** The schema keys a cloud's passthrough reaches, sorted — the shape a report line wants. */
export function passthroughKeys(pt, cloud) {
	return [...(pt.byCloud[cloud]?.keys() ?? [])].sort();
}

/**
 * The tripwire. A reader that matched no merge site reports that NOTHING is reachable — which in
 * check-template-knobs marks every declared knob unreachable and in check-config-carriage silently
 * deletes the one line telling a reader a knob is settable by hand. Both are failures that read as
 * ordinary output.
 *
 * The floor is deliberately far below today's count (41 sites across five providers) and far above
 * zero: it catches a reader that stopped, not a provider that lost a call.
 */
export function assertParsed(pt) {
	if (pt.sites.length < 20) {
		throw new Error(
			`go-passthrough matched ${pt.sites.length} merge site(s) across the providers, below the floor of 20 — ` +
				"the reader is broken, not the providers. A passthrough reader that matches nothing reports every " +
				"knob unreachable and every kind uncovered.",
		);
	}
}

/**
 * Pin the reader against a fixture, in BOTH directions, every run.
 *
 * The fixture is one miniature provider carrying every shape that appears in the five real ones: a
 * direct `config.X.ProviderConfig`, an indexed local (`db := config.Databases[0]`), a `range` over a
 * collection in the same body, a builder whose loop ranges over a PARAMETER, a builder with TWO such
 * loops over two different parameters (gcp's Pub/Sub shape), a builder called by index assignment
 * rather than in a map literal (hetzner's buckets), and an UNATTRIBUTABLE site — which must be
 * reported, because a reader that quietly drops what it cannot read is a reader that reports full
 * coverage of a provider it half understood.
 */
export function selfCheck() {
	const src = `
package cloud

func (p *fxProvider) ProviderTfvars(config *types.ProjectConfig) map[string]interface{} {
	tfvars := map[string]interface{}{
		"fx_queues":  buildQueues(config.Queues, config.Topics),
		"fx_streams": buildStreams(config.Topics, config.Queues),
	}
	tfvars["fx_buckets"] = buildBuckets(config.StorageBuckets)
	if len(config.Databases) > 0 {
		db := config.Databases[0]
		mergeProviderConfig(tfvars, db.ProviderConfig, "log_exports")
	}
	for _, r := range config.ContainerRegistries {
		mergeProviderConfig(tfvars, r.ProviderConfig, "provision_fx")
	}
	mergeProviderConfig(tfvars, config.Cluster.ProviderConfig)
	mergeProviderConfig(tfvars, mystery.ProviderConfig)
	return tfvars
}

func buildQueues(queues []types.ProjectQueueConfig, topics []types.ProjectTopicConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for _, q := range queues {
		entry := map[string]interface{}{"name": q.Name}
		mergeItemProviderConfig(entry, q.ProviderConfig, "name")
		result[q.Name] = entry
	}
	return result
}

func buildStreams(topics []types.ProjectTopicConfig, queues []types.ProjectQueueConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for _, t := range topics {
		entry := map[string]interface{}{"name": t.Name}
		mergeItemProviderConfig(entry, t.ProviderConfig, "name")
		result[t.Name] = entry
	}
	return result
}

func buildBuckets(buckets []types.ProjectStorageBucketConfig) []map[string]interface{} {
	result := []map[string]interface{}{}
	for _, b := range buckets {
		entry := map[string]interface{}{"name": b.Name}
		mergeItemProviderConfig(entry, b.ProviderConfig, "name")
		result = append(result, entry)
	}
	return result
}
`;
	const pkg = indexGoSource({ funcs: new Map(), byName: new Map(), dir: "fx" }, "fx/fx_provider.go", src);
	const params = indexFuncParams(new Map(), src);
	const fieldTag = new Map([
		["Queues", "queues"],
		["Topics", "topics"],
		["StorageBuckets", "storage_buckets"],
		["Databases", "databases"],
		["ContainerRegistries", "container_registries"],
		["Cluster", "cluster"],
	]);

	/** Abort with the reason the reader is untrustworthy — never a flag the caller can ignore. */
	const fail = (msg) => {
		throw new Error(`go-passthrough self-check failed: ${msg}. The reader is wrong; do not trust this run.`);
	};

	const pt = readPassthrough(pkg, params, fieldTag, ["fx"]);
	const got = pt.byCloud.fx;

	// The four the OLD reader could see must still be seen — a lift that loses a case is a lift that
	// makes check-config-carriage quieter without changing a line of its own.
	if (!got.has("databases")) fail("`db := config.Databases[0]` was not attributed to databases");
	if (!got.has("container_registries")) fail("`range config.ContainerRegistries` was not attributed");
	if (!got.has("cluster")) fail("`config.Cluster.ProviderConfig` was not attributed");
	if (got.get("cluster").shape !== "root") fail("a `mergeProviderConfig` site must read as shape root");

	// The three the extension exists for.
	if (!got.has("queues")) fail("a builder ranging over its `queues` PARAMETER was not attributed through the call site");
	if (got.get("queues").shape !== "item") fail("a `mergeItemProviderConfig` site must read as shape item");
	if (!got.get("queues").roots.includes("fx_queues")) fail("the queue item site must land inside the `fx_queues` root tfvar");
	// TWO loops in one builder over two parameters — the shape that makes positional resolution
	// necessary. `topics` is parameter 0 of buildStreams and parameter 1 of buildQueues; reading the
	// wrong one silently swaps two components.
	if (!got.has("topics")) fail("the second builder's `range topics` was not attributed");
	if (!got.get("topics").roots.includes("fx_streams")) fail("the topic item site must land inside `fx_streams`, not `fx_queues`");
	if (got.get("queues").roots.includes("fx_streams")) fail("a queue site was attributed to the topic builder's root — the parameter index is being ignored");
	// A builder assigned by INDEX rather than in a map literal (`tfvars["fx_buckets"] = …`).
	if (!got.get("storage_buckets")?.roots.includes("fx_buckets")) fail("an index-assigned builder's root tfvar was not resolved");

	// The direction that matters most: an unreadable site must be REPORTED, not dropped.
	if (pt.unresolved.length !== 1) fail(`expected exactly 1 unresolved site, saw ${pt.unresolved.length}`);
	if (pt.unresolved[0].expr !== "mystery") fail(`the unresolved site should be \`mystery\`, saw \`${pt.unresolved[0].expr}\``);
	if (got.has("mystery")) fail("an unattributed site was invented as its own component");

	// A reserved key is one the merge REFUSES; reading it as settable is how a UI offers a control
	// that saves cleanly and changes nothing.
	if (!reservedKeys(pt, "fx", "databases").has("log_exports")) fail("`log_exports` is reserved on the database merge and was not collected");
	if (reservedKeys(pt, "fx", "cluster").size !== 0) fail("the cluster merge reserves nothing and reported reservations");

	if (passthroughKeys(pt, "fx").join(",") !== "cluster,container_registries,databases,queues,storage_buckets,topics") {
		fail(`the reported key set is wrong: ${passthroughKeys(pt, "fx").join(",")}`);
	}
}
