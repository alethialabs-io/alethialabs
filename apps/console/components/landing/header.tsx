"use client";
// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { ProviderIcon } from "@/components/provider-icon";
import { AlethiaLogo } from "@/components/alethia-logo";
import { ThemeToggle } from "./theme-toggle";
import { ExternalLink, Menu } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

interface NavLink {
	label: string;
	href: string;
	external?: boolean;
}

const NAV_LINKS: NavLink[] = [
	{ label: "Features", href: "#features" },
	{ label: "CLI", href: "#cli" },
	{ label: "Ecosystem", href: "#ecosystem" },
	{ label: "Docs", href: "/docs" },
];

export function Header() {
	const [scrolled, setScrolled] = useState(false);
	const [open, setOpen] = useState(false);

	useEffect(() => {
		const onScroll = () => setScrolled(window.scrollY > 20);
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);

	return (
		<header
			className={`fixed top-0 left-0 right-0 z-50 transition-colors duration-200 ${
				scrolled
					? "bg-background/80 backdrop-blur-lg border-b border-border/40"
					: "bg-transparent"
			}`}
		>
			<div className="container mx-auto px-4 h-14 flex items-center justify-between">
				{/* Left: logo */}
				<Link href="/" className="flex items-center gap-2 shrink-0">
					<AlethiaLogo withText className="h-6 w-auto" />
				</Link>

				{/* Center: nav (desktop) */}
				<nav className="hidden md:flex items-center gap-1">
					{NAV_LINKS.map((link) => (
						<a
							key={link.label}
							href={link.href}
							target={link.external ? "_blank" : undefined}
							rel={link.external ? "noopener noreferrer" : undefined}
							className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md"
						>
							{link.label}
						</a>
					))}
				</nav>

				{/* Right: github + theme + CTA (desktop) */}
				<div className="hidden md:flex items-center gap-3">
					<a
						href="https://github.com/alethialabs-io/alethialabs"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
					>
						<ProviderIcon provider="github" size={16} className="dark:invert" />
						GitHub
					</a>
					<ThemeToggle />
					<Link href="/auth/signin">
						<Button size="sm" className="text-sm h-8">
							Get Started
						</Button>
					</Link>
				</div>

				{/* Mobile hamburger */}
				<div className="md:hidden flex items-center gap-2">
					<ThemeToggle />
					<Sheet open={open} onOpenChange={setOpen}>
						<SheetTrigger asChild>
							<Button variant="ghost" size="sm" className="h-8 w-8 p-0">
								<Menu className="h-4 w-4" />
							</Button>
						</SheetTrigger>
						<SheetContent side="right" className="w-64">
							<nav className="flex flex-col gap-2 mt-8">
								{NAV_LINKS.map((link) => (
									<a
										key={link.label}
										href={link.href}
										onClick={() => setOpen(false)}
										className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md"
									>
										{link.label}
									</a>
								))}
								<div className="border-t border-border/40 mt-2 pt-4">
									<Link
										href="/auth/signin"
										onClick={() => setOpen(false)}
									>
										<Button size="sm" className="w-full">
											Get Started
										</Button>
									</Link>
								</div>
							</nav>
						</SheetContent>
					</Sheet>
				</div>
			</div>
		</header>
	);
}
