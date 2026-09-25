#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Every interactive control in the console has a ROLE and an ACCESSIBLE NAME — checked statically,
// over the source, for the controls the rendered audit never opens (#5046, maintainer ruling
// 2026-09-24).
//
//   node scripts/check-control-names.mjs              # scan + ledger (pnpm -C apps/console run check:control-names)
//   node scripts/check-control-names.mjs --write      # rewrite the ledger's two counters (gen:control-names)
//   node scripts/check-control-names.mjs --json       # the raw findings, for recording debt
//   node scripts/check-control-names.mjs --self-test  # prove every rule, exemption and ledger check can fail
//
// Paths are relative to apps/console, which is where `pnpm -C apps/console run` puts the process;
// the script resolves its own location and does not depend on the cwd. Do NOT pipe it: `| tail`
// reports TAIL's exit code and every failure below becomes invisible.
//
// ── WHY A STATIC CHECK, WHEN THERE IS A RENDERED ONE ─────────────────────────────────────────
//
// axe can only score what it RENDERS. Every control behind a conditional, an empty state, a plan
// gate or a sheet the audit does not open is invisible to it — permanently, not until the fixtures
// improve. #4352 made that argument for switches and `check:shared-surface` now carries a
// `switch_name` rule; this file makes it for every other interactive shape. The two instruments
// answer different questions and neither replaces the other: the audit sees the COMPUTED name of
// what it rendered, this sees the SOURCE of every control that can render.
//
// ── WHAT IS CHECKED ──────────────────────────────────────────────────────────────────────────
//
// Scope: every `.tsx` under apps/console/components and apps/console/app. Three rules, each the
// section name of the same id in apps/console/control-names-allowlist.yaml.
//
//   control_name   A CONTROL THAT NAMES ITSELF FROM ITS CONTENT, and whose content says nothing.
//                  The element is `<button>`, `<Button>`, `<InputGroupButton>`, `<a>` or `<Link>`,
//                  or ANY element carrying a `role` whose name comes from content (`button`,
//                  `link`, `tab`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `option`,
//                  `treeitem`). It is a finding when its own tag carries no non-empty `aria-label`,
//                  `aria-labelledby` or `title`, AND its children render no text. "Renders text"
//                  follows the accessible-name computation's step 2F over the JSX, not the DOM: a
//                  non-blank text node; an `sr-only` span (it is text — the class does not matter);
//                  a child carrying `aria-label`/`aria-labelledby`/`title`, or an `<img alt>`; an
//                  expression (`{label}`, `{t("save")}`, `{children}`) — which COULD be text and is
//                  counted as text; and a child COMPONENT that is not an icon, which could render
//                  text too. It is not text: an `aria-hidden` subtree, `null`/`false`/`""`, and an
//                  ICON — a component imported from an icon package (`lucide-react`,
//                  `@radix-ui/react-icons`), or one whose name ends in `Icon`/`Glyph`, or
//                  `Spinner`/`Loader*`. Both arms of a `?:` and the right of an `&&` are read, so a
//                  button that is an icon in one state and a word in the other is named.
//
//   clickable_role A NON-INTERACTIVE INTRINSIC ELEMENT WITH `onClick` AND NO `role` — the clickable
//                  `<div>`. Any lowercase tag except the ones that ARE controls (`button`, `a`,
//                  `input`, `select`, `textarea`, `summary`, `option`) and `label`, whose click is
//                  forwarded to its control. Such an element is announced as nothing and reached by
//                  no key. It reads THROUGH `@repo/ui`'s thin wrappers — `<TableRow onClick>` is a
//                  clickable `<tr>` wearing a capital letter — using a map DERIVED on every run
//                  from `packages/ui/src` (a component whose body returns one lowercase element),
//                  never typed here. Measured when the rule landed: 4 of the 6 findings were rows
//                  and a header reached that way, which a lowercase-only rule would have called
//                  clean. An element carrying a static `hidden` is not rendered and is not read by
//                  any rule. ONE exemption, by shape: a handler that is an inline function whose
//                  whole body is `stopPropagation()` and/or `preventDefault()` on its own event —
//                  that element is a wall around a control, not a control.
//
//   field_label    A FORM FIELD WITH NO LABEL. `<input>` (not `type="hidden"`, and not a
//                  `submit`/`button`/`reset`/`image`, which are buttons), `<Input>`, `<textarea>`,
//                  `<Textarea>`, native `<select>`, `<InputGroupInput>`, `<InputGroupTextarea>`,
//                  `<Checkbox>`. Labelled when ANY of: a non-empty `aria-label`/`aria-labelledby`/
//                  `title` on its own tag; an enclosing `<label>`/`<Label>`; an enclosing
//                  `<FormControl>` whose nearest enclosing `<FormItem>` holds a `<FormLabel>`
//                  (`packages/ui/src/form.tsx` wires `htmlFor` to the control's injected `id`); or
//                  an `id` whose source text equals the `htmlFor` of a `<label>`/`<Label>`/
//                  `<FormLabel>` IN THE SAME FILE — `id={nameId}` ⇄ `htmlFor={nameId}` and
//                  `id="email"` ⇄ `htmlFor="email"` both pair. A `placeholder` is NOT a label: it
//                  vanishes the moment the field has a value, which is the moment a screen-reader
//                  user tabs back to check it.
//
// NOT checked, and stated so a green run is not read as more than it is:
//
//   `<Switch>` and `role="switch"` — `check:shared-surface`'s `switch_name` rule owns them
//                  (#4352). Reading them here too would record one defect in two ledgers.
//   A NAME THAT ARRIVES FROM OUTSIDE THE TAG — a spread (`{...props}`), a wrapper component that
//                  sets `aria-label` inside itself, an `id` paired with a `htmlFor` in ANOTHER
//                  file. All are over-reported, deliberately: the precise question needs a
//                  rendered DOM, and a rendered DOM is the instrument that cannot see half these
//                  controls. Each earns one reviewed `reason:` entry, never a wider exemption.
//   Radix / base-ui TRIGGERS and ITEMS that are not listed above (`SelectTrigger`, `TabsTrigger`,
//                  `DropdownMenuItem`, `ToggleGroupItem`, …) — each is a component whose role
//                  lives inside `packages/ui`, and a list of them here is a hand-written subject
//                  list that decays. A `DropdownMenuTrigger asChild` IS read, through the
//                  `<Button>` it wraps.
//   KEYBOARD reachability of a `role`d element (`tabIndex`, `onKeyDown`) — a separate question
//                  from "does it have a role and a name", and not asked here.
//   The QUALITY of a name — `aria-label="button"` passes. A name that exists is what is checked.
//   `title` counts as a name, because the computation uses it; it is the weakest of the three and
//                  the one a reviewer should question, but refusing it would be this file
//                  disagreeing with the browser.
//   apps/console/{lib,hooks,emails,tests} — one `.tsx` context provider, none, email markup that
//                  no screen reader drives as an app, and fixtures.
//
// ── HOW IT MATCHES ───────────────────────────────────────────────────────────────────────────
//
// A PARSE, not a regex: `typescript`'s own `createSourceFile` in TSX mode, the console's pinned
// compiler. That is what makes "an element's attributes" and "an element's children" and "an
// element's ancestors" questions with answers — a prop eleven lines below its `<`, a `>` inside an
// arrow in a prop, a label three levels up. It needs `node_modules`, which the CI job this runs in
// installs (`pnpm install --frozen-lockfile`); a de-hydrated worktree does not have it, and the
// script REFUSES there with the command that fixes it rather than falling back to a weaker read.
// A file the parser reports a syntax error in is refused too — a partial tree is not a clean one.
//
// A control whose markup is handed over through `render={<Link href={x} />}` (base-ui's slot) is
// read as ONE control: the element in the slot is not examined on its own, and the host's name
// comes from its own children plus the slot element's children, which is where base-ui puts them.
// Without that, every `<Button render={<Link />}>Support</Button>` read as an unnamed link — 31
// false findings on the first draft, which is how a rule gets switched off instead of obeyed.
//
// HOW IT KNOWS IT LOOKED. A root that is missing or empty raises. The `@repo/ui` wrapper
// derivation raises when it reads nothing, or when it does not map `TableRow` to `tr`. The ledger carries a `floors:`
// block — the minimum number of files scanned and of elements EXAMINED per rule — so a walker, an
// extension list or a tag list that quietly stopped matching fails rather than printing ✓ over
// nothing. And every run fires each rule's probe and anti-probe through the same analyser before
// scanning, so the day the last debt row is fixed a rule that has stopped matching still fails.
//
// ── THE LEDGER ───────────────────────────────────────────────────────────────────────────────
//
// apps/console/control-names-allowlist.yaml, the same two kinds of entry as
// shared-surface-allowlist.yaml and for the same reason: `reason:` is a DECISION (counted against
// `baseline`), `lifts:` is measured DEBT naming the issue that removes it (counted against `debt`).
// `hits` is per OCCURRENCE and checked in BOTH directions — a file with more findings than its row
// is new drift, a file with fewer is an unrecorded win that could otherwise be quietly spent — and
// a row whose file has no findings at all fails. `baseline:` and `debt:` are derived from the rows:
// `--write` rewrites them and nothing else, a bare run refuses a file whose counters disagree.

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const CONSOLE = path.resolve(import.meta.dirname, "..");
const SHARED_UI = path.resolve(CONSOLE, "../../packages/ui/src");
const ALLOWLIST = "control-names-allowlist.yaml";
const ROOTS = ["components", "app"];
const EXT = ".tsx";

