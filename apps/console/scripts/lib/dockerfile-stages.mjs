// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reading a Dockerfile as STAGES: which `ENV` and `ARG` keys each `FROM … AS <name>` stage declares.
//
// The question it exists for (#5621): a value set with `ENV` in a `build` stage reaches that stage's
// commands and nothing after it — a later `FROM` starts from a fresh image, and `ARG`s are per stage
// too. So "does the RUNNING container have X" is a question about the final stage's own lines, and
// reading the file as one flat list of `ENV` lines answers a different question.
//
// What it deliberately does NOT do:
//
//   · It does not evaluate anything. `ENV X=$VERSION` is reported with the value `$VERSION`, not
//     with what that expands to; a caller that cares whether `VERSION` is in scope asks `args`.
//   · It does not follow `FROM <earlier-stage>` inheritance: a stage's `env` is its OWN lines only.
//     In both console Dockerfiles `build` is `FROM base` and `migrate` is `FROM build`, so those two
//     inherit keys this reader does not attribute to them. `runner` is `FROM node:22-alpine`, which
//     is why its own lines ARE the running container's whole `ENV` set — the one answer #5621 needs.
//   · It does not parse quoted values containing spaces (`ENV A="x y"`). The console images carry
//     none; such a value would be split at the space.
//   · Heredocs (`RUN <<EOF`) are not recognised; a heredoc line that starts with `ENV`/`ARG`/`FROM`
//     would be read as an instruction.

/**
 * @typedef {object} Stage
 * @property {string} name  the `AS` name, or `#<index>` for an unnamed stage
 * @property {Map<string, string>} env  `ENV` keys this stage sets, with their literal values
 * @property {Set<string>} args  `ARG` keys this stage declares
 */

/**
 * Split an `ENV`/`ARG` operand — `k=v k2=v2`, or the legacy `k v` — into `[key, value]` pairs.
 * A bare `ARG K` yields `[K, ""]`. Surrounding double quotes on a value are dropped.
 * @param {string} rest
 * @returns {[string, string][]}
 */
export function instructionPairs(rest) {
	const tokens = rest.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 2 && !tokens[0].includes("=")) return [[tokens[0], tokens[1]]];
	return tokens.map((t) => {
		const eq = t.indexOf("=");
		return eq === -1 ? [t, ""] : [t.slice(0, eq), t.slice(eq + 1).replace(/^"(.*)"$/, "$1")];
	});
}

/**
 * Parse a Dockerfile into its stages, joining `\` continuations and dropping comment lines.
 * Instructions before the first `FROM` (a global `ARG`) belong to no stage and are skipped.
 * @param {string} text  the Dockerfile's contents
 * @returns {Stage[]}
 */
export function parseDockerfileStages(text) {
	/** @type {string[]} */
	const logical = [];
	let buf = "";
	for (const raw of text.split("\n")) {
		if (/^\s*#/.test(raw)) continue;
		const line = raw.replace(/\s+$/, "");
		if (line.endsWith("\\")) {
			buf += `${line.slice(0, -1)} `;
			continue;
		}
		logical.push(buf + line);
		buf = "";
	}
	if (buf) logical.push(buf);

	/** @type {Stage[]} */
	const stages = [];
	for (const line of logical) {
		const m = /^\s*([A-Za-z]+)\s+(.*)$/.exec(line);
		if (!m) continue;
		const op = m[1].toUpperCase();
		if (op === "FROM") {
			const as = /\s+AS\s+([A-Za-z0-9_.-]+)\s*$/i.exec(m[2]);
			stages.push({ name: as ? as[1] : `#${stages.length}`, env: new Map(), args: new Set() });
			continue;
		}
		const stage = stages.at(-1);
		if (!stage) continue;
		if (op === "ENV") for (const [k, v] of instructionPairs(m[2])) stage.env.set(k, v);
		if (op === "ARG") for (const [k] of instructionPairs(m[2])) stage.args.add(k);
	}
	return stages;
}
