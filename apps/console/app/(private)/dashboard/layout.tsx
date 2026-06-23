"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useJobNotifications } from "@/hooks/use-job-notifications";
import { authClient } from "@/lib/auth/client";
import { useJobsStore } from "@/lib/stores/use-jobs-store";
import { cn } from "@/lib/utils";
import { SidebarZones } from "@/components/sidebar-zones";
import { HeaderBreadcrumbs } from "@/components/header-breadcrumbs";
import { OrgSwitcher } from "@/components/org-switcher";
import { ZoneSwitcher } from "@/components/zone-switcher";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { AlethiaLogo } from "@/components/alethia-logo";
import { DownloadCliButton } from "@/components/download-cli-button";
import { ThemeMenu } from "@/components/theme-menu";
import {
	Bell,
	BookOpen,
	Blocks,
	ClipboardList,
	LayoutDashboard,
	LifeBuoy,
	LogOut,
	Menu,
	Plus,
	Server,
	Settings,
	Sparkles,
	Workflow,
	X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ScrollArea } from "@/components/ui/scroll-area";
import type React from "react";
import { Suspense, useEffect, useState } from "react";

export default function DashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const pathname = usePathname();
	const router = useRouter();
	// Settings is a Vercel-style section: under it, the sidebar swaps its nav for the
	// settings section nav (with a "← Dashboard" back link) instead of the global nav.
	const inSettings = pathname.startsWith("/dashboard/settings");
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const { data: session } = authClient.useSession();
	const user = session?.user ?? null;
	const { notifications, unreadCount, markAsRead, markAllRead } = useJobNotifications();

	// Initial jobs load once a session is present. Live updates come from the
	// jobs store + useJobNotifications polling (an SSE stream will replace the poll).
	useEffect(() => {
		if (user) useJobsStore.getState().fetchJobs(true);
	}, [user]);

	const handleLogout = async () => {
		await authClient.signOut();
		router.push("/");
	};

	const navigation = [
		{ name: "Agent", href: "/dashboard/agent", icon: Sparkles },
		{ name: "Overview", href: "/dashboard", icon: LayoutDashboard },
		{ name: "Create a Spec", href: "/dashboard/design-spec", icon: Plus },
		{ name: "Clusters", href: "/dashboard/clusters", icon: Server },
		{ name: "Jobs", href: "/dashboard/jobs", icon: ClipboardList },
		{ name: "Connectors", href: "/dashboard/connectors", icon: Blocks },
		{ name: "Alerts", href: "/dashboard/alerts", icon: Bell },
		{ name: "Runners", href: "/dashboard/runners", icon: Workflow },
		{ name: "Settings", href: "/dashboard/settings", icon: Settings },
	];

	const getUserInitials = () => {
		if (!user?.email) return "U";
		return user.email.substring(0, 2).toUpperCase();
	};

	return (
		<div className="flex h-dvh w-full flex-col bg-background overflow-hidden">
			{/* Top Header - Edge to Edge */}
			<header className="sticky top-0 z-40 flex h-14 shrink-0 items-center border-b border-border/40 bg-background/95 backdrop-blur px-4 sm:px-6 lg:px-8">
				<div className="flex w-full items-center justify-between">
					<div className="flex items-center gap-4">
						<Button
							variant="ghost"
							size="icon"
							className="lg:hidden shrink-0"
							onClick={() => setSidebarOpen(!sidebarOpen)}
						>
							{sidebarOpen ? (
								<X className="h-5 w-5" />
							) : (
								<Menu className="h-5 w-5" />
							)}
						</Button>
						{/* Mark → org switcher → breadcrumb trail. */}
						<Link
							href="/dashboard"
							aria-label="Alethia home"
							className="shrink-0 text-foreground"
						>
							<AlethiaLogo className="h-7 w-7" />
						</Link>
						<span className="text-border/70 select-none" aria-hidden>
							/
						</span>
						<OrgSwitcher />
						<ZoneSwitcher />
						<HeaderBreadcrumbs />
					</div>

					<div className="flex items-center gap-2 sm:gap-4">
						{/* Download the alethia CLI */}
						<DownloadCliButton />

						{/* Notifications */}
						<Popover>
							<PopoverTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="relative h-9 w-9 text-muted-foreground hover:text-foreground"
								>
									<Bell className="h-4 w-4" />
									{unreadCount > 0 && (
										<span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-destructive" />
									)}
									<span className="sr-only">Notifications</span>
								</Button>
							</PopoverTrigger>
							<PopoverContent className="w-80 p-0" align="end">
								<div className="flex items-center justify-between border-b border-border/40 px-4 py-3">
									<div>
										<p className="text-sm font-semibold text-foreground">Notifications</p>
										<p className="text-[11px] text-muted-foreground">
											{unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
										</p>
									</div>
									{unreadCount > 0 && (
										<button
											onClick={markAllRead}
											className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
										>
											Mark all read
										</button>
									)}
								</div>
								<div className="max-h-[320px] overflow-y-auto">
									{notifications.map((n) => (
										<Link
											key={n.id}
											href={`/dashboard/jobs/${n.jobId}`}
											onClick={() => markAsRead(n.id)}
										>
											<div className={`px-4 py-2.5 flex items-center gap-3 hover:bg-muted/50 transition-colors border-b border-border/20 ${!n.read ? "bg-muted/20" : ""}`}>
												<div className={`p-1 rounded-md shrink-0 ${n.status === "FAILED" ? "bg-destructive/10" : "bg-muted"}`}>
													<ClipboardList className={`h-3.5 w-3.5 ${n.status === "FAILED" ? "text-destructive" : n.status === "SUCCESS" ? "text-foreground" : "text-muted-foreground"}`} />
												</div>
												<div className="flex-1 min-w-0">
													<p className="text-xs font-medium text-foreground">
														{n.jobType.replace("_", " ")} — {n.status.toLowerCase()}
													</p>
													<p className="text-[11px] text-muted-foreground mt-0.5">
														{new Date(n.createdAt).toLocaleTimeString()}
													</p>
												</div>
												{!n.read && (
													<span className={cn(
														"h-2 w-2 rounded-full shrink-0",
														n.status === "FAILED" ? "bg-destructive" : n.status === "SUCCESS" ? "bg-foreground" : "bg-muted-foreground",
													)} />
												)}
											</div>
										</Link>
									))}
									{notifications.length === 0 && (
										<div className="p-8 text-center text-sm text-muted-foreground">
											You&apos;re all caught up!
										</div>
									)}
								</div>
							</PopoverContent>
						</Popover>

						{/* User Menu */}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									className="relative h-8 w-8 rounded-full ml-1 p-0 border border-border/50"
								>
									<Avatar className="h-8 w-8">
										<AvatarImage
											src="/generic-user-avatar.png"
											alt="User"
										/>
										<AvatarFallback className="bg-muted text-muted-foreground text-xs font-medium">
											{getUserInitials()}
										</AvatarFallback>
									</Avatar>
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent className="w-64" align="end">
								<DropdownMenuLabel className="font-normal px-2 py-2">
									<div className="flex items-center gap-2.5">
										<Avatar className="h-9 w-9 border border-border/50">
											<AvatarImage
												src="/generic-user-avatar.png"
												alt="User"
											/>
											<AvatarFallback className="bg-muted text-muted-foreground text-xs font-medium">
												{getUserInitials()}
											</AvatarFallback>
										</Avatar>
										<div className="flex min-w-0 flex-col">
											<p className="truncate text-sm font-medium leading-tight text-foreground">
												{user?.name || "User"}
											</p>
											<p className="truncate text-xs text-muted-foreground leading-tight">
												{user?.email || "Loading..."}
											</p>
										</div>
									</div>
								</DropdownMenuLabel>
								<DropdownMenuSeparator />
								<DropdownMenuItem asChild>
									<Link
										href="/dashboard/profile"
										className="cursor-pointer"
									>
										<Settings className="h-4 w-4 text-muted-foreground" />
										Account settings
									</Link>
								</DropdownMenuItem>
								{/* Theme — hover submenu (System / Light / Dark) */}
								<ThemeMenu />
								<DropdownMenuSeparator />
								<DropdownMenuItem asChild>
									<Link href="/docs" className="cursor-pointer">
										<BookOpen className="h-4 w-4 text-muted-foreground" />
										Docs
									</Link>
								</DropdownMenuItem>
								<DropdownMenuItem asChild>
									<a
										href="mailto:support@alethialabs.io"
										className="cursor-pointer"
									>
										<LifeBuoy className="h-4 w-4 text-muted-foreground" />
										Help
									</a>
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									onClick={handleLogout}
									className="cursor-pointer text-destructive focus:text-destructive"
								>
									<LogOut className="h-4 w-4" />
									Logout
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			</header>

			{/* Main Body - Flex Row */}
			<div className="flex flex-1 overflow-hidden">
				{/* Desktop Sidebar - Fixed Width */}
				<aside className="hidden lg:flex w-64 xl:w-72 shrink-0 flex-col overflow-y-auto border-r border-border/40 bg-background/50">
					<nav className="flex-1 space-y-1 p-4 lg:p-6 overflow-y-auto">
						{inSettings ? (
							<SettingsSidebar />
						) : (
							<>
								{navigation.map((item) => {
									const isActive = item.href === "/dashboard"
										? pathname === "/dashboard"
										: pathname.startsWith(item.href);
									return (
										<Link key={item.name} href={item.href}>
											<Button
												variant={
													isActive ? "secondary" : "ghost"
												}
												className={cn(
													"w-full justify-start gap-3 h-9 px-3 text-sm font-medium transition-colors",
													isActive
														? "bg-muted/80 text-foreground"
														: "text-muted-foreground hover:text-foreground hover:bg-muted/40",
												)}
											>
												<item.icon
													className={cn(
														"h-4 w-4",
														isActive
															? "text-foreground"
															: "text-muted-foreground",
													)}
												/>
												<span>{item.name}</span>
											</Button>
										</Link>
									);
								})}

								<Suspense fallback={null}>
									<SidebarZones />
								</Suspense>
							</>
						)}
					</nav>

					<div className="p-4 lg:p-6 mt-auto">
						<Link href="/dashboard/profile">
							<div className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted/50 transition-colors cursor-pointer group border border-transparent hover:border-border/50">
								<Avatar className="h-8 w-8 border border-border/50">
									<AvatarImage
										src="/generic-user-avatar.png"
										alt="User"
									/>
									<AvatarFallback className="bg-muted text-xs text-muted-foreground font-medium">
										{getUserInitials()}
									</AvatarFallback>
								</Avatar>
								<div className="flex-1 min-w-0">
									<p className="text-sm font-medium text-foreground truncate">
										{user?.name ||
											"User"}
									</p>
									<p className="text-xs text-muted-foreground truncate">
										{user?.email}
									</p>
								</div>
							</div>
						</Link>
					</div>
				</aside>

				{/* Mobile Sidebar Overlay */}
				{sidebarOpen && (
					<div
						className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm lg:hidden"
						onClick={() => setSidebarOpen(false)}
					>
						<aside
							className="fixed inset-y-0 left-0 z-50 w-72 bg-background border-r border-border/40 shadow-lg transition-transform duration-300 ease-in-out transform flex flex-col"
							onClick={(e) => e.stopPropagation()}
						>
							<div className="flex items-center justify-between px-4 h-14 border-b border-border/40">
								<span className="font-semibold text-sm tracking-tight text-foreground">
									Navigation
								</span>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => setSidebarOpen(false)}
								>
									<X className="h-5 w-5 text-muted-foreground" />
								</Button>
							</div>
							<nav className="flex-1 overflow-y-auto p-4 space-y-1">
								{inSettings ? (
									<div onClick={() => setSidebarOpen(false)}>
										<SettingsSidebar />
									</div>
								) : (
									<>
										{navigation.map((item) => {
											const isActive = item.href === "/dashboard"
										? pathname === "/dashboard"
										: pathname.startsWith(item.href);
											return (
												<Link
													key={item.name}
													href={item.href}
													onClick={() =>
														setSidebarOpen(false)
													}
												>
													<Button
														variant={
															isActive
																? "secondary"
																: "ghost"
														}
														className={cn(
															"w-full justify-start gap-3 h-10 px-3 text-sm font-medium",
															isActive
																? "bg-muted text-foreground"
																: "text-muted-foreground hover:text-foreground",
														)}
													>
														<item.icon
															className={cn(
																"h-4 w-4",
																isActive
																	? "text-foreground"
																	: "text-muted-foreground",
															)}
														/>
														<span>{item.name}</span>
													</Button>
												</Link>
											);
										})}

										<Suspense fallback={null}>
											<SidebarZones />
										</Suspense>
									</>
								)}
							</nav>
						</aside>
					</div>
				)}

				{/* Main Content Area - Expands to fill remaining space */}
				<main className="flex-1 bg-background">
					<ScrollArea className="h-[calc(100dvh-3.5rem)]">
						<div className="p-4 sm:p-6 lg:p-8 xl:p-10">
							<Suspense
								fallback={
									<div className="flex items-center justify-center min-h-[50vh]">
										<div className="w-6 h-6 border-2 border-foreground border-t-transparent rounded-full animate-spin"></div>
									</div>
								}
							>
								{children}
							</Suspense>
						</div>
					</ScrollArea>
				</main>
			</div>
		</div>
	);
}
