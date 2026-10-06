#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// A GO FILE WHOSE NAME ENDS IN A GOOS/GOARCH TOKEN IS A BUILD CONSTRAINT, WHETHER YOU MEANT ONE OR NOT
// (#5593, found in #5579).
//
// `go build` reads `foo_arm64_test.go`, `foo_linux.go` and `foo_windows_amd64.go` as implicit
// `//go:build` lines (go/build's goodOSArchFile). `packages/core/provisioner/karpenter_arm64_test.go`
// was a feature test ABOUT arm64 Karpenter pools; the suffix made it compile on arm64 laptops and
// never on CI's amd64 runners. Its tests and coverage vanished silently, and three rounds of "add
// coverage" changed nothing — no tool reports a file the toolchain decided to skip.
//
// So: every `.go` file under apps/, packages/, test/ and ee/ whose name ends in `_<goos>`,
// `_<goarch>` or `_<goos>_<goarch>` (before `_test.go` / `.go`) FAILS, unless it is listed in
// scripts/check-go-arch-filenames.allowlist with a reason. A listed file must also carry a
// `//go:build` line naming its suffix token, so the constraint the filename implies is one the file
// states on purpose. The ledger fails in BOTH directions: an entry whose file no longer exists, or
// no longer carries a platform suffix, is stale and fails too — otherwise it would outlive its
// subject forever and excuse whatever is later written at that path.
//
// The rule is go/build's, transcribed: strip `.go`, then a trailing `_test`; split what follows the
// FIRST `_` on `_`; the name is constrained if the last two parts are a known GOOS then a known
// GOARCH, or the last part is either. A file with no `_` at all (`linux.go`) is NOT constrained.
//
//   node scripts/check-go-arch-filenames.mjs                 # the repo
//   node scripts/check-go-arch-filenames.mjs --root <dir>    # another tree (the self-test uses it)
//   node scripts/check-go-arch-filenames.mjs --self-test

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// HARD-CODED, and on purpose not derived from `go tool dist list`. The filename rule does not use
// the PORTED list: go/build matches against `knownOS` / `knownArch` in
// $GOROOT/src/internal/syslist/syslist.go, which also holds names with no port (hurd, zos, sparc64,
// …) — `foo_zos.go` is excluded from every build even though `dist list` has no zos. These are
// that file's lists as of Go 1.27. The self-test checks every GOOS/GOARCH `go tool dist list`
// prints is in them, when a `go` binary is on PATH, so a new port cannot slip past unnoticed.
const KNOWN_OS = new Set([
	"aix", "android", "darwin", "dragonfly", "freebsd", "hurd", "illumos", "ios", "js", "linux",
	"nacl", "netbsd", "openbsd", "plan9", "solaris", "wasip1", "windows", "zos",
]);
const KNOWN_ARCH = new Set([
	"386", "amd64", "amd64p32", "arm", "armbe", "arm64", "arm64be", "loong64", "mips", "mipsle",
	"mips64", "mips64le", "mips64p32", "mips64p32le", "ppc", "ppc64", "ppc64le", "riscv", "riscv64",
	"s390", "s390x", "sparc", "sparc64", "wasm",
]);

/** The roots scanned, relative to the tree root. */
const ROOTS = ["apps", "packages", "test", "ee"];
/** Directories the go tool ignores or that hold no first-party Go. */
const SKIP_DIRS = new Set(["node_modules", "testdata", "vendor"]);
const ALLOWLIST = "scripts/check-go-arch-filenames.allowlist";

/**
 * The platform tokens a Go file name implies, per go/build's goodOSArchFile, or [] for none.
 * `foo_linux_arm64_test.go` → ["linux", "arm64"]; `foo_arm64.go` → ["arm64"]; `linux.go` → [].
 */
export function impliedConstraint(basename) {
	if (!basename.endsWith(".go")) return [];
	let name = basename.slice(0, -".go".length);
	const i = name.indexOf("_");
	if (i < 0) return [];
	name = name.slice(i);
	let parts = name.split("_");
	if (parts.length > 0 && parts[parts.length - 1] === "test") parts = parts.slice(0, -1);
	const n = parts.length;
	if (n >= 2 && KNOWN_OS.has(parts[n - 2]) && KNOWN_ARCH.has(parts[n - 1])) {
		return [parts[n - 2], parts[n - 1]];
	}
	if (n >= 1 && (KNOWN_OS.has(parts[n - 1]) || KNOWN_ARCH.has(parts[n - 1]))) {
		return [parts[n - 1]];
	}
	return [];
}

