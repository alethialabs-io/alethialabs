// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The TEMPLATE-KNOB MANIFEST: every variable the five project templates declare, which canvas
// component it belongs to, and whether a user can actually set it.
//
// `infra/templates/project/CUSTOMIZABILITY-PARITY.md` has said for a year that "full customizability
// already exists for any variable the template declares", with a footnote that a knob must ALSO be
// reachable through some component's `provider_config`. Two claims, both true, and neither one
// measured — the page's own closing paragraph said so: "no guard can red any cell on this page".
// This is that guard's input. It answers the two claims per variable, per cloud:
//
//   DECLARED   the template's root module declares it (`lib/tf-variables.mjs`).
//   REACHABLE  a component's `provider_config` merge lands on it (`lib/go-passthrough.mjs`).
//   READ       a resource or module argument consumes it (`lib/tf-wiring.mjs`).
//
// The third is what turns a count into a measure. GCP's `gke_spot` was declared, defaulted `true`,
// and read by no resource on any code path: the template advertised Spot node pools it never
// provisioned, and a raw variable count credited that dead declaration exactly as much as a working
// knob. `readBy` is empty for exactly that shape, and check-template-knobs.mjs fails on it.
//
// ── WHAT AN ENTRY IS ────────────────────────────────────────────────────────────────────────────
//
// Two kinds of entry, because #4259 gave the passthrough two shapes and flattening them would offer
// a user a key the merge cannot land:
//
//   ROOT   a root variable. Settable through `provider_config` only when that component's merge is
//          ROOT-shaped (`mergeProviderConfig(tfvars, …)`) — the cluster's, the DNS's, a database's,
//          a cache's, and the registry's on aws/azure.
//   ITEM   an ATTRIBUTE of the object type of the variable a component is modelled as one entry of
//          (`sqs_queues`, `bucket_configuration`). Settable when that component's merge is
//          ITEM-shaped (`mergeItemProviderConfig(entry, …)`), and `itemScope` names the variable the
//          attribute lives on. A ROOT variable attributed to an item-shaped component is NOT
//          reachable — `sqs_queues` is what a queue's provider_config reaches INTO, not something a
//          queue can set — and the manifest says so rather than rounding it up.
//
// ── COMPONENT ATTRIBUTION, and why it is a table ────────────────────────────────────────────────
//
// A variable does not say which component it belongs to; the WIRING does. The ladder, cheapest sound
// question first:
//
//   0. the variable IS the root key a component's item passthrough lands in (`sqs_queues`) — read
//      from the Go side, so it needs no table at all.
//   0b. exactly one component's merge site RESERVES the name. A reserved key is one the provider
//      emits for that component under its own name, so the Go side has already said who owns it —
//      and it is the signal that keeps `rds_iam_irsa` (read only by `irsa.tf`) with the database
//      rather than the cluster, which in turn keeps every `rds_*` knob unanimous for step 4.
//   1. the module directories it threads into (`COMPONENT_OF_DIR`). A module is named for the thing
//      it builds, so this is the strongest signal available and it covers 58% of the surface.
//   2. the ROOT files whose resource/module arguments read it (`COMPONENT_OF_ROOT_FILE`). Needed
//      because a third of every cloud's root variables thread into no module at all, and ALL of
//      hetzner's do — the Talos template has no `modules/` directory. `checks_*.tf`, `outputs.tf`,
//      `locals.tf`, `main.tf` and `variables.tf` attribute NOTHING: an assertion, an output and a
//      variable's own validation build no infrastructure, which is the same carve-out
//      `tf-wiring.mjs` makes for the same reason.
//   3. more than one component after 1 and 2 → `platform`. A variable threaded into eleven modules
//      is not one component's knob; `region`, `environment`, `project_name`, `location`, `vpc_id`
//      and `network_cidr` are every one of the multi-component cases but one.
//   4. the longest `_`-prefix it shares with variables steps 1–3 already placed, when every one of
//      them agrees. This is not a naming convention dressed up as a rule: it is what catches the
//      knobs that matter most. `gke_enable_private_nodes` is read by NOTHING, so no module thread and
//      no root file can speak for it — and a variable nothing reads is exactly the defect this
//      manifest exists to surface. Leaving it unattributed would move it into the exclusions ledger,
//      where a dead knob would sit recorded as a decision. It is derived from this cloud's own
//      attributed variables rather than a hand-written prefix table, so it cannot drift from them,
//      and unanimity is required — `azure_*` spans six components and buys nothing.
//
// A variable that survives all four steps unattributed FAILS this generator. It must be recorded in
// `infra/templates/project/knob-exclusions.yaml` with a reason — the same bargain the offer and
// carriage guards take, for the same reason: a generator that silently drops what it cannot classify
// reports a clean, shrinking surface while the surface grows.
//
// Run: `pnpm -C apps/console run gen:template-knobs` (writes), `check:template-knobs` (asserts + regenerates).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

