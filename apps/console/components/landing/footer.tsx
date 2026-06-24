// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AlethiaLogo } from "@/components/alethia-logo";
import { ThemeToggle } from "./theme-toggle";

interface FooterLink {
	label: string;
	href: string;
	external?: boolean;
}

interface FooterColumn {
	title: string;
	links: FooterLink[];
}

const COLUMNS: FooterColumn[] = [
	{
		title: "Product",
		links: [
			{ label: "Features", href: "#features" },
			{ label: "CLI", href: "#cli" },
			{ label: "Pricing", href: "/pricing" },
			{ label: "Dashboard", href: "/dashboard" },
			{ label: "Ecosystem", href: "#ecosystem" },
		],
	},
	{
		title: "Developers",
		links: [
			{ label: "Documentation", href: "/docs" },
			{
				label: "GitHub",
				href: "https://github.com/alethialabs-io/alethialabs",
				external: true,
			},
			{ label: "CLI Reference", href: "/docs" },
		],
	},
	{
		title: "Resources",
		links: [
			{ label: "Architecture", href: "/docs" },
			{ label: "User Flows", href: "/docs" },
			{ label: "Spec Files", href: "/docs" },
		],
	},
	{
		title: "Community",
		links: [
			{
				label: "Open Source",
				href: "https://github.com/alethialabs-io/alethialabs",
				external: true,
			},
			{
				label: "LinkedIn",
				href: "https://www.linkedin.com/in/bborisov1/",
				external: true,
			},
			{
				label: "Contributing",
				href: "https://github.com/alethialabs-io/alethialabs",
				external: true,
			},
		],
	},
	{
		title: "Legal",
		links: [
			{ label: "Terms of Service", href: "/terms" },
			{ label: "Privacy Policy", href: "/privacy" },
			{ label: "Cookie Policy", href: "/cookies" },
			{ label: "Acceptable Use", href: "/acceptable-use" },
		],
	},
];

export function Footer() {
	return (
		<footer className="border-t border-border/40 mt-8">
			<div className="container mx-auto px-4 py-12 md:py-16">
				{/* Columns */}
				<div className="grid grid-cols-2 md:grid-cols-6 gap-8 mb-12">
					{/* Logo column */}
					<div className="col-span-2 md:col-span-1">
						<AlethiaLogo withText className="h-6 w-auto mb-4" />
						<p className="text-xs text-muted-foreground leading-relaxed max-w-[14rem]">
							Configure multi-cloud infrastructure in the browser.
							Deploy from the terminal.
						</p>
					</div>

					{/* Link columns */}
					{COLUMNS.map((col) => (
						<div key={col.title}>
							<h3 className="text-xs font-semibold text-foreground mb-3 uppercase tracking-wider">
								{col.title}
							</h3>
							<ul className="space-y-2">
								{col.links.map((link) => (
									<li key={link.label}>
										<a
											href={link.href}
											target={
												link.external
													? "_blank"
													: undefined
											}
											rel={
												link.external
													? "noopener noreferrer"
													: undefined
											}
											className="text-sm text-muted-foreground hover:text-foreground transition-colors"
										>
											{link.label}
										</a>
									</li>
								))}
							</ul>
						</div>
					))}
				</div>

				{/* Bottom bar */}
				<div className="border-t border-border/40 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
					<div className="flex items-center gap-3">
						<AlethiaLogo className="h-4 w-4" />
						<p className="text-xs text-muted-foreground">
							&copy; 2026 Alethia
						</p>
					</div>
					<div className="flex items-center gap-4">
						<ThemeToggle />
						<p className="text-xs text-muted-foreground">
							Made by{" "}
							<a
								href="https://borislav.tovr.eu"
								target="_blank"
								rel="noopener noreferrer"
								className="text-foreground hover:underline"
							>
								Borislav Borisov
							</a>
							{" · "}
							<span>Open Source</span>
						</p>
					</div>
				</div>
			</div>
		</footer>
	);
}
