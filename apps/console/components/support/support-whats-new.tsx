// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Activity, BookOpen, Newspaper } from "lucide-react";

/**
 * A chip in the "See what's new" band. Every destination is a real, deployed surface — the
 * docs app (`/docs`) and blog app (`/blog`) served on this origin, and the hosted status page
 * (the same links used by the sidebar profile menu) — so none of these dead-link.
 */
const LINKS: {
	label: string;
	href: string;
	icon: typeof BookOpen;
	external?: boolean;
}[] = [
	{ label: "Engineering blog", href: "/blog", icon: Newspaper },
	{ label: "Documentation", href: "/docs", icon: BookOpen },
	{
		label: "Platform status",
		href: "https://status.alethialabs.io",
		icon: Activity,
		external: true,
	},
];

/** The "See what's new" band on the support hub — a prompt to stay current + resource chips. */
export function SupportWhatsNew() {
	return (
		<section className="border-y bg-muted/20">
			<div className="space-y-6 py-12">
				<div className="max-w-xl space-y-3">
					<h2 className="text-2xl font-semibold tracking-tight">See what&apos;s new</h2>
					<p className="text-sm text-muted-foreground">
						Stay up to date with the latest platform updates, releases, and
						announcements.
					</p>
				</div>
				<div className="flex flex-wrap gap-3">
					{LINKS.map(({ label, href, icon: Icon, external }) => (
						<a
							key={label}
							href={href}
							{...(external
								? { target: "_blank", rel: "noopener noreferrer" }
								: {})}
							className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium transition-colors hover:border-foreground/20 hover:bg-muted"
						>
							<Icon className="size-[15px] text-muted-foreground" />
							{label}
						</a>
					))}
				</div>
			</div>
		</section>
	);
}