import {
	assertParsed as assertPassthroughParsed,
	readFuncParams,
	readPassthrough,
	reservedKeys,
	selfCheck as passthroughSelfCheck,
} from "./lib/go-passthrough.mjs";
import { readGoStructs, selfCheck as goStructsSelfCheck } from "./lib/go-structs.mjs";
import { readGoPackage, selfCheck as goTraceSelfCheck, traceField } from "./lib/go-tfvars-trace.mjs";
import { neutralizeBracesInStrings, stripComments } from "./lib/go-source.mjs";
import {
	assertParsed as assertVariablesParsed,
	objectAttributeTypesIn,
	readTfVariables,
	selfCheck as variablesSelfCheck,
} from "./lib/tf-variables.mjs";
import { assertParsed as assertWiringParsed, readTfWiring, selfCheck as wiringSelfCheck } from "./lib/tf-wiring.mjs";

// Before anything is measured, prove the readers still read. Each pins itself against a fixture in
// BOTH directions — a reader that sees nothing and a reader that sees everything are equally silent.
goTraceSelfCheck();
wiringSelfCheck();
goStructsSelfCheck();
variablesSelfCheck();
passthroughSelfCheck();

const ROOT = "../..";
const TEMPLATES = `${ROOT}/infra/templates/project`;
const PROVIDERS = `${ROOT}/packages/core/cloud`;
const TYPES = `${ROOT}/packages/core/types/project_config.go`;
const NODE_REGISTRY = "components/design-project/canvas/graph/node-registry.ts";
const EXCLUSIONS = `${TEMPLATES}/knob-exclusions.yaml`;
const JSON_OUT = "lib/cloud-providers/generated/template-knobs.json";
const DOC_OUT = `${ROOT}/docs/testing/template-knobs.md`;

/** Module directory (relative to the templates root) → the canvas component it builds.
 *
 * Hand-written, and it has to be: a directory name is a human's word for a cloud service, and no
 * derivation turns `awssm-passgen` into `secret` or `wafv2` into `dns`. It is small, it is checked
 * (a module dir absent from here contributes nothing and its variables fall to step 2 or fail), and
 * every line of it is one editable fact rather than a rule with exceptions. */
const COMPONENT_OF_DIR = {
	"aws/modules/acm": "dns",
	"aws/modules/awssm-passgen": "secret",
	"aws/modules/dynamodb": "nosql",
	"aws/modules/ecr": "registry",
	"aws/modules/eks": "cluster",
	"aws/modules/rds": "database",
	"aws/modules/redis": "cache",
	"aws/modules/route53": "dns",
	"aws/modules/s3": "bucket",
	// One module builds both SQS queues and SNS topics, so it cannot decide between them. It is left
	// out on purpose: step 0 resolves `sqs_queues` and `sns_topics` from the Go side, which knows.
	"aws/modules/valkey": "cache",
	// The WAF is bought and configured as part of the ingress/DNS story — `application_waf` and
	// `cloudfront_waf` are reserved keys of the DNS component's passthrough, not of a WAF component.
	"aws/modules/wafv2": "dns",
	"gcp/modules/artifact-registry": "registry",
	"gcp/modules/cloud-armor": "dns",
	"gcp/modules/cloud-dns": "dns",
	"gcp/modules/cloud-sql": "database",
	"gcp/modules/cloud-storage": "bucket",
	"gcp/modules/firestore": "nosql",
	"gcp/modules/gke": "cluster",
	"gcp/modules/memorystore": "cache",
	"gcp/modules/memorystore-valkey": "cache",
	// A Pub/Sub topic IS the primitive; a canvas queue is a topic plus one subscription, and both
	// components' passthrough lands in the same `pubsub_topics` variable. Attributed to the topic,
	// with the queue reaching the same item attributes through step 0.
	"gcp/modules/pubsub": "topic",
	"gcp/modules/secret-manager": "secret",
	"gcp/modules/vpc-network": "network",
	"azure/modules/acr": "registry",
	"azure/modules/aks": "cluster",
	"azure/modules/azure-cache-redis": "cache",
	"azure/modules/azure-db": "database",
	"azure/modules/azure-dns": "dns",
	"azure/modules/azure-waf": "dns",
	"azure/modules/cosmos-db": "nosql",
	"azure/modules/key-vault": "secret",
	"azure/modules/storage-account": "bucket",
	"azure/modules/vnet": "network",
	"alibaba/modules/cluster": "cluster",
	"alibaba/modules/cr": "registry",
	"alibaba/modules/dns": "dns",
	// KMS here is the control-plane secret-encryption key the cluster is built with, not a secret
	// component's store.
	"alibaba/modules/kms": "cluster",
	"alibaba/modules/kvstore": "cache",
	"alibaba/modules/network": "network",
	"alibaba/modules/oss": "bucket",
	"alibaba/modules/ots": "nosql",
	"alibaba/modules/rds": "database",
};

