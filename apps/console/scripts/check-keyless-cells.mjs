// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Keyless-cell guard: the `keylessCells` table must agree with the code that implements the cells.
//
// `keylessCells` (packages/core/manifests/keyless.go) decides, per cloud × engine, whether a keyless
// database binding renders a proxy or fails closed. Turning a cell OFF is a claim — "one of this
// cell's legs is not built" — and that claim rots silently in both directions:
//
//   A · DEAD CELL     every leg shipped, the cell stayed off. The binding fails closed citing lanes
//                     that are already merged, so a working capability is unreachable and reads as
//                     unbuilt. This is the state aws × mysql and gcp × mysql sat in after #1504,
//                     #1505, #1506 and #1507 each landed their half and none flipped the boolean.
//   B · OVER-OPEN     a leg is missing, the cell is on. The pod renders cleanly and then cannot
//                     authenticate at runtime — precisely the lie the fail-closed table exists to
//                     prevent, and the most expensive way to discover it is in production.
//
// Nothing else catches either shape. check-offer-parity.mjs reads the TEMPLATES, so once the tofu
// side of a cell ships it reports `database:<engine>:iam_auth` as buildable and goes green while the
// renderer still refuses — the gap is between the templates and the RENDERER, which no guard compared.
//
// The legs checked here are the two that are uniformly derivable from source, and they are the two
// that were actually missing:
//
//   1. bootstrap SQL dialect — apps/runner/internal/agent/db_bootstrap.go. `postgresBootstrapSQL` and
//      `mysqlBootstrapSQL` each switch on provider; a `case "<cloud>"` is the dialect existing. Without
//      it the Job cannot create the app's login, so the proxy would authenticate as nobody.
//   2. bootstrap Job renderer — packages/core/manifests/bootstrap_job.go. `<cloud>BootstrapSpec` must
//      branch on `engineMySQL` to pass `--engine mysql` and run the mysql client; without that branch a
//      MySQL cell would apply Postgres SQL with psql against a MySQL server.
//
// It deliberately does NOT check the tofu IAM-auth flag. That leg is real but cloud-idiosyncratic —
// one RDS attribute covers both AWS engines, GCP needs the dotted key for Postgres and the UNDERSCORED
// one for MySQL, Azure gates on a computed `enable_mysql_entra` local — so verifying it means a
// hand-written marker per cell, which is the drift this guard exists to stop. Two derived legs that
// cannot rot beat three where one is a hand-list.
//
// Run from apps/console (`pnpm -F console check:keyless-cells`).

import { readFileSync } from "node:fs";

const ROOT = "../..";
const CELLS_SRC = `${ROOT}/packages/core/manifests/keyless.go`;
const JOB_SRC = `${ROOT}/packages/core/manifests/bootstrap_job.go`;
const SQL_SRC = `${ROOT}/apps/runner/internal/agent/db_bootstrap.go`;

// ── helpers ─────────────────────────────────────────────────────────────────────────

/** Blank BRACES inside Go string literals, and nothing else.
 *
 * Load-bearing for the brace matcher below: the bootstrap SQL is full of `DO $$ … END $$;` and
 * backtick-quoted identifiers, and a stray brace inside one would end a function body early — the
 * guard would then read a truncated body and report a missing leg that is right there.
 *
 * Blanking the whole literal instead is the obvious version and it is wrong: the provider switch is
 * matched ON string literals (`case "aws":`), so erasing them made every cell look unimplemented. */
function neutralizeBracesInStrings(src) {
	const scrub = (m) => m.replace(/[{}]/g, " ");
	return src.replace(/`[^`]*`/g, scrub).replace(/"(?:[^"\\\n]|\\.)*"/g, scrub);
}

/** Strip `//` line comments, so a leg only DESCRIBED in a doc comment never counts as implemented.
 * `mysqlBootstrapSQL`'s doc comment names all three clouds above a body that might implement one. */
function stripComments(src) {
	return src
		.split("\n")
		.map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
		.join("\n");
}

/** The body of a top-level Go func, brace-matched. Returns "" when the func is absent — an absent
 * renderer is a missing leg, which is the honest reading. */
function funcBody(src, name) {
	const start = src.indexOf(`func ${name}(`);
	if (start === -1) return "";
	const open = src.indexOf("{", start);
	if (open === -1) return "";
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
	}
	return "";
}

/** `providerAWS` → "aws", `engineMySQL` → "mysql". The table keys are Go constants aliasing the cloud
 * enum, so the lowercased suffix is the same token the switch labels use. */
const tokenOf = (ident) => ident.replace(/^(provider|engine)/, "").toLowerCase();

// ── the declared side: the keylessCells table ───────────────────────────────────────

