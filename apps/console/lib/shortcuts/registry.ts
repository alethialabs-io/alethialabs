// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's shortcut registry: every keyboard binding is one row here — an id, a chord, a
// scope and a label — and `useShortcut` (./use-shortcut.ts) is the one listener that reads it.
//
// This file is the table and its rules, with no React and no listener in it, so the rules are unit
// tested as plain functions and a shortcut list can be rendered from the same rows the dispatcher
// matches against.
//
// What `registerShortcuts` refuses, and where each rule stops:
//
//   - Tab is never bindable, in any scope, with any modifier. Tab and Shift+Tab are the browser's
//     focus traversal.
//   - A `global` binding must be a modifier chord (⌘/Ctrl or ⌥/Alt held). That one rule is what
//     keeps Enter, Esc and every bare letter out of the shell: Shift alone is not a modifier here,
//     because Shift+letter is still typing.
//   - A `canvas` binding may be a bare key (a letter, Enter, Esc, Delete). The board is a tool
//     surface with its own key map, and it registers that map through this file rather than
//     through a second listener.
//   - A `list` binding may be a bare key too: the list page's own keys, answered only while a list
//     toolbar is mounted (`/` to search, #7737). Like every bare key, it never fires while the
//     focus is in a field — the dispatcher's input rule, not this scope, is what keeps `/` typeable.
//   - `allowInInput` may only be set on a modifier chord. A bare key can never fire while the
//     focus is in a field, whatever the row says.
//   - Two rows in the SAME scope may not answer the same chord. Two rows in DIFFERENT scopes may:
//     the narrower scope wins while one of its handlers is mounted (`SCOPE_RANK`), which is how the
//     board's own ⌘K can take precedence over the shell's.
//
// The rules are enforced where a row is registered, not where a key is pressed, so a bad row fails
// when its module loads — in every test that imports it — rather than on the one keystroke nobody
// tried.

/**
 * Where a binding applies. `global` is the whole shell; `list` is a list page, while its toolbar is
 * mounted; `canvas` is the architecture board.
 */
export type ShortcutScope = "global" | "list" | "canvas";

/**
 * Which scope wins when two mounted bindings answer the same chord: the higher rank. The narrower
 * surface outranks the shell it sits in.
 */
export const SCOPE_RANK: Record<ShortcutScope, number> = { global: 0, list: 1, canvas: 2 };

/** A key combination. */
export interface ShortcutChord {
	/** `KeyboardEvent.key`, lower-cased: `"k"`, `"?"`, `"escape"`, `"enter"`, `" "`. */
	key: string;
	/**
	 * `KeyboardEvent.code` to accept as well (`"KeyE"`). Needed where the modifier rewrites `key`:
	 * on macOS ⌥E reports `key: "Dead"`, so only the physical key identifies it.
	 */
	code?: string;
	/** ⌘ on macOS, Ctrl elsewhere. Matched as "either is held", like every handler it replaces. */
	mod?: boolean;
	/** ⌥ on macOS, Alt elsewhere. */
	alt?: boolean;
	/** `true` or `false` requires that state of Shift; left out, Shift is not read (`?`). */
	shift?: boolean;
}

/** One row of the registry. */
export interface ShortcutBinding {
	/** Stable identity, e.g. `"palette.toggle"`. Registering an id again replaces its row. */
	id: string;
	chord: ShortcutChord;
	scope: ShortcutScope;
	/** What the shortcut does, as a shortcut list shows it. */
	label: string;
	/** Fire while the focus is in an input, textarea, select or contenteditable. Modifier chords only. */
	allowInInput?: boolean;
	/** Fire while the focus is inside a dialog, alert dialog or menu. */
	allowInDialog?: boolean;
}

/** The part of a `KeyboardEvent` a chord is matched against. */
export type ChordEvent = Pick<
	KeyboardEvent,
	"key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

/** Toggle the shell's command palette. */
export const SHORTCUT_PALETTE_TOGGLE = "palette.toggle";
/** Switch the project view to its next environment. */
export const SHORTCUT_ENVIRONMENT_NEXT = "environment.next";
/** Focus the list page's search (answered by `useListSearchShortcut`, #7737). */
export const SHORTCUT_LIST_SEARCH = "list.search";

/** The scopes in which a binding may be a bare key, with no ⌘/Ctrl or ⌥/Alt held. */
const BARE_KEY_SCOPES: readonly ShortcutScope[] = ["list", "canvas"];

const registry = new Map<string, ShortcutBinding>();

/** True when the chord holds ⌘/Ctrl or ⌥/Alt — Shift alone does not make a modifier chord. */
export function isModifierChord(chord: ShortcutChord): boolean {
	return chord.mod === true || chord.alt === true;
}

/** True when two chords can be produced by the same key press. */
function chordsOverlap(a: ShortcutChord, b: ShortcutChord): boolean {
	const sameKey = a.key === b.key || (a.code !== undefined && a.code === b.code);
	if (!sameKey) return false;
	if ((a.mod ?? false) !== (b.mod ?? false)) return false;
	if ((a.alt ?? false) !== (b.alt ?? false)) return false;
	return a.shift === undefined || b.shift === undefined || a.shift === b.shift;
}

/**
 * Why a binding may not be registered, or `null` when it may. Reads the binding alone — the
 * clash with another row is `registerShortcuts`' to find, because it depends on the table.
 */
