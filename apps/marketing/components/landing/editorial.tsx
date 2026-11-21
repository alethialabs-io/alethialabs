// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { Button } from "@repo/ui/button";
import { disp, eyebrow, mono, Wrap } from "@repo/brand/site-primitives";

/**
 * The editorial building blocks the open-source, enterprise and security pages share with the
 * home page's look: a two-tone statement, ruled section heads, ruled link rows, a bordered table
 * that scrolls only inside its own box, plain cards, numbered steps and a centred close.
 *
 * Everything here is a server component. Sizes come from the `text-ui-*` and `text-display-*`
 * rungs in `packages/brand/src/tokens.css`, never a hand-written pixel size.
 */

/** A link target. `external` opens a new tab, which is what a trailing ↗ promises. */
export interface EditorialLink {
	label: string;
	href: string;
	external?: boolean;
}

/** A button-styled link: primary by default, outline for the secondary action. */
export function ActionLink({ link, variant = "default" }: { link: EditorialLink; variant?: "default" | "outline" }) {
	const anchor = link.external ? (
		<a href={link.href} target="_blank" rel="noreferrer" />
	) : (
		<Link href={link.href} />
	);
	return (
		<Button variant={variant} nativeButton={false} render={anchor}>
			{link.label}
		</Button>
	);
}

/** A row of actions under a statement or a close; wraps on a phone. */
export function Actions({ children }: { children: ReactNode }) {
	return <div className="flex flex-wrap items-center gap-2.5">{children}</div>;
}

/**
 * The page's opening: one sentence in full weight and a quieter continuation, the same voice as
 * the home page's `Statement`. Anything passed as children (a command, the actions) sits below.
 */
export function EditorialStatement({ lead, rest, children }: { lead: string; rest: string; children?: ReactNode }) {
	return (
		<section className="pt-[72px] pb-12 max-[640px]:pt-12 max-[640px]:pb-8">
			<Wrap>
				<h1
					className="text-display-md"
					style={{ ...disp, margin: 0, maxWidth: "46ch", lineHeight: 1.14, letterSpacing: "var(--tracking-display)", color: "var(--text-primary)", fontWeight: 400, textWrap: "balance" }}
				>
					<span style={{ fontWeight: 600 }}>{lead}</span> {rest}
				</h1>
				{children && <div className="mt-[30px] flex min-w-0 flex-col gap-3.5">{children}</div>}
			</Wrap>
		</section>
	);
}

/** One section of the page body, with the bottom spacing every block shares. */
export function Block({ children, label }: { children: ReactNode; label?: string }) {
	return (
		<section aria-label={label} className="pb-[72px] max-[640px]:pb-12">
			<Wrap>{children}</Wrap>
		</section>
	);
}

/**
 * A section head between two hairlines: the title on the left, and on the right either a link
 * (`action`) or a quiet note (`aside`).
 */