const cellsSrc = stripComments(neutralizeBracesInStrings(readFileSync(CELLS_SRC, "utf8")));
const tableStart = cellsSrc.indexOf("var keylessCells =");
if (tableStart === -1) {
	console.error("✗ keyless cells — no `var keylessCells =` in packages/core/manifests/keyless.go.");
	console.error("  The guard reads that table by name; if it moved or was renamed, update CELLS_SRC here.");
	process.exit(1);
}
const tableBody = (() => {
	const open = cellsSrc.indexOf("{", tableStart);
	let depth = 0;
	for (let i = open; i < cellsSrc.length; i++) {
		if (cellsSrc[i] === "{") depth++;
		else if (cellsSrc[i] === "}" && --depth === 0) return cellsSrc.slice(open + 1, i);
	}
	return "";
})();

/** [{cloud, engine, on}] — every cell the table declares. */
const declared = [];
for (const m of tableBody.matchAll(/(provider[A-Za-z]+):\s*\{([\s\S]*?)\n\t\}/g)) {
	const cloud = tokenOf(m[1]);
	for (const e of m[2].matchAll(/(engine[A-Za-z]+):\s*\{([^}]*)\}/g)) {
		declared.push({ cloud, engine: tokenOf(e[1]), on: /\bok:\s*true\b/.test(e[2]) });
	}
}
if (declared.length === 0) {
	console.error("✗ keyless cells — parsed the keylessCells table but found no cells in it.");
	process.exit(1);
}

// ── the implemented side: derived from the two legs ─────────────────────────────────

const sqlSrc = stripComments(neutralizeBracesInStrings(readFileSync(SQL_SRC, "utf8")));
const jobSrc = stripComments(readFileSync(JOB_SRC, "utf8"));

/** Providers whose dialect exists for an engine — the `case "<cloud>":` labels in that engine's
 * bootstrap-SQL function. */
const dialectFor = (engine) => {
	const body = funcBody(sqlSrc, engine === "mysql" ? "mysqlBootstrapSQL" : "postgresBootstrapSQL");
	return new Set([...body.matchAll(/case\s+"([a-z]+)"\s*:/g)].map((m) => m[1]));
};
const dialects = { postgres: dialectFor("postgres"), mysql: dialectFor("mysql") };

/** Does <cloud>BootstrapSpec render this engine? Postgres is the default path every spec takes, so
 * only MySQL needs an explicit branch. An absent spec func fails both. */
function jobRenders(cloud, engine) {
	const body = funcBody(jobSrc, `${cloud}BootstrapSpec`);
	if (body === "") return false;
	return engine === "mysql" ? body.includes("engineMySQL") : true;
}

/** The legs a cell needs, each with the source that proves it. */
const legsOf = (cloud, engine) => [
	{ name: "bootstrap SQL dialect", ok: dialects[engine]?.has(cloud) ?? false, src: `${SQL_SRC} (${engine}BootstrapSQL, case "${cloud}")` },
	{ name: "bootstrap Job renderer", ok: jobRenders(cloud, engine), src: `${JOB_SRC} (${cloud}BootstrapSpec)` },
];

// ── adjudicate ──────────────────────────────────────────────────────────────────────

const findings = [];
for (const cell of declared) {
	const legs = legsOf(cell.cloud, cell.engine);
	const missing = legs.filter((l) => !l.ok);
	if (!cell.on && missing.length === 0) {
		findings.push({
			shape: "dead-cell",
			cell,
			detail: `every leg is implemented, but the cell is off — the binding fails closed on a capability that is built.\n      proof: ${legs.map((l) => l.src).join("\n             ")}`,
		});
	}
	if (cell.on && missing.length > 0) {
		findings.push({
			shape: "over-open",
			cell,
			detail: `the cell is on, but ${missing.length} leg(s) are missing — it renders a proxy that cannot authenticate.\n      missing: ${missing.map((l) => `${l.name} → ${l.src}`).join("\n               ")}`,
		});
	}
}

const on = declared.filter((c) => c.on).length;
if (findings.length === 0) {
	console.log(
		`✓ keyless cells — ${declared.length} cloud × engine cell(s): ${on} open, ${declared.length - on} fail-closed, ` +
			`each agreeing with its bootstrap SQL dialect and Job renderer.`,
	);
	process.exit(0);
}

console.error(`\n✗ keyless cells — ${findings.length} cell(s) disagree with the code that implements them:\n`);
for (const f of findings) {
	console.error(`  [${f.shape}] ${f.cell.cloud} × ${f.cell.engine}`);
	console.error(`      ${f.detail}`);
}
console.error(`
The table in packages/core/manifests/keyless.go is a claim about what is built. Make it true:
  · [dead-cell]  flip the cell to {ok: true} — the legs it was waiting for have landed. Update the
                 matching row in keyless_test.go so it asserts a rendered proxy on the engine's port.
  · [over-open]  build the missing leg, or turn the cell back off with a \`why\` naming the lane. A cell
                 that renders without its legs authenticates as nobody, and only a real apply finds out.
`);
process.exit(1);
