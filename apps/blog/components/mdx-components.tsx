// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Info } from "lucide-react";
import type { ReactNode } from "react";

// Branded replacements for the components used in posts (Callout, Steps, Cards),
// plus styled anchors. Standard elements (h2, p, table, code…) are styled by the
// `.prose` rules in global.css.

function Callout({ children, type = "info" }: { children: ReactNode; type?: string }) {
	return (
		<div className="my-6 flex gap-3 border border-border bg-muted px-4 py-3 text-sm">
			<Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
			<div className="[&>p]:m-0">{children}</div>
			<span className="sr-only">{type}</span>
		</div>
	);
}

function Steps({ children }: { children: ReactNode }) {
	return <div className="my-6 border-l border-border pl-6 [counter-reset:step] space-y-5">{children}</div>;
}

function Step({ children }: { children: ReactNode }) {
	return (
		<div className="relative [counter-increment:step]">
			<span className="absolute -left-[2.1rem] top-0 flex h-6 w-6 items-center justify-center border border-border bg-background text-xs font-mono text-muted-foreground before:content-[counter(step)]" />
			<div className="[&>p:first-child]:mt-0">{children}</div>
		</div>
	);
}

function Cards({ children }: { children: ReactNode }) {
	return <div className="my-6 grid gap-3 sm:grid-cols-2">{children}</div>;
}

function Card({ title, href, children }: { title: string; href?: string; children?: ReactNode }) {
	const inner = (
		<div className="h-full border border-border bg-card p-4 transition-colors hover:border-border-strong">
			<div className="font-semibold">{title}</div>
			{children ? <div className="mt-1 text-sm text-muted-foreground">{children}</div> : null}
		</div>
	);
	return href ? (
		<a href={href} className="no-underline">
			{inner}
		</a>
	) : (
		inner
	);
}

export const mdxComponents = {
	Callout,
	Steps,
	Step,
	Cards,
	Card,
};