/** Recursively collect `.go` files under dir (repo-relative paths, `/`-separated). */
function goFiles(root, rel) {
	const abs = path.join(root, rel);
	let entries;
	try {
		entries = fs.readdirSync(abs, { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const e of entries) {
		// The go tool ignores names starting with `.` or `_`.
		if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
		const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name)) out.push(...goFiles(root, childRel));
		} else if (e.isFile() && e.name.endsWith(".go")) {
			out.push(childRel);
		}
	}
	return out;
}

/**
 * Parse the allowlist: one `<path>  <reason>` per line, `#` comments and blank lines ignored.
 * Returns the entries and any malformed-line errors (a path with no reason is an error).
 */
export function parseAllowlist(text) {
	const entries = new Map();
	const errors = [];
	text.split("\n").forEach((raw, idx) => {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) return;
		const m = /^(\S+)\s+(.+)$/.exec(line);
		if (!m || m[2].trim().length < 10) {
			errors.push(`${ALLOWLIST}:${idx + 1}: an entry needs a path AND a reason (≥10 chars): "${line}"`);
			return;
		}
		if (entries.has(m[1])) errors.push(`${ALLOWLIST}:${idx + 1}: duplicate entry ${m[1]}`);
		entries.set(m[1], m[2].trim());
	});
	return { entries, errors };
}

/** True when the file's `//go:build` line names every token its filename implies. */
function statesConstraint(absFile, tokens) {
	let src;
	try {
		src = fs.readFileSync(absFile, "utf8");
	} catch {
		return false;
	}
	const build = src.split("\n").find((l) => /^\/\/go:build\s/.test(l));
	if (!build) return false;
	const words = new Set(build.slice("//go:build".length).split(/[^A-Za-z0-9_]+/));
	return tokens.every((t) => words.has(t));
}

/** Run the check over a tree. Returns the list of problems (empty = pass). */
export function check(root) {
	const problems = [];
	let allowText = "";
	try {
		allowText = fs.readFileSync(path.join(root, ALLOWLIST), "utf8");
	} catch {
		problems.push(`${ALLOWLIST} could not be read — refusing to report a verdict without the ledger`);
		return problems;
	}
	const { entries, errors } = parseAllowlist(allowText);
	problems.push(...errors);

	const scanned = ROOTS.flatMap((r) => goFiles(root, r));
	if (scanned.length === 0) {
		problems.push(`no .go files found under ${ROOTS.join(", ")} — the walk is blind, not clean`);
		return problems;
	}
	const offenders = new Map();
	for (const f of scanned) {
		const tokens = impliedConstraint(path.posix.basename(f));
		if (tokens.length > 0) offenders.set(f, tokens);
	}

	for (const [f, tokens] of offenders) {
		const suffix = tokens.map((t) => `_${t}`).join("");
		if (!entries.has(f)) {
			problems.push(
				`${f}: the "${suffix}" suffix is an implicit build constraint — this file only compiles on ` +
					`${tokens.join("/")}. Rename it, or (if it is genuinely platform-specific) list it in ${ALLOWLIST} with a reason.`,
			);
		} else if (!statesConstraint(path.join(root, f), tokens)) {
			problems.push(
				`${f}: allowlisted, but has no //go:build line naming ${tokens.join(" and ")} — state the constraint the filename implies.`,
			);
		}
	}
	for (const f of entries.keys()) {
		if (!offenders.has(f)) {
			problems.push(
				`${ALLOWLIST}: stale entry ${f} — ${fs.existsSync(path.join(root, f)) ? "it no longer carries a platform suffix" : "the file no longer exists"}. Delete the line.`,
			);
		}
	}
	return problems;
}

/** CLI entry point: check the repo (or --root) and exit non-zero on any problem. */
function main() {
	const rootIdx = process.argv.indexOf("--root");
	const root =
		rootIdx >= 0 ? path.resolve(process.argv[rootIdx + 1] ?? ".") : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const problems = check(root);
	if (problems.length > 0) {
		console.error(`✗ check-go-arch-filenames: ${problems.length} problem(s)`);
		for (const p of problems) console.error(`   ${p}`);
		process.exit(1);
	}
	console.log("✓ check-go-arch-filenames: no Go file is excluded from a build by an accidental GOOS/GOARCH suffix.");
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
// Each case builds a throwaway tree and runs THIS SCRIPT on it as a subprocess. The exit code is
// the assertion — the text is only a report — so a guard that printed ✗ and exited 0 fails here.

/** Write files (path → content) under a fresh temp dir and return it. */
function plant(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go-arch-filenames-"));
	for (const [rel, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), content);
	}
	return dir;
}