/** Root `.tf` file (relative to the templates root) → the component its resources build.
 *
 * The second half of attribution, and not optional: 159 of the 380 root variables thread into no
 * module, and every one of hetzner's does — the Talos template has no `modules/` at all. Keyed by
 * file because a root template's files ARE its component boundary; `rds.tf` builds the database. */
const COMPONENT_OF_ROOT_FILE = {
	"aws/acm-certificate.tf": "dns",
	"aws/cost_guards.tf": "platform",
	"aws/connector-providers.tf": "platform",
	"aws/custom_secrets.tf": "secret",
	"aws/dynamodb.tf": "nosql",
	"aws/ecr.tf": "registry",
	"aws/eks.tf": "cluster",
	"aws/elasticache.tf": "cache",
	"aws/helm-repo-pull.tf": "platform",
	"aws/irsa.tf": "cluster",
	"aws/karpenter.tf": "cluster",
	"aws/networking.tf": "network",
	"aws/rds.tf": "database",
	"aws/registry-pull.tf": "platform",
	"aws/route53.tf": "dns",
	"aws/s3.tf": "bucket",
	"aws/secrets-xacct.tf": "secret",
	"aws/sqs.tf": "queue",
	"aws/valkey.tf": "cache",
	"aws/waf.tf": "dns",
	"gcp/app-db-identity.tf": "database",
	"gcp/artifact-registry.tf": "registry",
	"gcp/cloud-armor.tf": "dns",
	"gcp/cloud-dns.tf": "dns",
	"gcp/cloud-sql.tf": "database",
	"gcp/cloud-storage.tf": "bucket",
	"gcp/connector-providers.tf": "platform",
	"gcp/existing-network.tf": "network",
	"gcp/firestore.tf": "nosql",
	"gcp/gke.tf": "cluster",
	"gcp/memorystore.tf": "cache",
	"gcp/memorystore-valkey.tf": "cache",
	"gcp/networking.tf": "network",
	"gcp/pubsub.tf": "topic",
	"gcp/registry-pull.tf": "platform",
	"gcp/secret-manager.tf": "secret",
	"gcp/secrets-encryption.tf": "cluster",
	"gcp/workload-identity.tf": "cluster",
	"azure/acr.tf": "registry",
	"azure/aks.tf": "cluster",
	"azure/app-db-identity.tf": "database",
	"azure/application-gateway.tf": "dns",
	"azure/azure-cache-redis.tf": "cache",
	"azure/azure-db.tf": "database",
	"azure/azure-dns.tf": "dns",
	"azure/azure-waf.tf": "dns",
	"azure/connector-providers.tf": "platform",
	"azure/cosmos-db.tf": "nosql",
	"azure/existing-network.tf": "network",
	"azure/key-vault.tf": "secret",
	"azure/registry-pull.tf": "platform",
	"azure/secrets-encryption.tf": "cluster",
	"azure/service-bus.tf": "queue",
	"azure/storage-account.tf": "bucket",
	"azure/vnet.tf": "network",
	"azure/workload-identity.tf": "cluster",
	"alibaba/ack-version.tf": "cluster",
	"alibaba/cluster.tf": "cluster",
	"alibaba/cluster-admins.tf": "cluster",
	"alibaba/connector-providers.tf": "platform",
	"alibaba/cr.tf": "registry",
	"alibaba/dns.tf": "dns",
	"alibaba/kms.tf": "cluster",
	"alibaba/kvstore.tf": "cache",
	"alibaba/mns.tf": "queue",
	"alibaba/network.tf": "network",
	"alibaba/oss.tf": "bucket",
	"alibaba/ots.tf": "nosql",
	"alibaba/rds.tf": "database",
	"alibaba/secrets-encryption.tf": "cluster",
	"alibaba/workload-identity.tf": "cluster",
	"hetzner/buckets.tf": "bucket",
	"hetzner/cilium.tf": "cluster",
	"hetzner/connector-providers.tf": "platform",
	"hetzner/csi.tf": "cluster",
	"hetzner/dns.tf": "dns",
	"hetzner/image.tf": "cluster",
	"hetzner/network.tf": "network",
	"hetzner/servers.tf": "cluster",
	"hetzner/talos.tf": "cluster",
};

/** Root files that attribute NOTHING, whatever they mention.
 *
 * `tofu check` never blocks an apply, so a variable read by a `checks_*.tf` assertion reaches no
 * infrastructure and cannot be evidence of which component it belongs to. `outputs.tf` reports,
 * `locals.tf` and `main.tf` are cross-cutting by construction, and `variables.tf` reading its own
 * name is a validation condition. `tf-wiring.mjs` carves out the same block types for the same
 * reason; this is the file-level shadow of that rule. */