/**
 * Load the console's own `typescript`, refusing with the fix when it is not installed.
 *
 * @returns {typeof import("typescript")}
 */
function loadTypescript() {
	try {
		return createRequire(path.join(CONSOLE, "package.json"))("typescript");
	} catch {
		process.stderr.write(
			"check-control-names: cannot load `typescript` from apps/console. This check PARSES the console and will not\n" +
				"fall back to a weaker read. Run it where dependencies are installed (CI, or `pnpm env:check`), or install\n" +
				"with `pnpm install --frozen-lockfile`.\n",
		);
		process.exit(2);
	}
}

const ts = loadTypescript();

// ── the rules' vocabulary ──────────────────────────────────────────────────────────────────

/** Elements whose accessible name comes from their content. */
const NAMED_FROM_CONTENT_TAGS = new Set(["button", "Button", "InputGroupButton", "a", "Link"]);
/** Roles whose accessible name comes from content (ARIA 1.2 "name from: contents"), minus `switch`. */
const NAMED_FROM_CONTENT_ROLES = new Set(["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem"]);
/** Intrinsic tags that ARE controls, plus `label`, whose click is forwarded to its control. */
const INTERACTIVE_INTRINSICS = new Set(["button", "a", "input", "select", "textarea", "summary", "option", "label"]);
/** Form fields that need a label. */
const FIELD_TAGS = new Set(["input", "Input", "textarea", "Textarea", "select", "InputGroupInput", "InputGroupTextarea", "Checkbox"]);
/** `<input type>`s that are buttons, not fields, or are not rendered at all. */
const NON_FIELD_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);
/** Packages whose every export is an icon. */
const ICON_PACKAGES = new Set(["lucide-react", "@radix-ui/react-icons"]);
/** Component names that are icons by convention, wherever they are imported from. */
const ICON_NAME = /(?:Icon|Glyph)$|^(?:Spinner|Loader\w*)$/;
/** The attributes that give an element a name of its own. */
const NAME_ATTRS = ["aria-label", "aria-labelledby", "title"];

/** The rule ids, which are also the ledger's section names. */
const RULE_IDS = ["control_name", "clickable_role", "field_label"];

const SAY = {
	control_name:
		"is a control whose name comes from its content, and its content renders no text. Give it `aria-label` (or `aria-labelledby` pointing at visible text), or an `sr-only` span inside it.",
	clickable_role:
		"is a non-interactive element with `onClick` and no `role` — announced as nothing and reached by no key. Make it a `<button>` (or `<Button variant=\"ghost\">`); if it must stay a div, give it `role`, `tabIndex` and a key handler.",
	field_label:
		"is a form field with no label. Wrap it in `<FormItem>`+`<FormLabel>`+`<FormControl>`, pair its `id` with a `<Label htmlFor>` in the same file, or give it `aria-label`. A `placeholder` is not a label.",
};

// ── the analyser ─────────────────────────────────────────────────────────────────────────────

/**
 * The tag name of a JSX opening/self-closing element, as written (`Foo.Bar` included).
 *
 * @param {import("typescript").JsxOpeningLikeElement} el
 * @returns {string}
 */
function tagOf(el) {
	return el.tagName.getText();
}

/**
 * An element's attributes by name, and whether it spreads any.
 *
 * @param {import("typescript").JsxOpeningLikeElement} el
 * @returns {{attrs: Map<string, import("typescript").JsxAttribute>, spread: boolean}}
 */
function attrsOf(el) {
	const attrs = new Map();
	let spread = false;
	for (const p of el.attributes.properties) {
		if (ts.isJsxSpreadAttribute(p)) spread = true;
		else attrs.set(p.name.getText(), p);
	}
	return { attrs, spread };
}

/**
 * The attribute's value as a static string when it is one (`"x"`, `{"x"}`, `` {`x`} ``), else null.
 * A bare attribute (`<input disabled>`) reads as "true".
 *
 * @param {import("typescript").JsxAttribute | undefined} attr
 * @returns {string | null}
 */
function staticValue(attr) {
	if (attr === undefined) return null;
	const init = attr.initializer;
	if (init === undefined) return "true";
	if (ts.isStringLiteral(init)) return init.text;
	if (ts.isJsxExpression(init) && init.expression !== undefined) {
		const e = init.expression;
		if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
	}
	return null;
}