/** Run the guard on a planted tree; return its exit status. */
function exitOn(files) {
	const dir = plant(files);
	try {
		const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--root", dir], { encoding: "utf8" });
		return r.status;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Self-test: planted offenders must exit non-zero, clean trees zero. */
function selfTest() {
	const pkg = "package foo\n";
	const linuxBuild = "//go:build linux\n\npackage foo\n";
	const base = { "packages/core/foo/foo.go": pkg, [ALLOWLIST]: "# empty\n" };
	const cases = [
		["clean tree passes (control)", base, 0],
		["planted foo_arm64_test.go fails", { ...base, "packages/core/foo/foo_arm64_test.go": pkg }, "nonzero"],
		["planted foo_linux_amd64.go fails", { ...base, "apps/cli/x/foo_linux_amd64.go": pkg }, "nonzero"],
		["planted foo_zos.go fails (known OS with no port)", { ...base, "test/e2e/foo_zos.go": pkg }, "nonzero"],
		["planted under ee/ fails", { ...base, "ee/x/foo_windows.go": pkg }, "nonzero"],
		["linux.go (no underscore) passes", { ...base, "packages/core/foo/linux.go": pkg }, 0],
		["foo_unix.go passes (unix is a tag, not a filename GOOS)", { ...base, "packages/core/foo/foo_unix.go": pkg }, 0],
		["karpenter_graviton_test.go passes", { ...base, "packages/core/foo/karpenter_graviton_test.go": pkg }, 0],
		[
			"allowlisted + //go:build passes",
			{ ...base, "packages/core/foo/foo_linux.go": linuxBuild, [ALLOWLIST]: "packages/core/foo/foo_linux.go uses linux-only syscalls\n" },
			0,
		],
		[
			"allowlisted but no //go:build fails",
			{ ...base, "packages/core/foo/foo_linux.go": pkg, [ALLOWLIST]: "packages/core/foo/foo_linux.go uses linux-only syscalls\n" },
			"nonzero",
		],
		["allowlist entry with no reason fails", { ...base, "packages/core/foo/foo_linux.go": linuxBuild, [ALLOWLIST]: "packages/core/foo/foo_linux.go\n" }, "nonzero"],
		["stale entry (file gone) fails", { ...base, [ALLOWLIST]: "packages/core/foo/gone_linux.go a reason that is long enough\n" }, "nonzero"],
		["stale entry (no suffix) fails", { ...base, [ALLOWLIST]: "packages/core/foo/foo.go a reason that is long enough\n" }, "nonzero"],
		["missing allowlist fails", { "packages/core/foo/foo.go": pkg }, "nonzero"],
		["empty tree fails (blind walk)", { [ALLOWLIST]: "# empty\n" }, "nonzero"],
	];
	let fails = 0;
	for (const [name, files, want] of cases) {
		const got = exitOn(files);
		const ok = want === "nonzero" ? typeof got === "number" && got !== 0 : got === want;
		console.log(`${ok ? "✓" : "✗"} ${name} (exit ${got})`);
		if (!ok) fails++;
	}

	// The hard-coded lists must cover every port the installed toolchain knows.
	const dist = spawnSync("go", ["tool", "dist", "list"], { encoding: "utf8" });
	if (dist.status === 0) {
		const missing = [];
		for (const pair of dist.stdout.split("\n").filter(Boolean)) {
			const [goos, goarch] = pair.split("/");
			if (!KNOWN_OS.has(goos)) missing.push(`GOOS ${goos}`);
			if (!KNOWN_ARCH.has(goarch)) missing.push(`GOARCH ${goarch}`);
		}
		const ok = missing.length === 0;
		console.log(`${ok ? "✓" : "✗"} hard-coded lists cover \`go tool dist list\`${ok ? "" : `: missing ${[...new Set(missing)].join(", ")}`}`);
		if (!ok) fails++;
		// ...and must EQUAL go/build's own lists, which is what the filename rule actually reads.
		const goroot = spawnSync("go", ["env", "GOROOT"], { encoding: "utf8" }).stdout.trim();
		const syslist = path.join(goroot, "src/internal/syslist/syslist.go");
		if (goroot && fs.existsSync(syslist)) {
			const src = fs.readFileSync(syslist, "utf8");
			for (const [label, set] of [["KnownOS", KNOWN_OS], ["KnownArch", KNOWN_ARCH]]) {
				const block = new RegExp(`var ${label} = map\\[string\\]bool\\{([^}]*)\\}`).exec(src);
				const names = block ? [...block[1].matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]) : [];
				const same = names.length > 0 && names.length === set.size && names.every((x) => set.has(x));
				console.log(`${same ? "✓" : "✗"} hard-coded ${label} equals ${syslist}${same ? "" : ` (toolchain has: ${names.join(" ")})`}`);
				if (!same) fails++;
			}
		}
	} else {
		console.log("· no `go` on PATH — skipped the toolchain cross-checks");
	}

	if (fails > 0) {
		console.error(`\ncheck-go-arch-filenames self-test: ${fails} failure(s)`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

if (process.argv.includes("--self-test")) selfTest();
else main();
