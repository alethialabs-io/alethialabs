// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CopyButton } from "@repo/ui/copy-button";

import { eyebrow, mono } from "./primitives";

/**
 * A shell command on the public site: one line, in a bordered mono box, with a
 * copy button that is always visible.
 *
 * The command never wraps and never ellipsises — a wrapped command reads as two
 * commands, and a truncated one is copied wrong by hand. A long one scrolls
 * sideways INSIDE its own box instead, so the page itself never gets wider than
 * a 375px viewport. The copy button sits outside that scrolling strip, so it
 * cannot scroll out of reach.
 *
 * The `$ ` prompt is not selectable, so a hand selection copies the command
 * alone, the same text the button copies.
 */
export function CommandBlock({
	command,
	label,
}: {
	command: string;
	/** An eyebrow above the box, e.g. "Install". */
	label?: string;
}) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: "100%", minWidth: 0 }}>
			{label && <p style={{ ...eyebrow, fontSize: 10 }}>{label}</p>}
			<div
				style={{
					display: "flex",
					alignItems: "stretch",
					maxWidth: "100%",
					// Without this the row's min-width is its content's width, and a long command
					// widens every ancestor instead of scrolling inside the <pre>.
					minWidth: 0,
					border: "1px solid var(--border)",
					borderRadius: "var(--radius-md)",
					background: "var(--surface-sunken)",
				}}
			>
				<pre
					tabIndex={0}
					aria-label={label ? `${label} command` : "Shell command"}
					style={{
						...mono,
						flex: 1,
						minWidth: 0,
						margin: 0,
						padding: "11px 14px",
						fontSize: 13,
						lineHeight: 1.5,
						whiteSpace: "pre",
						overflowX: "auto",
						scrollbarWidth: "thin",
						color: "var(--text-primary)",
					}}
				>
					<span aria-hidden style={{ color: "var(--text-tertiary)", userSelect: "none" }}>
						${" "}
					</span>
					<code>{command}</code>
				</pre>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						flexShrink: 0,
						padding: "0 12px",
						borderLeft: "1px solid var(--border)",
					}}
				>
					<CopyButton text={command} />
				</div>
			</div>
		</div>
	);
}