/**
 * Whether an attribute is present with a value that is not statically empty. An expression counts
 * as non-empty — `aria-label={t("close")}` — because what it evaluates to is not knowable here.
 *
 * @param {import("typescript").JsxAttribute | undefined} attr
 * @returns {boolean}
 */
function nonEmpty(attr) {
	if (attr === undefined || attr.initializer === undefined) return false;
	const v = staticValue(attr);
	if (v !== null) return v.trim() !== "";
	const init = attr.initializer;
	return !(ts.isJsxExpression(init) && init.expression === undefined);
}

/**
 * Whether the tag carries a name of its own.
 *
 * @param {Map<string, import("typescript").JsxAttribute>} attrs
 * @returns {boolean}
 */
function selfNamed(attrs) {
	return NAME_ATTRS.some((n) => nonEmpty(attrs.get(n)));
}

/**
 * The opening-like element of a JSX element node, or null for anything else.
 *
 * @param {import("typescript").Node} node
 * @returns {import("typescript").JsxOpeningLikeElement | null}
 */
function openingOf(node) {
	if (ts.isJsxElement(node)) return node.openingElement;
	if (ts.isJsxSelfClosingElement(node)) return node;
	return null;
}

/**
 * The icon identifiers a file imports: every named or default import from an icon package.
 *
 * @param {import("typescript").SourceFile} sf
 * @returns {Set<string>}
 */
function iconImports(sf) {
	const out = new Set();
	for (const st of sf.statements) {
		if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
		if (!ICON_PACKAGES.has(st.moduleSpecifier.text)) continue;
		const clause = st.importClause;
		if (clause?.name) out.add(clause.name.text);
		const nb = clause?.namedBindings;
		if (nb && ts.isNamedImports(nb)) for (const s of nb.elements) out.add(s.name.text);
	}
	return out;
}

/**
 * Which `@repo/ui` components are a THIN WRAPPER over one intrinsic element — `TableRow` → `tr`,
 * `TableHead` → `th` — DERIVED from `packages/ui/src` on every run, never typed here: a top-level
 * `function Name(…)` whose body RETURNS a lowercase JSX element directly. Keyed
 * `<module>:<export>`, which is how the console's imports are resolved against it.
 *
 * `clickable_role` reads through it, because `<TableRow onClick>` is a clickable `<tr>` wearing a
 * capital letter, and a rule that only saw lowercase tags would call the console's clickable table
 * rows clean. It RAISES when the derivation reads nothing, or when `table:TableRow` is not `tr` —
 * the cheap proof that it read the file it thinks it read — because a derivation over nothing
 * builds a map over nothing, and that reads as a clean console.
 *
 * @param {string} dir packages/ui/src
 * @returns {Map<string, string>}
 */
function deriveWrappers(dir) {
	const out = new Map();
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith(".tsx")) continue;
		const mod = name.slice(0, -4);
		const sf = ts.createSourceFile(name, fs.readFileSync(path.join(dir, name), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
		for (const st of sf.statements) {
			if (!ts.isFunctionDeclaration(st) || st.name === undefined || !/^[A-Z]/.test(st.name.text) || st.body === undefined) continue;
			const ret = st.body.statements.find((x) => ts.isReturnStatement(x));
			let e = ret !== undefined && ts.isReturnStatement(ret) ? ret.expression : undefined;
			while (e !== undefined && ts.isParenthesizedExpression(e)) e = e.expression;
			const op = e === undefined ? null : openingOf(e);
			if (op !== null && /^[a-z][a-z0-9]*$/.test(tagOf(op))) out.set(`${mod}:${st.name.text}`, tagOf(op));
		}
	}
	if (out.size === 0 || out.get("table:TableRow") !== "tr")
		throw new Error(
			`packages/ui/src: the wrapper derivation read ${out.size} wrapper(s) and table:TableRow → ${out.get("table:TableRow") ?? "nothing"}. ` +
				"It must find `TableRow` → `tr`, or it did not read what it thinks it read — and a map over nothing is a clickable table row reported clean.",
		);
	return out;
}

/**
 * The console file's `@repo/ui/*` imports that resolve to a thin intrinsic wrapper: local name →
 * intrinsic tag.
 *
 * @param {import("typescript").SourceFile} sf
 * @param {Map<string, string>} wrappers
 * @returns {Map<string, string>}
 */
function wrapperImports(sf, wrappers) {
	const out = new Map();
	for (const st of sf.statements) {
		if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
		const m = /^@repo\/ui\/(.+)$/.exec(st.moduleSpecifier.text);
		const nb = st.importClause?.namedBindings;
		if (m === null || nb === undefined || !ts.isNamedImports(nb)) continue;
		for (const el of nb.elements) {
			const tag = wrappers.get(`${m[1]}:${(el.propertyName ?? el.name).text}`);
			if (tag !== undefined) out.set(el.name.text, tag);
		}
	}
	return out;
}

/**
 * Whether an expression in JSX-child position could render text. Conservative in the NAMED
 * direction for anything it cannot see into (an identifier, a call, a template), because a
 * `{label}` is how most buttons are named and reporting it would bury every real finding.
 *
 * @param {import("typescript").Expression} e
 * @param {Ctx} ctx
 * @returns {boolean}
 */
function exprRendersText(e, ctx) {
	if (ts.isParenthesizedExpression(e)) return exprRendersText(e.expression, ctx);
	if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return nodeRendersText(e, ctx);
	if (ts.isConditionalExpression(e)) return exprRendersText(e.whenTrue, ctx) || exprRendersText(e.whenFalse, ctx);
	if (ts.isBinaryExpression(e)) {
		const op = e.operatorToken.kind;
		if (op === ts.SyntaxKind.AmpersandAmpersandToken) return exprRendersText(e.right, ctx);
		if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken)
			return exprRendersText(e.left, ctx) || exprRendersText(e.right, ctx);
		return true;
	}
	if (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return false;
	if (ts.isIdentifier(e) && e.text === "undefined") return false;
	if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text.trim() !== "";
	return true;
}

/**
 * Whether a JSX child node could contribute text to its parent's accessible name.
 *
 * @param {import("typescript").Node} node
 * @param {Ctx} ctx
 * @returns {boolean}
 */