const NON_ATTRIBUTING = /^(checks(_\w+)?|locals|main|outputs|variables|providers|versions)\.tf$/;

/** Every `.tf` file under a directory, recursively, comments stripped, WITH its path — the shape the
 * readers want, and the path is load-bearing (a root tfvar is a promise only the root module makes). */
function readTfFiles(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === ".terraform") continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) out.push(...readTfFiles(full));
		else if (e.name.endsWith(".tf")) {
			out.push({
				path: full,
				text: readFileSync(full, "utf8")
					.split("\n")
					.map((l) => l.replace(/(^|\s)(#|\/\/).*$/, ""))
					.join("\n"),
			});
		}
	}
	return out;
}

/**
 * The directories that CONSUME a root variable — the root module itself, plus every module directory
 * it is threaded into that reads the argument it arrives as.
 *
 * The rename is the whole difficulty: `cloud_storage_buckets` becomes `buckets` inside
 * `modules/cloud-storage`, so asking "which dirs read `var.cloud_storage_buckets`" answers "the root
 * one" and stops. `carriersOf` already walks the chain and names each hop's own variable; this asks
 * the read question ONCE PER HOP, under that hop's name.
 *
 * Empty means the value reaches no resource or module argument anywhere — the `gke_spot` shape.
 */
function consumingDirs(wiring, root) {
	const out = new Set();
	for (const carrier of wiring.carriersOf(root)) for (const dir of wiring.readDirsOf(root, carrier.name, true)) out.add(dir);
	return [...out].sort();
}

/** Canvas node kind → the `ProjectFormData` key its config lands under (`nosql` → `nosql_tables`).
 *
 * Read from the node registry's own `schemaKey`, never restated: the join between the canvas's
 * vocabulary and the Go contract's is declared once in the product, and a second copy here would be
 * a second definition that drifts. check-config-carriage.mjs reads the same declaration the same way. */
function readSchemaKeys() {
	const src = readFileSync(NODE_REGISTRY, "utf8");
	const body = src.slice(src.indexOf("export const NODE_REGISTRY"));
	const kinds = [...body.matchAll(/\n\t(\w+): \{/g)];
	const out = new Map();
	for (let i = 0; i < kinds.length; i++) {
		const seg = body.slice(kinds[i].index, kinds[i + 1]?.index ?? body.length);
		const k = seg.match(/schemaKey:\s*"([a-z_]+)"/);
		if (k) out.set(k[1], kinds[i][1]);
	}
	return out;
}

/** Minimal reader for the flat `- <key>: … reason: …` sections of the exclusions yaml (no YAML dep in
 * this package — the two neighbouring guards read their ledgers exactly this way). */
function readExclusions() {
	if (!existsSync(EXCLUSIONS)) return [];
	const out = [];
	let cur = null;
	let section = "";
	for (const raw of readFileSync(EXCLUSIONS, "utf8").split("\n")) {
		// Only FULL-LINE comments are stripped: an inline strip would eat the `#` of `issue: "#4260"`.
		if (/^\s*#/.test(raw)) continue;
		const line = raw.trimEnd();
		if (!line.trim()) continue;
		const head = line.match(/^(cells|variables|dead):\s*$/);
		if (head) {
			if (cur) {
				out.push(cur);
				cur = null;
			}
			section = head[1];
			continue;
		}
		const start = line.match(/^\s*-\s+(\w+):\s*(.+)$/);
		if (start) {
			if (cur) out.push(cur);
			cur = { section, [start[1]]: start[2].trim().replace(/^["']|["']$/g, "") };
			continue;
		}
		const kv = line.match(/^\s+(\w+):\s*(.+)$/);
		if (kv && cur) cur[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
	}
	if (cur) out.push(cur);
	return out;
}

/**
 * The root tfvars keys a cloud's provider WRITES, split by whether the write is unconditional.
 *
 * This is what decides `ownedByProvider`, and the split is the whole point. `mergeProviderConfig` is
 * merge-if-absent: a key the provider always writes is one a `provider_config` key can never reach,
 * however plainly the template declares it — so offering it in a UI would produce a control that
 * saves cleanly and changes nothing. A key written only INSIDE an `if` is reachable whenever the
 * branch does not run, so it is typed but not owned.
 *
 * Unconditional = a key of the top-level `map[string]interface{}{…}` literal (always constructed),
 * or a `tfvars["k"] = …` at the function body's own brace depth. Reserved keys are owned by
 * definition: the merge SKIPS them.
 */
function providerKeys(pkg, cloud) {
	const fn = pkg.funcs.get(`${cloud}Provider.ProviderTfvars`);
	if (!fn) return { all: new Set(), unconditional: new Set() };
	const raw = stripComments(fn.body);
	const neutral = neutralizeBracesInStrings(raw).replace(/interface\{\}/g, "interface..").replace(/struct\{\}/g, "struct..");
	const all = new Set();
	const unconditional = new Set();
	let depth = 0;
	for (let i = 0; i < neutral.length; i++) {
		const ch = neutral[i];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		else {
			// `"key":` inside the top-level literal, which sits at depth 1 of the body.
			const lit = /^"([a-z0-9_]+)"\s*:/.exec(raw.slice(i, i + 80));
			if (lit && raw[i] === '"') {
				all.add(lit[1]);
				if (depth === 1) unconditional.add(lit[1]);
			}
			const idx = /^tfvars\["([a-z0-9_]+)"\]\s*=/.exec(raw.slice(i, i + 80));
			if (idx && raw.startsWith("tfvars[", i)) {
				all.add(idx[1]);
				if (depth === 0) unconditional.add(idx[1]);
			}
		}
	}
	return { all, unconditional };
}

// ── the measurement ─────────────────────────────────────────────────────────────────

const SCHEMA_TO_KIND = readSchemaKeys();
const GO_PKG = readGoPackage(PROVIDERS);
const STRUCTS = readGoStructs(readFileSync(TYPES, "utf8"));
const CLOUDS = readdirSync(TEMPLATES, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.filter((c) => !traceField(GO_PKG, c, "AlethiaProbeField").entryMissing)
	.sort();

const PASSTHROUGH = readPassthrough(
	GO_PKG,
	readFuncParams(PROVIDERS),
	new Map((STRUCTS.get("ProjectConfig") ?? []).filter((f) => f.name && f.tag).map((f) => [f.name, f.tag])),
	CLOUDS,
);
assertPassthroughParsed(PASSTHROUGH);

const EXCLUDED = readExclusions();
/** Is this (cloud, component) cell recorded as having no OpenTofu passthrough surface? `cloud: "*"`
 * covers a component that is architecturally the same on every cloud (`platform`). */
const excludedCell = (cloud, component) =>
	EXCLUDED.find((e) => e.section === "cells" && (e.cloud === cloud || e.cloud === "*") && e.component === component);
/** Is this (cloud, variable) recorded as unattributable? */
const excludedVariable = (cloud, name) => EXCLUDED.find((e) => e.section === "variables" && e.cloud === cloud && e.variable === name);

/** The component each cloud's item-shaped passthrough lands in, keyed by the ROOT variable it lands
 * on: `sqs_queues` → [queue]. Derived, so step 0 needs no table. */
function itemRoots(cloud) {
	const out = new Map();
	for (const [schemaKey, info] of PASSTHROUGH.byCloud[cloud] ?? []) {
		const kind = SCHEMA_TO_KIND.get(schemaKey);
		if (!kind || info.shape !== "item") continue;
		for (const root of info.roots) out.set(root, [...(out.get(root) ?? []), kind]);
	}
	return out;
}

const entries = [];
const unattributed = [];

for (const cloud of CLOUDS) {
	const files = readTfFiles(`${TEMPLATES}/${cloud}`);
	const rootDir = normalize(`${TEMPLATES}/${cloud}`);
	const wiring = readTfWiring(files, rootDir);
	assertWiringParsed(cloud, wiring);
	const rootFiles = files.filter((f) => normalize(dirname(f.path)) === rootDir);
	const variables = readTfVariables(rootFiles);
	assertVariablesParsed(cloud, variables);

	const goKeys = providerKeys(GO_PKG, cloud);
	const itemRootOf = itemRoots(cloud);

	/** Which components a name's WIRING points at, from the module dirs it threads into and the root
	 * files that read it. Both halves are collected before either is judged, because "more than one"
	 * is itself an answer (step 3) and a first-match walk cannot see it. */
	const componentsOf = (name) => {
		const found = new Set();
		for (const dir of consumingDirs(wiring, name)) {
			const rel = relative(TEMPLATES, dir);
			if (COMPONENT_OF_DIR[rel]) found.add(COMPONENT_OF_DIR[rel]);
		}
		if (found.size) return found;
		for (const f of rootFiles) {
			const base = f.path.split("/").pop();
			if (NON_ATTRIBUTING.test(base)) continue;
			if (!new RegExp(`\\bvar\\.${name}\\b`).test(f.text)) continue;
			const c = COMPONENT_OF_ROOT_FILE[`${cloud}/${base}`];
			if (c) found.add(c);
		}
		return found;
	};

	// PASS 1 — steps 0-3, which read the wiring. Kept as a map first because step 4 asks what the
	// wiring already decided, and a single pass would answer it with whatever happened to be earlier
	// in the file.
	const placed = new Map();
	for (const v of variables) {
		// 0 · the variable IS an item passthrough's root key.
		const claimants = itemRootOf.get(v.name) ?? [];
		if (claimants.length === 1) {
			placed.set(v.name, claimants[0]);
			continue;
		}
		// 0b · exactly one component's merge RESERVES this name — the provider emitting it under that
		// component is a stronger statement of ownership than any file it happens to be read in.
		const reservers = [...(PASSTHROUGH.byCloud[cloud] ?? new Map())]
			.filter(([schemaKey]) => reservedKeys(PASSTHROUGH, cloud, schemaKey).has(v.name))
			.map(([schemaKey]) => SCHEMA_TO_KIND.get(schemaKey))
			.filter(Boolean);
		if (new Set(reservers).size === 1) {
			placed.set(v.name, reservers[0]);
			continue;
		}
		const found = componentsOf(v.name);
		// 1+2 · exactly one component's wiring reads it. 3 · more than one, so it is not any one
		// component's knob.
		if (found.size === 1) placed.set(v.name, [...found][0]);
		else if (found.size > 1) placed.set(v.name, "platform");
	}

	/**
	 * Step 4 — the longest `_`-prefix this name shares with variables the wiring already placed, when
	 * every one of them agrees.
	 *
	 * LONGEST, because `cloud_` spans Cloud SQL, Cloud Storage, Cloud DNS and Cloud Armor while
	 * `cloud_sql_` spans one thing. UNANIMOUS, because a prefix that reaches two components has
	 * decided nothing and guessing between them writes a wrong fact into a manifest a UI reads.
	 */
	const byPrefix = (name) => {
		for (let cut = name.lastIndexOf("_"); cut > 0; cut = name.lastIndexOf("_", cut - 1)) {
			const prefix = name.slice(0, cut + 1);
			const agree = new Set();
			for (const [other, comp] of placed) if (other !== name && other.startsWith(prefix)) agree.add(comp);
			if (agree.size === 1) return [...agree][0];
			if (agree.size > 1) return null;
		}
		return null;
	};

	for (const v of variables) {
		// A RECORDED attribution wins over a derived one: the ledger is where a human wrote down what
		// the wiring cannot say, and letting a guess override it would make the record decorative.
		const rec = excludedVariable(cloud, v.name);
		const component = rec ? (rec.component ?? "platform") : (placed.get(v.name) ?? byPrefix(v.name));
		if (!component) {
			unattributed.push({ cloud, name: v.name, path: relative(ROOT, v.path), line: v.line });
			continue;
		}

		const schemaKey = [...SCHEMA_TO_KIND].find(([, kind]) => kind === component)?.[0];
		const pt = schemaKey ? PASSTHROUGH.byCloud[cloud]?.get(schemaKey) : undefined;
		const reserved = schemaKey ? reservedKeys(PASSTHROUGH, cloud, schemaKey) : new Set();
		const owned = goKeys.unconditional.has(v.name) || reserved.has(v.name);
		const entry = {
			cloud,
			component,
			name: v.name,
			kind: v.kind,
			typeExpr: v.typeExpr,
			required: v.required,
			description: v.description,
			sensitive: v.sensitive,
			declaredAt: `${relative(ROOT, v.path)}:${v.line}`,
			readBy: consumingDirs(wiring, v.name).map((d) => relative(TEMPLATES, d)),
			// A ROOT variable is reachable only through a ROOT-shaped merge. An item-shaped component
			// reaches the ATTRIBUTES of the variable it is modelled as one entry of, never the variable.
			reachable: pt?.shape === "root",
			ownedByProvider: owned,
			typed: goKeys.all.has(v.name) || reserved.has(v.name),
		};
		if (v.default !== undefined) entry.default = v.default;
		entries.push(entry);
	}

	// ── the ITEM half: the attributes a leaf component's provider_config actually reaches ──────────
	for (const [schemaKey, info] of PASSTHROUGH.byCloud[cloud] ?? []) {
		if (info.shape !== "item") continue;
		const kind = SCHEMA_TO_KIND.get(schemaKey);
		if (!kind) continue;
		const reserved = reservedKeys(PASSTHROUGH, cloud, schemaKey);
		for (const root of info.roots) {
			const decl = variables.find((v) => v.name === root);
			if (!decl) continue;
			const attrs = objectAttributeTypesIn(decl.typeExpr);
			for (const [attr, meta] of attrs) {
				const reservedHere = reserved.has(attr);
				entries.push({
					cloud,
					component: kind,
					name: attr,
					kind: meta.kind,
					typeExpr: meta.typeExpr,
					required: meta.required,
					description: "",
					sensitive: false,
					declaredAt: `${relative(ROOT, decl.path)}:${decl.line}`,
					readBy: wiring.readDirsOf(root, attr, false).map((d) => relative(TEMPLATES, d)),
					reachable: true,
					ownedByProvider: reservedHere,
					typed: reservedHere,
					itemScope: root,
					...(meta.default !== undefined ? { default: meta.default } : {}),
				});
			}
		}
	}
}

entries.sort((a, b) => a.cloud.localeCompare(b.cloud) || a.component.localeCompare(b.component) || a.name.localeCompare(b.name));

// ── the two claims a cell can fail, computed once and reported by both consumers ─────
//
// Computed HERE rather than in the checker so the manifest a reader opens and the verdict CI prints
// are the same measurement. A checker that recomputed would be a second definition of "reachable".

/** Components that appear in the manifest for a cloud but have no passthrough of any shape. */
const uncoveredCells = [];
for (const cloud of CLOUDS) {
	const seen = new Set(entries.filter((e) => e.cloud === cloud).map((e) => e.component));
	for (const component of [...seen].sort()) {
		const schemaKey = [...SCHEMA_TO_KIND].find(([, kind]) => kind === component)?.[0];
		if (schemaKey && PASSTHROUGH.byCloud[cloud]?.has(schemaKey)) continue;
		uncoveredCells.push({ cloud, component, excluded: excludedCell(cloud, component) ?? null });
	}
}

/** Declared, reachable, and read by NOTHING — the `gke_spot` shape: a knob the template advertises
 * and no resource consumes. */
const deadKnobs = entries.filter((e) => e.reachable && e.readBy.length === 0);

const manifest = {
	// A generated file says so in its own body, because the first thing anyone does with a manifest
	// is edit it.
	generatedBy: "apps/console/scripts/gen-template-knobs.mjs — do not edit; run `pnpm -C apps/console run gen:template-knobs`",
	clouds: CLOUDS,
	counts: Object.fromEntries(
		CLOUDS.map((c) => {
			const mine = entries.filter((e) => e.cloud === c);
			return [
				c,
				{
					declared: mine.length,
					reachable: mine.filter((e) => e.reachable).length,
					settable: mine.filter((e) => e.reachable && !e.ownedByProvider && !e.typed).length,
					dead: mine.filter((e) => e.reachable && e.readBy.length === 0).length,
				},
			];
		}),
	),
	knobs: entries,
};

// ── output ──────────────────────────────────────────────────────────────────────────

/** The living board — the same measurement as the JSON, rendered for a person. */
function renderDoc() {
	const L = [];
	L.push("<!--");
	L.push("SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>");
	L.push("SPDX-License-Identifier: AGPL-3.0-only");
	L.push("-->");
	L.push("");
	L.push("# Template knobs — what each template declares, and what a user can actually set");
	L.push("");
	L.push("<!-- GENERATED by apps/console/scripts/gen-template-knobs.mjs. Do not edit; run `pnpm -C apps/console run gen:template-knobs`. -->");
	L.push("");
	L.push(
		"`CUSTOMIZABILITY-PARITY.md` makes two claims about every knob — that the template **declares** it, and that a",
		"component's `provider_config` **reaches** it. This board measures both, plus the third claim underneath them:",
		"that some resource argument **reads** it. A variable can be declared, reachable, and assigned to nothing;",
		"`gke_spot` shipped `default = true` in exactly that state and the template advertised Spot node pools it never",
		"provisioned.",
		"",
	);
	L.push("## Per cloud");
	L.push("");
	L.push("| Cloud | knobs | reachable | settable (offered) | declared-and-dead |");
	L.push("|---|---:|---:|---:|---:|");
	for (const c of CLOUDS) {
		const n = manifest.counts[c];
		L.push(`| ${c} | ${n.declared} | ${n.reachable} | ${n.settable} | ${n.dead} |`);
	}
	L.push("");
	L.push(
		"**knobs** = root variables the root module declares, plus the object attributes a leaf component's item",
		"passthrough reaches. **reachable** = a `provider_config` merge lands on it. **settable** = reachable, and neither",
		"already written by the provider from a typed field nor unconditionally owned by it (merge-if-absent means an",
		"always-written key can never be reached). **declared-and-dead** = reachable and read by no resource or module",
		"argument — the shape a raw variable count cannot tell from a working knob.",
		"",
	);
	L.push("## Per component");
	L.push("");
	const comps = [...new Set(entries.map((e) => e.component))].sort();
	L.push(`| Component | ${CLOUDS.join(" | ")} |`);
	L.push(`|---|${CLOUDS.map(() => "---:").join("|")}|`);
	for (const comp of comps) {
		const cells = CLOUDS.map((c) => {
			const mine = entries.filter((e) => e.cloud === c && e.component === comp);
			if (!mine.length) return "—";
			const settable = mine.filter((e) => e.reachable && !e.ownedByProvider && !e.typed).length;
			return `${settable} / ${mine.length}`;
		});
		L.push(`| ${comp} | ${cells.join(" | ")} |`);
	}
	L.push("");
	L.push("Each cell is **settable / declared**. A `—` means the cloud declares nothing this generator attributes to that component.");
	L.push("");
	L.push("## Cells with no passthrough");
	L.push("");
	if (!uncoveredCells.length) L.push("None — every component this manifest names is reached by a `provider_config` merge on its cloud.");
	else {
		L.push("| Cloud | Component | Recorded reason |");
		L.push("|---|---|---|");
		for (const u of uncoveredCells) L.push(`| ${u.cloud} | ${u.component} | ${u.excluded ? u.excluded.reason : "**UNRECORDED — this fails `check:template-knobs`**"} |`);
	}
	L.push("");
	L.push("## Declared, reachable, read by nothing");
	L.push("");
	if (!deadKnobs.length) L.push("None. Every reachable knob is consumed by at least one resource or module argument.");
	else {
		L.push("| Cloud | Component | Knob | Declared at |");
		L.push("|---|---|---|---|");
		for (const d of deadKnobs) L.push(`| ${d.cloud} | ${d.component} | \`${d.name}\` | ${d.declaredAt} |`);
	}
	L.push("");
	L.push("## How a knob is attributed to a component");
	L.push("");
	L.push(
		"1. The variable **is** the root key a component's item passthrough lands in (`sqs_queues`) — read from the Go",
		"   providers, so it needs no table.",
		"2. The **module directories** it threads into (`COMPONENT_OF_DIR` in the generator).",
		"3. The **root files** whose resource arguments read it (`COMPONENT_OF_ROOT_FILE`). `checks_*.tf`, `outputs.tf`,",
		"   `locals.tf`, `main.tf` and `variables.tf` attribute nothing — an assertion and an output build no",
		"   infrastructure.",
		"4. More than one component after 2 and 3 → `platform`. A variable threaded into eleven modules is not one",
		"   component's knob.",
		"",
		"A variable that survives all four unattributed **fails the generator** until it is recorded in",
		"`infra/templates/project/knob-exclusions.yaml` with a reason.",
		"",
	);
	return `${L.join("\n")}\n`;
}

const jsonText = `${JSON.stringify(manifest, null, "\t")}\n`;
const docText = renderDoc();

// EVERYTHING above is measurement, and it is exported so `check-template-knobs.mjs` adjudicates the
// SAME numbers a reader sees in the manifest. A checker that recomputed would be a second definition
// of "reachable", free to disagree with the file it is checking.
export { manifest, entries, unattributed, uncoveredCells, deadKnobs, jsonText, docText, EXCLUDED, JSON_OUT, DOC_OUT, PASSTHROUGH, CLOUDS };

// The CLI half runs ONLY when this file is the process entry. Importing it must measure and nothing
// else — a module that writes two files on import cannot be read by a checker without also becoming
// the thing that fixes what it is checking.
if (process.argv[1]?.endsWith("gen-template-knobs.mjs")) {
	if (unattributed.length) {
		console.error(
			`gen:template-knobs — ${unattributed.length} root variable(s) could not be attributed to a component:\n` +
				unattributed.map((u) => `  ${u.cloud}  ${u.name}  (${u.path}:${u.line})`).join("\n") +
				"\n\nEither add the module dir / root file to the generator's tables, or record the variable in " +
				`${relative(ROOT, EXCLUSIONS)} with a reason. Dropping it silently would shrink the surface this manifest measures.`,
		);
		process.exit(1);
	}
	if (process.argv.includes("--check")) {
		const stale = [];
		if (!existsSync(JSON_OUT) || readFileSync(JSON_OUT, "utf8") !== jsonText) stale.push(JSON_OUT);
		if (!existsSync(DOC_OUT) || readFileSync(DOC_OUT, "utf8") !== docText) stale.push(DOC_OUT);
		if (stale.length) {
			console.error(`gen:template-knobs --check: stale generated file(s): ${stale.join(", ")}. Run \`pnpm -C apps/console run gen:template-knobs\` and commit.`);
			process.exit(1);
		}
		console.log(`template-knobs: ${entries.length} knobs across ${CLOUDS.length} clouds — generated files are in sync.`);
	} else {
		mkdirSync(dirname(JSON_OUT), { recursive: true });
		mkdirSync(dirname(DOC_OUT), { recursive: true });
		writeFileSync(JSON_OUT, jsonText);
		writeFileSync(DOC_OUT, docText);
		console.log(`template-knobs: wrote ${entries.length} knobs across ${CLOUDS.length} clouds → ${JSON_OUT} + ${DOC_OUT}`);
		for (const c of CLOUDS) {
			const n = manifest.counts[c];
			console.log(
				`  ${c.padEnd(8)} declared ${String(n.declared).padStart(3)}  reachable ${String(n.reachable).padStart(3)}  ` +
					`settable ${String(n.settable).padStart(3)}  dead ${n.dead}`,
			);
		}
	}
}
