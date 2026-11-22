// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Activity, ArrowUpRight, BookOpen, Newspaper } from "lucide-react";
import { SectionHeading } from "@repo/ui/section-heading";
import { statusUrl } from "@/lib/legal";

/** A chip in the "See what's new" band. */
interface WhatsNewLink {
	label: string;
	href: string;
	icon: typeof BookOpen;
	/** Off this origin. Rendering does not branch on it: every chip opens in a new tab (G-17). */
	external?: boolean;
}

/**
 * The band's chips. Every destination is a real, deployed surface — the docs app (`/docs`) and the news app
 * (`/news`, formerly `/blog`) served on this origin, and the status page this instance is CONFIGURED with
 * (`NEXT_PUBLIC_STATUS_URL`, through `statusUrl()` — the same source as the sign-in line and the sidebar
 * profile menu). The status chip used to hard-code status.alethialabs.io, which had no DNS record, and a
 * self-hosted console has no business linking it at all; with no status URL configured the chip is
 * omitted rather than pointed at a page that does not exist.
 */
export function whatsNewLinks(status: string | null): WhatsNewLink[] {
	const links: WhatsNewLink[] = [
		{ label: "News", href: "/news", icon: Newspaper },
		{ label: "Documentation", href: "/docs", icon: BookOpen },
	];
	if (status) links.push({ label: "Platform status", href: status, icon: Activity, external: true });
	return links;
}

/** The "See what's new" band on the support hub — a prompt to stay current + resource chips. */
export function SupportWhatsNew() {
	const links = whatsNewLinks(statusUrl());
	return (
		<section className="border-y bg-muted/20">
			<div className="space-y-6 py-12">
				<SectionHeading
					level={2}
					className="max-w-xl"
					title="See what's new"
					description="Stay up to date with the latest platform updates, releases, and announcements."
				/>
				<div className="flex flex-wrap gap-3">
					{/* Each is a site of its own (the news app, the docs app, the status page), so each
					    opens in a new tab and says so — the console stays where it was (G-17). `relative` keeps
					    the sr-only note inside its link, so it cannot make the document scroll (audit R3). */}
					{links.map(({ label, href, icon: Icon }) => (
						<a
							key={label}
							href={href}
							target="_blank"
							rel="noopener noreferrer"
							className="relative inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium transition-colors hover:border-foreground/20 hover:bg-muted"
						>
							<Icon className="size-[15px] text-muted-foreground" />
							{label}
							<ArrowUpRight aria-hidden className="size-3.5 text-muted-foreground" />
							<span className="sr-only">(opens in a new tab)</span>
						</a>
					))}
				</div>
			</div>
		</section>
	);
}