function nodeRendersText(node, ctx) {
	if (ts.isJsxText(node)) return node.text.trim() !== "";
	if (ts.isJsxExpression(node)) return node.expression !== undefined && exprRendersText(node.expression, ctx);
	if (ts.isJsxFragment(node)) return node.children.some((c) => nodeRendersText(c, ctx));
	const op = openingOf(node);
	if (op === null) return false;
	const { attrs } = attrsOf(op);
	const hidden = staticValue(attrs.get("aria-hidden"));
	if (hidden === "true" || (attrs.has("aria-hidden") && hidden === null && !ctx.mutate.has("aria-hidden-expr"))) return false;
	if (selfNamed(attrs)) return true;
	const tag = tagOf(op);
	if (tag === "img" && nonEmpty(attrs.get("alt"))) return true;
	if (ts.isJsxElement(node) && node.children.some((c) => nodeRendersText(c, ctx))) return true;
	// A self-closing (or empty) element renders text only if it is a component that is not an icon:
	// `<ProviderName id={x} />` may well print a word; `<Plus />` does not.
	const isComponent = /^[A-Z]/.test(tag) || tag.includes(".");
	if (!isComponent) return false;
	if (ctx.mutate.has("icons-are-text")) return true;
	return !(ctx.icons.has(tag) || ICON_NAME.test(tag.split(".").pop() ?? tag));
}

/**
 * Whether an element is the VALUE of an attribute — `render={<Link href={x} />}`, possibly behind a
 * `?:`, `&&`, `??` or parentheses. Such an element is markup handed to its host (base-ui's
 * `render`, a slot prop), not a control of its own.
 *
 * @param {import("typescript").Node} node
 * @returns {boolean}
 */
function isRenderSlot(node) {
	let p = node.parent;
	while (p !== undefined && (ts.isParenthesizedExpression(p) || ts.isConditionalExpression(p) || ts.isBinaryExpression(p))) p = p.parent;
	return p !== undefined && ts.isJsxExpression(p) && p.parent !== undefined && ts.isJsxAttribute(p.parent);
}

/**
 * Whether a control's CONTENT renders text: its children, plus — when its markup is handed over
 * through `render={<X>…</X>}` — that element's children, which is where base-ui puts them.
 *
 * @param {import("typescript").Node} node
 * @param {Map<string, import("typescript").JsxAttribute>} attrs
 * @param {Ctx} ctx
 * @returns {boolean}
 */
function contentRendersText(node, attrs, ctx) {
	if (ts.isJsxElement(node) && node.children.some((c) => nodeRendersText(c, ctx))) return true;
	const render = attrs.get("render")?.initializer;
	if (render === undefined || !ts.isJsxExpression(render) || render.expression === undefined) return false;
	const e = render.expression;
	if (ts.isJsxElement(e)) return e.children.some((c) => nodeRendersText(c, ctx));
	return !(ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) && exprRendersText(e, ctx);
}

/**
 * Whether a handler is ONLY a propagation wall: an inline function whose every statement is
 * `<param>.stopPropagation()` or `<param>.preventDefault()`.
 *
 * @param {import("typescript").JsxAttribute | undefined} attr
 * @returns {boolean}
 */
function isPropagationWall(attr) {
	const e = attr?.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : undefined;
	if (e === undefined || !(ts.isArrowFunction(e) || ts.isFunctionExpression(e))) return false;
	const param = e.parameters[0]?.name;
	if (param === undefined || !ts.isIdentifier(param)) return false;
	const isWallCall = (/** @type {import("typescript").Node} */ x) =>
		ts.isCallExpression(x) &&
		x.arguments.length === 0 &&
		ts.isPropertyAccessExpression(x.expression) &&
		ts.isIdentifier(x.expression.expression) &&
		x.expression.expression.text === param.text &&
		(x.expression.name.text === "stopPropagation" || x.expression.name.text === "preventDefault");
	if (!ts.isBlock(e.body)) return isWallCall(e.body);
	return e.body.statements.length > 0 && e.body.statements.every((s) => ts.isExpressionStatement(s) && isWallCall(s.expression));
}

/**
 * The JSX element ancestors of a node, nearest first.
 *
 * @param {import("typescript").Node} node
 * @returns {import("typescript").JsxElement[]}
 */
function jsxAncestors(node) {
	const out = [];
	for (let p = node.parent; p !== undefined; p = p.parent) if (ts.isJsxElement(p)) out.push(p);
	return out;
}

/**
 * Whether a JSX subtree contains an element with the given tag.
 *
 * @param {import("typescript").Node} root
 * @param {string} tag
 * @returns {boolean}
 */
function containsTag(root, tag) {
	let found = false;
	const visit = (/** @type {import("typescript").Node} */ n) => {
		if (found) return;
		const op = openingOf(n);
		if (op !== null && tagOf(op) === tag) {
			found = true;
			return;
		}
		ts.forEachChild(n, visit);
	};
	visit(root);
	return found;
}

/**
 * The source text of an attribute's value, normalised so `"x"`, `{"x"}` and `{`x`}` agree and an
 * expression compares by its text.
 *
 * @param {import("typescript").JsxAttribute | undefined} attr
 * @returns {string | null}
 */
function pairKey(attr) {
	if (attr === undefined || attr.initializer === undefined) return null;
	const s = staticValue(attr);
	if (s !== null) return s.trim() === "" ? null : `"${s}"`;
	const init = attr.initializer;
	if (ts.isJsxExpression(init) && init.expression !== undefined) return init.expression.getText().replace(/\s+/g, "");
	return null;
}

/**
 * @typedef {{icons: Set<string>, htmlFor: Set<string>, mutate: Set<string>, wrapped: Map<string, string>}} Ctx
 * @typedef {{rule: string, line: number, text: string}} Finding
 * @typedef {{control_name: number, clickable_role: number, field_label: number}} Examined
 */

/**
 * Every finding in one source file, and how many elements each rule examined.
 *
 * `mutate` switches one exemption or rule OFF (or a matcher's escape ON) — it exists for the
 * self-test, which uses it to prove that each one is live: a fixture that passes only because of
 * an exemption must FAIL once that exemption is mutated away.
 *
 * @param {string} text
 * @param {string} [fileName]
 * @param {Set<string>} [mutate]
 * @param {Map<string, string>} [wrappers] the derived `@repo/ui` thin-wrapper map
 * @returns {{findings: Finding[], examined: Examined, parseErrors: string[]}}
 */