export function shortcutProblem(binding: ShortcutBinding): string | null {
	const { chord, scope, id } = binding;
	if (chord.key !== chord.key.toLowerCase())
		return `${id}: chord.key must be lower-case ("${chord.key}")`;
	if (chord.key === "tab" || chord.code === "Tab")
		return `${id}: Tab is the browser's focus traversal and is never bound`;
	if (!BARE_KEY_SCOPES.includes(scope) && !isModifierChord(chord))
		return `${id}: a ${scope} shortcut must hold ⌘/Ctrl or ⌥/Alt — a bare key is allowed only in the list and canvas scopes`;
	if (binding.allowInInput === true && !isModifierChord(chord))
		return `${id}: only a modifier chord may be allowed while typing in a field`;
	return null;
}

/**
 * Adds bindings to the registry, or replaces the rows whose ids are already there. Throws on a
 * binding the rules refuse and on a chord another row in the same scope already answers; when it
 * throws, nothing from the call has been registered.
 */
export function registerShortcuts(bindings: readonly ShortcutBinding[]): void {
	const next = new Map(registry);
	for (const binding of bindings) {
		const problem = shortcutProblem(binding);
		if (problem) throw new Error(`shortcut registry: ${problem}`);
		for (const other of next.values()) {
			if (other.id === binding.id || other.scope !== binding.scope) continue;
			if (chordsOverlap(other.chord, binding.chord))
				throw new Error(
					`shortcut registry: ${binding.id} and ${other.id} answer the same chord in the ${binding.scope} scope`,
				);
		}
		next.set(binding.id, binding);
	}
	registry.clear();
	for (const [id, binding] of next) registry.set(id, binding);
}

/** The binding registered under an id, or `undefined`. */
export function findShortcut(id: string): ShortcutBinding | undefined {
	return registry.get(id);
}

/** The binding registered under an id. Throws when there is none: a typo must not bind nothing. */
export function getShortcut(id: string): ShortcutBinding {
	const binding = registry.get(id);
	if (!binding) throw new Error(`shortcut registry: no shortcut is registered as "${id}"`);
	return binding;
}

/** Every registered binding, in registration order; with a scope, only that scope's. */
export function listShortcuts(scope?: ShortcutScope): ShortcutBinding[] {
	const all = [...registry.values()];
	return scope ? all.filter((b) => b.scope === scope) : all;
}

/** True when a key event is this chord: modifiers exactly as stated, and the key or its code. */
export function matchesChord(chord: ShortcutChord, event: ChordEvent): boolean {
	if ((event.metaKey || event.ctrlKey) !== (chord.mod ?? false)) return false;
	if (event.altKey !== (chord.alt ?? false)) return false;
	if (chord.shift !== undefined && event.shiftKey !== chord.shift) return false;
	if (event.key.toLowerCase() === chord.key) return true;
	return chord.code !== undefined && event.code === chord.code;
}

/** The nearest element to an event target: the target itself, or a text node's parent. */
function targetElement(target: EventTarget | null): Element | null {
	if (target instanceof Element) return target;
	if (target instanceof Node) return target.parentElement;
	return null;
}

/**
 * True when the event comes from somewhere the user types: an input, a textarea, a select, or
 * anything inside a contenteditable host. The attribute is read as well as `isContentEditable`
 * because the property is inherited state a host may not report on a nested node.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
	const el = targetElement(target);
	if (!el) return false;
	if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
	if (el instanceof HTMLElement && el.isContentEditable === true) return true;
	return el.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * True when the event comes from inside a dialog, alert dialog or menu. This reads where the FOCUS
 * is, not whether a dialog is on screen: a modal traps focus, so its keys originate inside it,
 * while a non-modal panel that carries the dialog role (the assistant) only counts while the user
 * is actually in it.
 */
export function isInDialog(target: EventTarget | null): boolean {
	const el = targetElement(target);
	return el?.closest('[role="dialog"],[role="alertdialog"],[role="menu"]') != null;
}

/** How named keys read in a shortcut list. A key not listed here is shown capitalised. */
const KEY_LABELS: Record<string, string> = {
	" ": "Space",
	escape: "Esc",
	delete: "Del",
	arrowup: "↑",
	arrowdown: "↓",
	arrowleft: "←",
	arrowright: "→",
};

/**
 * A chord as a shortcut list shows it, with the platform's modifier glyphs: `⌥E` and `⇧⌘Z` on
 * macOS, `Alt+E` and `Ctrl+Shift+Z` elsewhere.
 */
export function formatChord(chord: ShortcutChord, isMac: boolean): string {
	const key =
		KEY_LABELS[chord.key] ?? `${chord.key.charAt(0).toUpperCase()}${chord.key.slice(1)}`;
	if (isMac)
		return `${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.mod ? "⌘" : ""}${key}`;
	const parts: string[] = [];
	if (chord.mod) parts.push("Ctrl");
	if (chord.alt) parts.push("Alt");
	if (chord.shift) parts.push("Shift");
	parts.push(key);
	return parts.join("+");
}

// The shell's own bindings. A surface outside the shell registers its rows from its own module
// with `registerShortcuts`, in its own scope.
registerShortcuts([
	{
		id: SHORTCUT_PALETTE_TOGGLE,
		chord: { key: "k", mod: true, shift: false },
		scope: "global",
		label: "Command palette",
		// The palette's own search field has the focus while it is open, inside its own dialog, and
		// the same chord has to close it again.
		allowInInput: true,
		allowInDialog: true,
	},
	{
		id: SHORTCUT_ENVIRONMENT_NEXT,
		// ⌥E types a dead key on macOS, so the chord is identified by the physical key as well and
		// is not allowed while typing.
		chord: { key: "e", code: "KeyE", alt: true, shift: false },
		scope: "global",
		label: "Next environment",
	},
	{
		id: SHORTCUT_LIST_SEARCH,
		// Shift is not read: on many keyboard layouts `/` is itself a shifted key.
		chord: { key: "/" },
		scope: "list",
		label: "Search this list",
	},
]);