export function RuleHead({ title, action, aside }: { title: string; action?: EditorialLink; aside?: string }) {
	return (
		<div
			className="mb-[18px] flex items-baseline justify-between gap-4"
			style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", padding: "12px 0" }}
		>
			<h2 className="text-ui-lg" style={{ ...disp, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>
				{title}
			</h2>
			{action && (
				<a
					href={action.href}
					target={action.external ? "_blank" : undefined}
					rel={action.external ? "noreferrer" : undefined}
					className="text-ui-md text-text-secondary no-underline hover:text-text-primary"
				>
					{action.label}
				</a>
			)}
			{aside && (
				<span className="text-ui-sm text-text-tertiary" style={mono}>
					{aside}
				</span>
			)}
		</div>
	);
}

/** One ruled row: a mono date-like cell, an uppercase key, the title, and an arrow when it links. */
export interface Row {
	d: string;
	k: string;
	t: string;
	href?: string;
}

/**
 * The cells of one row. On a wide screen the three text cells and the arrow are the four columns
 * of the row's grid (`md:contents` lifts the text cells out of their wrapper); on a phone the text
 * cells stack in one column and the arrow sits beside them, centred.
 */
function RowCells({ row }: { row: Row }) {
	return (
		<>
			<span className="grid min-w-0 gap-1 md:contents">
				<span className="text-ui-sm text-text-tertiary" style={mono}>
					{row.d}
				</span>
				<span className="text-ui-xs text-text-secondary uppercase" style={{ ...mono, letterSpacing: "0.12em" }}>
					{row.k}
				</span>
				<span
					className="text-ui-xl text-text-primary group-hover:underline"
					style={{ ...disp, fontWeight: 600, letterSpacing: "-0.015em", textUnderlineOffset: 4 }}
				>
					{row.t}
				</span>
			</span>
			<span aria-hidden="true" className="self-center text-right text-text-tertiary md:self-baseline">
				{row.href ? "→" : ""}
			</span>
		</>
	);
}

/** A list of ruled rows. A row with `href` is a link as a whole; one without is plain text. */
export function Rows({ rows }: { rows: Row[] }) {
	const cls =
		"group grid grid-cols-[minmax(0,1fr)_24px] items-baseline gap-3 py-4 no-underline md:grid-cols-[140px_150px_minmax(0,1fr)_24px] md:gap-4";
	return (
		<ul className="m-0 list-none p-0" style={{ borderTop: "1px solid var(--border)" }}>
			{rows.map((row) => (
				<li key={row.k} style={{ borderBottom: "1px solid var(--border-faint)" }}>
					{row.href ? (
						<Link href={row.href} className={cls}>
							<RowCells row={row} />
						</Link>
					) : (
						<div className={cls}>
							<RowCells row={row} />
						</div>
					)}
				</li>
			))}
		</ul>
	);
}

/**
 * A real `<table>` in a bordered box. Below `minWidth` it scrolls sideways inside the box, so the
 * page itself never gets wider than a phone.
 */
export function TableBox({ caption, columns, minWidth, children }: { caption: string; columns: string[]; minWidth: number; children: ReactNode }) {
	return (
		// `relative` is load-bearing: the sr-only caption is absolutely positioned, and without a
		// positioned ancestor it escapes this scroll box and widens the whole page on a phone.
		<div className="relative overflow-x-auto" style={{ border: "1px solid var(--border)" }}>
			<table className="w-full border-collapse text-left text-sm" style={{ minWidth }}>
				<caption className="sr-only">{caption}</caption>
				<thead>
					<tr>
						{columns.map((c) => (
							<th
								key={c}
								scope="col"
								className="text-ui-xs text-text-tertiary uppercase"
								style={{ ...mono, fontWeight: 400, letterSpacing: "0.14em", padding: "13px 16px", background: "var(--surface)", borderBottom: "1px solid var(--border-faint)" }}
							>
								{c}
							</th>
						))}
					</tr>
				</thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}

/** The shared cell padding and hairline of every body cell. */
const CELL: CSSProperties = { padding: "13px 16px", borderBottom: "1px solid var(--border-faint)", verticalAlign: "top" };

/** The row-header cell: the thing the row is about, in full ink. */
export function RowHead({ children }: { children: ReactNode }) {
	return (
		<th scope="row" className="font-medium whitespace-nowrap text-text-primary" style={CELL}>
			{children}
		</th>
	);
}

/** A body cell. `tone` picks the ink: `strong` for a yes, `quiet` for a no, secondary otherwise. */
export function Cell({ children, tone, isMono }: { children: ReactNode; tone?: "strong" | "quiet"; isMono?: boolean }) {
	const ink = tone === "strong" ? "text-text-primary" : tone === "quiet" ? "text-text-tertiary" : "text-text-secondary";
	return (
		<td className={ink} style={isMono ? { ...CELL, ...mono } : CELL}>
			{children}
		</td>
	);
}

/** A plain bordered card: an eyebrow, an optional title, its body, and an optional action. */
export function Card({ label, title, children, action }: { label: string; title?: string; children: ReactNode; action?: ReactNode }) {
	return (
		<div className="grid min-w-0 content-start gap-2.5" style={{ border: "1px solid var(--border)", background: "var(--surface)", padding: 22 }}>
			<span style={eyebrow}>{label}</span>
			{title && (
				<h3 className="text-display-xs" style={{ ...disp, fontWeight: 600, margin: 0, letterSpacing: "var(--tracking-display)", color: "var(--text-primary)" }}>
					{title}
				</h3>
			)}
			<div className="text-sm text-text-secondary" style={{ lineHeight: 1.6 }}>
				{children}
			</div>
			{action && <div className="justify-self-start">{action}</div>}
		</div>
	);
}

/** One numbered step. */
export interface Step {
	title: string;
	body: string;
}

/** Numbered steps in a row of three, divided by hairlines; stacked on a phone. */
export function Steps({ steps }: { steps: Step[] }) {
	return (
		<ol className="m-0 grid list-none grid-cols-1 p-0 md:grid-cols-3" style={{ borderTop: "1px solid var(--border)" }}>
			{steps.map((s, i) => (
				<li
					key={s.title}
					className={`grid content-start gap-2 pt-[22px] pb-[26px] md:pr-[22px] ${i > 0 ? "border-t border-border md:border-t-0 md:border-l md:pl-[22px]" : ""}`}
				>
					<span className="text-ui-xs text-text-tertiary" style={{ ...mono, letterSpacing: "0.14em" }}>
						{String(i + 1).padStart(2, "0")}
					</span>
					<h3 className="text-ui-xl" style={{ ...disp, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>
						{s.title}
					</h3>
					<p className="m-0 text-sm text-text-secondary" style={{ lineHeight: 1.55 }}>
						{s.body}
					</p>
				</li>
			))}
		</ol>
	);
}

/** The centred close: a two-line headline, then whatever actions follow it. */
export function Close({ lines, children }: { lines: [string, string]; children: ReactNode }) {
	return (
		<section className="py-[88px] max-[640px]:py-14" style={{ borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<div className="grid justify-items-center gap-[18px] text-center">
					<h2 className="text-display-md" style={{ ...disp, fontWeight: 600, margin: 0, lineHeight: 1.1, letterSpacing: "var(--tracking-display)", color: "var(--text-primary)" }}>
						{lines[0]}
						<br />
						{lines[1]}
					</h2>
					{children}
				</div>
			</Wrap>
		</section>
	);
}