function analyse(text, fileName = "fixture.tsx", mutate = new Set(), wrappers = WRAPPERS) {
	const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	// `parseDiagnostics` is the parser's own list and is not on the public type; read it without a cast.
	/** @type {{messageText: string | {messageText: string}, start?: number}[]} */
	const diags = Reflect.get(sf, "parseDiagnostics") ?? [];
	const parseErrors = diags.map((d) => {
		const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
		const line = d.start === undefined ? 0 : sf.getLineAndCharacterOfPosition(d.start).line + 1;
		return `${line}: ${msg}`;
	});

	/** @type {Set<string>} */
	const htmlFor = new Set();
	const collect = (/** @type {import("typescript").Node} */ n) => {
		const op = openingOf(n);
		if (op !== null && ["label", "Label", "FormLabel"].includes(tagOf(op))) {
			const k = pairKey(attrsOf(op).attrs.get("htmlFor"));
			if (k !== null) htmlFor.add(k);
		}
		ts.forEachChild(n, collect);
	};
	collect(sf);
	/** @type {Ctx} */
	const ctx = { icons: iconImports(sf), htmlFor, mutate, wrapped: mutate.has("no-wrappers") ? new Map() : wrapperImports(sf, wrappers) };

	/** @type {Finding[]} */
	const findings = [];
	/** @type {Examined} */
	const examined = { control_name: 0, clickable_role: 0, field_label: 0 };
	const report = (/** @type {string} */ rule, /** @type {import("typescript").Node} */ node, /** @type {import("typescript").JsxOpeningLikeElement} */ op) => {
		if (mutate.has(`off:${rule}`)) return;
		const src = op.getText().replace(/\s+/g, " ");
		findings.push({
			rule,
			line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
			text: src.length > 100 ? `${src.slice(0, 97)}…` : src,
		});
	};

	const visit = (/** @type {import("typescript").Node} */ node) => {
		const opened = openingOf(node);
		// An element carrying `hidden` is not rendered, so it is in no accessibility tree to be
		// unnamed in (the file input a visible button proxies is the shape). `hidden={cond}` is NOT
		// this: it may well render.
		const op = opened !== null && (mutate.has("no-hidden") || staticValue(attrsOf(opened).attrs.get("hidden")) !== "true") ? opened : null;
		if (op !== null) {
			const tag = tagOf(op);
			const { attrs } = attrsOf(op);
			const role = staticValue(attrs.get("role"));

			// control_name — not for an element that is itself a RENDER SLOT (`render={<Link href />}`):
			// that element is the host's markup, and the host's content is its name.
			if ((NAMED_FROM_CONTENT_TAGS.has(tag) || (role !== null && NAMED_FROM_CONTENT_ROLES.has(role))) && (mutate.has("no-slot") || !isRenderSlot(node))) {
				examined.control_name++;
				const named = (!mutate.has("no-self-name") && selfNamed(attrs)) || contentRendersText(node, attrs, ctx);
				if (!named) report("control_name", node, op);
			}

			// clickable_role — through the derived wrapper map, so `<TableRow onClick>` is a `<tr>`.
			const intrinsic = ctx.wrapped.get(tag) ?? tag;
			if (/^[a-z]/.test(intrinsic) && !intrinsic.includes(".") && !INTERACTIVE_INTRINSICS.has(intrinsic) && attrs.has("onClick")) {
				examined.clickable_role++;
				const wall = !mutate.has("no-wall") && isPropagationWall(attrs.get("onClick"));
				if (!attrs.has("role") && !wall) report("clickable_role", node, op);
			}

			// field_label
			if (FIELD_TAGS.has(tag) && !(tag === "input" && NON_FIELD_INPUT_TYPES.has(staticValue(attrs.get("type")) ?? ""))) {
				examined.field_label++;
				if (!fieldLabelled(node, attrs, ctx)) report("field_label", node, op);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return { findings, examined, parseErrors };
}

/**
 * Whether a form field is labelled by any of the four routes the header lists.
 *
 * @param {import("typescript").Node} node
 * @param {Map<string, import("typescript").JsxAttribute>} attrs
 * @param {Ctx} ctx
 * @returns {boolean}
 */
function fieldLabelled(node, attrs, ctx) {
	if (!ctx.mutate.has("no-self-name") && selfNamed(attrs)) return true;
	const ancestors = jsxAncestors(node);
	const tags = ancestors.map((a) => tagOf(a.openingElement));
	if (!ctx.mutate.has("no-label-wrap") && tags.some((t) => t === "label" || t === "Label")) return true;
	if (!ctx.mutate.has("no-form-label")) {
		const control = tags.indexOf("FormControl");
		if (control !== -1) {
			const item = ancestors.slice(control).find((a) => tagOf(a.openingElement) === "FormItem");
			if (item !== undefined && containsTag(item, "FormLabel")) return true;
		}
	}
	if (!ctx.mutate.has("no-id-pair")) {
		const k = pairKey(attrs.get("id"));
		if (k !== null && ctx.htmlFor.has(k)) return true;
	}
	return false;
}

// ── the tree ─────────────────────────────────────────────────────────────────────────────────

/**
 * Every `.tsx` under a root, relative to apps/console. An unreadable directory RAISES.
 *
 * @param {string} rel
 * @returns {string[]}
 */
function walk(rel) {
	const out = [];
	for (const d of fs.readdirSync(path.join(CONSOLE, rel), { withFileTypes: true })) {
		const r = `${rel}/${d.name}`;
		if (d.isDirectory()) {
			if (d.name !== "node_modules") out.push(...walk(r));
		} else if (d.name.endsWith(EXT)) out.push(r);
	}
	return out;
}

/**
 * Scan the console. A root with no files, or a file that does not parse, is a failure.
 *
 * @returns {{byFile: Map<string, Finding[]>, examined: Examined, files: number, problems: string[]}}
 */
function scanTree() {
	/** @type {Map<string, Finding[]>} */
	const byFile = new Map();
	/** @type {Examined} */
	const examined = { control_name: 0, clickable_role: 0, field_label: 0 };
	const problems = [];
	let files = 0;
	for (const root of ROOTS) {
		let list;
		try {
			list = walk(root);
		} catch (err) {
			problems.push(`root apps/console/${root} could not be read (${String(err)}) — a missing root is a broken guard, not a clean tree`);
			continue;
		}
		if (list.length === 0) problems.push(`root apps/console/${root} holds no ${EXT} file — the walker or the root moved`);
		for (const rel of list.sort()) {
			files++;
			const r = analyse(fs.readFileSync(path.join(CONSOLE, rel), "utf8"), rel);
			if (r.parseErrors.length > 0) problems.push(`apps/console/${rel} does not parse (${r.parseErrors[0]}) — refused rather than read as a partial tree`);
			for (const k of RULE_IDS) examined[k] += r.examined[k];
			if (r.findings.length > 0) byFile.set(`apps/console/${rel}`, r.findings);
		}
	}
	return { byFile, examined, files, problems };
}

// ── the ledger ───────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{section: string, path: string, hits: number, kind: "reason" | "lifts" | null, note: string, line: number}} Entry
 * @typedef {{baseline: number | null, debt: number | null, floors: Map<string, number>, entries: Entry[]}} Ledger
 */

/** The `floors:` keys: files scanned, then elements examined per rule. */
const FLOOR_KEYS = ["files", ...RULE_IDS];

/**
 * Parse the allowlist. Anything it does not recognise is an error, never an ignored block.
 *
 * @param {string} text
 * @returns {Ledger}
 */
function parseLedger(text) {
	/** @type {Ledger} */
	const out = { baseline: null, debt: null, floors: new Map(), entries: [] };
	/** @type {string | null} */
	let section = null;
	/** @type {Entry | null} */
	let cur = null;
	const seen = new Map();
	const bad = (/** @type {number} */ n, /** @type {string} */ why) => {
		throw new Error(`${ALLOWLIST}:${n}: ${why}`);
	};
	const close = () => {
		if (cur === null) return;
		if (cur.hits < 1) bad(cur.line, `entry for ${cur.path} has no positive \`hits:\``);
		if (cur.kind === null) bad(cur.line, `entry for ${cur.path} has neither \`reason:\` nor \`lifts:\` — it must be one or the other`);
		const key = `${cur.section} ${cur.path}`;
		if (seen.has(key)) bad(cur.line, `a second \`${cur.section}\` entry for ${cur.path} — the first is on line ${seen.get(key)}. One entry per file per section.`);
		seen.set(key, cur.line);
		out.entries.push(cur);
		cur = null;
	};
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const n = i + 1;
		if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
		let m;
		if ((m = raw.match(/^(baseline|debt): (\d+)$/))) {
			close();
			if (out[m[1]] !== null) bad(n, `\`${m[1]}:\` appears twice`);
			out[m[1]] = Number(m[2]);
			section = null;
			continue;
		}
		if ((m = raw.match(/^([a-z_]+):$/))) {
			close();
			if (m[1] !== "floors" && !RULE_IDS.includes(m[1])) bad(n, `unknown section \`${m[1]}\` — the sections are floors, ${RULE_IDS.join(", ")}`);
			section = m[1];
			continue;
		}
		if (section === "floors") {
			if (!(m = raw.match(/^ {2}([a-z_]+): (\d+)$/)) || !FLOOR_KEYS.includes(m[1])) bad(n, `a \`floors:\` line is \`  <${FLOOR_KEYS.join("|")}>: <n>\``);
			out.floors.set(m[1], Number(m[2]));
			continue;
		}
		if (section === null) bad(n, "a row outside any section");
		if ((m = raw.match(/^ {2}- path: (\S+)$/))) {
			close();
			cur = { section, path: m[1], hits: 0, kind: null, note: "", line: n };
			continue;
		}
		if (cur === null) bad(n, "a field before any `- path:`");
		if ((m = raw.match(/^ {4}hits: (\d+)$/))) {
			cur.hits = Number(m[1]);
			continue;
		}
		if ((m = raw.match(/^ {4}(reason|lifts): (.+)$/))) {
			if (cur.kind !== null) bad(n, `entry for ${cur.path} carries both \`reason:\` and \`lifts:\``);
			const note = m[2].replace(/^"(.*)"$/, "$1");
			if (m[1] === "lifts" && !/^#\d+\b/.test(note)) bad(n, `a \`lifts:\` must start with the board issue that removes it (\`"#<n> …"\`, quoted)`);
			cur.kind = /** @type {"reason" | "lifts"} */ (m[1]);
			cur.note = note;
			continue;
		}
		bad(n, `unrecognised line: ${raw.trim()}`);
	}
	close();
	if (out.baseline === null || out.debt === null) throw new Error(`${ALLOWLIST}: missing \`baseline:\` or \`debt:\``);
	for (const k of FLOOR_KEYS) if (!out.floors.has(k)) throw new Error(`${ALLOWLIST}: \`floors:\` has no \`${k}\` — every rule needs an examined floor, or a rule that stopped matching reads as clean`);
	return out;
}

/**
 * The ledger's counters as its rows say they are.
 *
 * @param {Ledger} ledger
 * @returns {{baseline: number, debt: number}}
 */
function deriveCounters(ledger) {
	return {
		baseline: ledger.entries.filter((e) => e.kind === "reason").length,
		debt: ledger.entries.filter((e) => e.kind === "lifts").length,
	};
}

/**
 * Compare a scan against the ledger. Pure, so the self-test can hand it fixtures.
 *
 * @param {{byFile: Map<string, Finding[]>, examined: Examined, files: number}} scan
 * @param {Ledger} ledger
 * @returns {string[]} the failures, empty when clean
 */
function judge(scan, ledger) {
	const fails = [];
	const { baseline, debt } = deriveCounters(ledger);
	if (baseline !== ledger.baseline || debt !== ledger.debt)
		fails.push(
			`${ALLOWLIST}: the counters say baseline ${ledger.baseline} / debt ${ledger.debt}, the rows say ${baseline} / ${debt}. They are derived — run \`pnpm -C apps/console run gen:control-names\` and commit.`,
		);
	if (scan.files < (ledger.floors.get("files") ?? 0)) fails.push(`scanned ${scan.files} files, below the floor of ${ledger.floors.get("files")} — the walker or a root moved`);
	for (const k of RULE_IDS) {
		const f = ledger.floors.get(k) ?? 0;
		if (scan.examined[k] < f) fails.push(`\`${k}\` examined ${scan.examined[k]} elements, below the floor of ${f} — a tag list or the parser stopped matching`);
	}
	/** @type {Map<string, Entry>} */
	const rows = new Map(ledger.entries.map((e) => [`${e.section} ${e.path}`, e]));
	/** @type {Map<string, {rule: string, path: string, items: Finding[]}>} */
	const groups = new Map();
	for (const [file, list] of scan.byFile) {
		for (const f of list) {
			const key = `${f.rule} ${file}`;
			if (!groups.has(key)) groups.set(key, { rule: f.rule, path: file, items: [] });
			groups.get(key)?.items.push(f);
		}
	}
	for (const [key, g] of groups) {
		const row = rows.get(key);
		const n = g.items.length;
		if (row === undefined) {
			for (const f of g.items) fails.push(`${g.path}:${f.line} [${g.rule}] ${f.text}\n    ${SAY[g.rule]}`);
		} else if (n !== row.hits) {
			const where = g.items.map((f) => `      ${g.path}:${f.line} ${f.text}`).join("\n");
			fails.push(
				n > row.hits
					? `${g.path} [${g.rule}] has ${n} findings, the ledger grants ${row.hits} (${ALLOWLIST}:${row.line}). New drift:\n${where}\n    ${SAY[g.rule]}`
					: `${g.path} [${g.rule}] has ${n} findings, the ledger grants ${row.hits} (${ALLOWLIST}:${row.line}). Lower \`hits:\` to ${n} — an unrecorded win is one the next change can quietly spend.`,
			);
		}
	}
	for (const [key, row] of rows)
		if (!groups.has(key)) fails.push(`${ALLOWLIST}:${row.line}: ${row.path} [${row.section}] has NO findings — delete the row (it was ${row.kind === "lifts" ? "debt, now paid" : "a decision about a site that is gone"}).`);
	return fails;
}

/**
 * Rewrite the two counters from the rows and nothing else.
 *
 * @param {string} text
 * @returns {string}
 */
function writeCounters(text) {
	const c = deriveCounters(parseLedger(text.replace(/^baseline: \d+$/m, "baseline: 0").replace(/^debt: \d+$/m, "debt: 0")));
	return text.replace(/^baseline: \d+$/m, `baseline: ${c.baseline}`).replace(/^debt: \d+$/m, `debt: ${c.debt}`);
}

/**
 * Derived at load from the real `packages/ui/src`, before any mode runs — including the self-test —
 * so a broken derivation refuses the guard rather than shrinking what it reads.
 */
const WRAPPERS = deriveWrappers(SHARED_UI);

// ── probes, fired on every run, and the self-test ────────────────────────────────────────────

/**
 * Each rule's probes (MUST be found) and anti-probes (must NOT be found). An anti-probe that
 * passes only because of an exemption names it under `rests:` — the self-test mutates that
 * exemption away and requires the anti-probe to flip into a finding, which is what proves the
 * exemption is live and not vacuous. One without `rests:` is plain discrimination.
 */
const PROBES = {
	control_name: {
		probe: `import { X } from "lucide-react";\nexport const A = () => <Button size="icon" onClick={f}><X className="size-4" /></Button>;`,
		also: [
			`export const A = () => <a href="/x"><GearIcon /></a>;`,
			`export const A = () => <div role="button" tabIndex={0} onClick={f}><span aria-hidden>×</span></div>;`,
			`export const A = () => <button type="button" aria-label="">{cond ? <XIcon /> : null}</button>;`,
			`export const A = () => (\n\t<Button size="icon">\n\t\t<XIcon />\n\t</Button>\n);`,
			`export const A = () => <a href="/"><img src="/logo.svg" /></a>;`,
			`export const A = () => <Button size="icon">{busy && <Spinner />}</Button>;`,
		],
		anti: [
			{ rests: "no-self-name", src: `import { X } from "lucide-react";\nexport const A = () => <Button size="icon" aria-label={t("close")}><X /></Button>;` },
			{ src: `import { X } from "lucide-react";\nexport const A = () => <Button size="icon"><X /><span className="sr-only">Close</span></Button>;` },
			{ src: `export const A = () => <Link href="/x"><ProviderName id={p} /></Link>;` },
			{ src: `export const A = () => <a href="/"><img src="/logo.svg" alt="Alethia home" /></a>;` },
			{ src: `export const A = () => <button>{undefined ?? "Close"}</button>;` },
			{ rests: "no-slot", src: `export const A = () => <Button nativeButton={false} render={<Link href="/x" />}>Support</Button>;` },
		],
	},
	clickable_role: {
		probe: `export const A = () => <div className="row" onClick={() => open(id)}>{name}</div>;`,
		also: [
			`export const A = () => <li onClick={select}>{x}</li>;`,
			`import { TableRow } from "@repo/ui/table";\nexport const A = () => <TableRow onClick={() => open(id)}>{cells}</TableRow>;`, `export const A = () => <div onClick={(e) => { e.stopPropagation(); open(); }} />;`,
			`export const A = () => <div onClick={(e) => e.persist()} />;`],
		anti: [
			{ rests: "no-wall", src: `export const A = () => <div onClick={(e) => e.stopPropagation()}><Button>Go</Button></div>;` },
			{ src: `export const A = () => <div role="button" tabIndex={0} onClick={go}>Go</div>;` },
			{ src: `export const A = () => <label onClick={go}>x</label>;` },
			{ src: `import { TableRow } from "./local-table";\nexport const A = () => <TableRow onClick={go}>{cells}</TableRow>;` },
		],
	},
	field_label: {
		probe: `export const A = () => <Input placeholder="Search…" value={q} onChange={f} />;`,
		also: [`export const A = () => <><Label htmlFor="a">A</Label><input id="b" /></>;`, `export const A = () => <FormItem><FormControl><Textarea {...field} /></FormControl></FormItem>;`],
		anti: [
			{ rests: "no-self-name", src: `export const A = () => <Input aria-label="Search" />;` },
			{ rests: "no-id-pair", src: `export const A = () => { const id = useId(); return <><Label htmlFor={id}>Name</Label><Input id={id} /></>; };` },
			{ rests: "no-label-wrap", src: `export const A = () => <label>Accept <Checkbox checked={c} /></label>;` },
			{ rests: "no-form-label", src: `export const A = () => <FormItem><FormLabel>Name</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>;` },
			{ src: `export const A = () => <input type="hidden" name="x" value={v} />;` },
			{ rests: "no-hidden", src: `export const A = () => <input ref={r} type="file" hidden onChange={f} />;` },
		],
	},
};

/**
 * Fire every rule's probe and anti-probes through the analyser. Returns the failures.
 *
 * @param {Set<string>} [mutate]
 * @returns {string[]}
 */
function fireProbes(mutate = new Set()) {
	const fails = [];
	for (const rule of RULE_IDS) {
		const p = PROBES[rule];
		for (const src of [p.probe, ...p.also]) {
			const r = analyse(src, "probe.tsx", mutate);
			if (r.parseErrors.length > 0) fails.push(`[${rule}] probe does not parse: ${r.parseErrors[0]}`);
			if (!r.findings.some((f) => f.rule === rule)) fails.push(`[${rule}] probe NOT found — the rule has stopped matching: ${src.split("\n").pop()}`);
		}
		for (const a of p.anti) {
			const r = analyse(a.src, "anti.tsx", mutate);
			if (r.parseErrors.length > 0) fails.push(`[${rule}] anti-probe does not parse: ${r.parseErrors[0]}`);
			if (r.findings.some((f) => f.rule === rule)) fails.push(`[${rule}] anti-probe FOUND — the rule no longer discriminates: ${a.src.split("\n").pop()}`);
		}
	}
	return fails;
}

/**
 * The self-test. Every assertion is one the guard could fail; the exit code is the test.
 *
 * @returns {number} the failure count
 */
function selfTest() {
	let failed = 0;
	const t = (/** @type {string} */ name, /** @type {boolean} */ ok) => {
		process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${name}\n`);
		if (!ok) failed++;
	};

	t("unmutated: every probe is found and every anti-probe is not", fireProbes().length === 0);

	// MUTATION 1 — each rule switched off must make the probe suite fail. A suite that stays
	// green with a rule deleted was not testing that rule.
	for (const rule of RULE_IDS) t(`mutation off:${rule} is killed by the probes`, fireProbes(new Set([`off:${rule}`])).some((f) => f.startsWith(`[${rule}] probe NOT found`)));

	// MUTATION 2 — each exemption switched off must flip the anti-probe that rests on it into a
	// finding. An exemption no anti-probe depends on is dead weight that could be widened unseen.
	for (const rule of RULE_IDS)
		for (const a of PROBES[rule].anti) {
			if (a.rests === undefined) continue;
			const r = analyse(a.src, "anti.tsx", new Set([a.rests]));
			t(`mutation ${a.rests} flips the ${rule} anti-probe into a finding`, r.findings.some((f) => f.rule === rule));
		}
	// Two exemptions carried by an anti-probe that ALSO passes another way are checked directly.
	t("mutation icons-are-text: an icon-only button reads as named (so the icon exemption is live)", analyse(PROBES.control_name.probe, "m.tsx", new Set(["icons-are-text"])).findings.length === 0);
	t(
		"an aria-hidden={expr} child is not text; mutated, it is",
		analyse(`export const A = () => <button><span aria-hidden={true}>x</span></button>;`).findings.length === 1 &&
			analyse(`export const A = () => <button><span aria-hidden={h}>x</span></button>;`, "m.tsx", new Set(["aria-hidden-expr"])).findings.length === 0,
	);

	t(
		"mutation no-wrappers: `<TableRow onClick>` stops being a finding (so the derived map is live)",
		analyse(PROBES.clickable_role.also[1], "m.tsx", new Set(["no-wrappers"])).findings.length === 0,
	);
	t("the wrapper derivation REFUSES a directory it reads nothing from", (() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccn-"));
		try {
			deriveWrappers(dir);
			return false;
		} catch {
			return true;
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	})());

	// Element-level facts a line regex would get wrong.
	t(
		"a name eleven lines below the `<` is read",
		analyse(`export const A = () => (\n<Button\n size="icon"\n\n\n\n\n\n\n\n\n aria-label="Close">\n<XIcon />\n</Button>);`).findings.length === 0,
	);
	t("a `>` inside an arrow prop does not end the tag", analyse(`export const A = () => <Button onClick={() => a > b} aria-label="x"><XIcon /></Button>;`).findings.length === 0);
	t("a label three levels up names the field", analyse(`export const A = () => <label><div><span><Input /></span></div></label>;`).findings.length === 0);
	t("a FormControl whose FormItem has NO FormLabel is a finding", analyse(`export const A = () => <FormItem><FormControl><Input /></FormControl></FormItem>;`).findings.length === 1);
	t("an id paired with a DIFFERENT htmlFor is a finding", analyse(`export const A = () => <><Label htmlFor={a}>A</Label><Input id={b} /></>;`).findings.length === 1);
	t("a file that does not parse is reported, not read", analyse(`export const A = () => <Button>;`).parseErrors.length > 0);
	t("the icon exemption reads the IMPORT, not a guess: `X` from elsewhere may be text", analyse(`import { X } from "./x";\nexport const A = () => <Button><X /></Button>;`).findings.length === 0);

	// The ledger: every direction of drift fails.
	const scan = (/** @type {number} */ n) => ({
		byFile: new Map(n === 0 ? [] : [["apps/console/components/a.tsx", Array.from({ length: n }, (_, i) => ({ rule: "control_name", line: i + 1, text: "<Button>" }))]]),
		examined: { control_name: 10, clickable_role: 10, field_label: 10 },
		files: 10,
	});
	const ledger = (/** @type {string} */ body, b = 0, d = 1) =>
		parseLedger(`baseline: ${b}\ndebt: ${d}\nfloors:\n  files: 5\n  control_name: 5\n  clickable_role: 5\n  field_label: 5\ncontrol_name:\n${body}`);
	const row = (/** @type {number} */ h) => `  - path: apps/console/components/a.tsx\n    hits: ${h}\n    lifts: "#5046 x"\n`;
	t("ledger: exact hits pass", judge(scan(2), ledger(row(2))).length === 0);
	t("ledger: MORE findings than hits fail", judge(scan(3), ledger(row(2))).length === 1);
	t("ledger: FEWER findings than hits fail", judge(scan(1), ledger(row(2))).length === 1);
	t("ledger: a row whose file is clean fails", judge(scan(0), ledger(row(2))).length === 1);
	t("ledger: an unrecorded finding fails", judge(scan(1), ledger("", 0, 0)).length === 1);
	t("ledger: a hand-typed counter that disagrees with the rows fails", judge(scan(2), ledger(row(2), 0, 2)).length === 1);
	t("ledger: files below the floor fail", judge({ ...scan(2), files: 4 }, ledger(row(2))).length === 1);
	t("ledger: a rule examining below its floor fails", judge({ ...scan(2), examined: { control_name: 10, clickable_role: 4, field_label: 10 } }, ledger(row(2))).length === 1);
	const throws = (/** @type {() => unknown} */ f) => {
		try {
			f();
			return false;
		} catch {
			return true;
		}
	};
	t("ledger: an unknown section is a parse error", throws(() => ledger("", 0, 0).entries && parseLedger("baseline: 0\ndebt: 0\nfloors:\n  files: 1\n  control_name: 1\n  clickable_role: 1\n  field_label: 1\nswitch_name:\n")));
	t("ledger: a row with neither reason nor lifts is a parse error", throws(() => ledger(`  - path: a.tsx\n    hits: 1\n`)));
	t("ledger: a lifts without an issue number is a parse error", throws(() => ledger(`  - path: a.tsx\n    hits: 1\n    lifts: "later"\n`)));
	t("ledger: a duplicate row is a parse error", throws(() => ledger(row(1) + row(1), 0, 2)));
	t("ledger: a missing floor is a parse error", throws(() => parseLedger("baseline: 0\ndebt: 0\nfloors:\n  files: 1\n")));
	t("--write derives the counters from the rows", writeCounters(`baseline: 9\ndebt: 9\nfloors:\n  files: 1\n  control_name: 1\n  clickable_role: 1\n  field_label: 1\ncontrol_name:\n${row(1)}`).includes("baseline: 0\ndebt: 1"));

	process.stdout.write(failed === 0 ? "check-control-names self-test: all passed\n" : `check-control-names self-test: ${failed} FAILED\n`);
	return failed;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const ledgerPath = path.join(CONSOLE, ALLOWLIST);

if (args.has("--self-test")) {
	process.exit(selfTest() === 0 ? 0 : 1);
} else if (args.has("--write")) {
	fs.writeFileSync(ledgerPath, writeCounters(fs.readFileSync(ledgerPath, "utf8")));
	process.stdout.write(`${ALLOWLIST}: counters rewritten from the rows\n`);
} else {
	const probeFails = fireProbes();
	if (probeFails.length > 0) {
		process.stderr.write(`check-control-names: the permanent probes failed — a rule has stopped matching or discriminating:\n${probeFails.map((f) => `  ${f}`).join("\n")}\n`);
		process.exit(1);
	}
	const scan = scanTree();
	if (args.has("--json")) {
		process.stdout.write(`${JSON.stringify({ files: scan.files, examined: scan.examined, problems: scan.problems, findings: Object.fromEntries(scan.byFile) }, null, 1)}\n`);
		process.exit(0);
	}
	const fails = [...scan.problems, ...judge(scan, parseLedger(fs.readFileSync(ledgerPath, "utf8")))];
	if (fails.length > 0) {
		process.stderr.write(`check-control-names: ${fails.length} failure(s)\n\n${fails.join("\n\n")}\n`);
		process.exit(1);
	}
	const total = [...scan.byFile.values()].reduce((a, l) => a + l.length, 0);
	process.stdout.write(
		`✓ check-control-names: ${scan.files} files, examined ${RULE_IDS.map((k) => `${scan.examined[k]} ${k}`).join(" · ")}; ${total} finding(s), every one on the ledger\n`,
	);
}
