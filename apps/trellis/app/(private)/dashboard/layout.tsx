"use client";

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
import { useJobsStore } from "@/lib/stores/use-jobs-store";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { PublicProvisionJobsRow } from "@/lib/validations/db.schemas";
import { User as IUser } from "@supabase/supabase-js";
import { SidebarVineyards } from "@/components/sidebar-vineyards";
import { HeaderBreadcrumbs } from "@/components/header-breadcrumbs";
import {
	Bell,
	Blocks,
	ClipboardList,
	LayoutDashboard,
	LogOut,
	Menu,
	Plus,
	Server,
	Settings,
	User,
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
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [user, setUser] = useState<IUser | null>(null);
	const { notifications, unreadCount, markAsRead, markAllRead } = useJobNotifications();

	useEffect(() => {
		const supabase = createClient();
		let channel: ReturnType<typeof supabase.channel> | null = null;

		supabase.auth.getUser().then(({ data: { user: u } }) => {
			if (!u) return;
			setUser(u);
			useJobsStore.getState().fetchJobs(true);

			channel = supabase
				.channel("jobs-realtime-global")
				.on(
					"postgres_changes",
					{ event: "*", schema: "public", table: "provision_jobs" },
					(payload) => {
						const job = payload.new as PublicProvisionJobsRow;
						if (job && job.user_id === u.id) {
							useJobsStore.getState().addOrUpdateJob(job);
						}
					},
				)
				.subscribe();
		});

		return () => {
			if (channel) supabase.removeChannel(channel);
		};
	}, []);

	const handleLogout = async () => {
		const supabase = createClient();
		await supabase.auth.signOut();
		router.push("/");
	};

	const navigation = [
		{ name: "Overview", href: "/dashboard", icon: LayoutDashboard },
		{ name: "Plant a Vine", href: "/dashboard/plant", icon: Plus },
		{ name: "Clusters", href: "/dashboard/clusters", icon: Server },
		{ name: "Jobs", href: "/dashboard/jobs", icon: ClipboardList },
		{ name: "Integrations", href: "/dashboard/integrations", icon: Blocks },
		{ name: "Tendrils", href: "/dashboard/tendrils", icon: Workflow },
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
						<HeaderBreadcrumbs />
					</div>

					<div className="flex items-center gap-2 sm:gap-4">
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
												<div className={`p-1 rounded-md shrink-0 ${n.status === "FAILED" ? "bg-destructive/10" : n.status === "SUCCESS" ? "bg-emerald-500/10" : "bg-blue-500/10"}`}>
													<ClipboardList className={`h-3.5 w-3.5 ${n.status === "FAILED" ? "text-destructive" : n.status === "SUCCESS" ? "text-emerald-500" : "text-blue-500"}`} />
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
														n.status === "FAILED" ? "bg-destructive" : n.status === "SUCCESS" ? "bg-emerald-500" : "bg-blue-500",
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
							<DropdownMenuContent className="w-56" align="end">
								<DropdownMenuLabel className="font-normal px-2 py-1.5">
									<div className="flex flex-col space-y-1">
										<p className="text-sm font-medium leading-none">
											Account
										</p>
										<p className="text-xs text-muted-foreground leading-none">
											{user?.email || "Loading..."}
										</p>
									</div>
								</DropdownMenuLabel>
								<DropdownMenuSeparator />
								<DropdownMenuItem asChild>
									<Link
										href="/dashboard/profile"
										className="cursor-pointer"
									>
										<User className="mr-2 h-4 w-4 text-muted-foreground" />
										Profile Settings
									</Link>
								</DropdownMenuItem>
								<DropdownMenuItem asChild>
									<Link
										href="/dashboard/plant"
										className="cursor-pointer"
									>
										<Settings className="mr-2 h-4 w-4 text-muted-foreground" />
										Plant a Vine
									</Link>
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									onClick={handleLogout}
									className="cursor-pointer text-destructive focus:text-destructive"
								>
									<LogOut className="mr-2 h-4 w-4" />
									Sign out
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
							<SidebarVineyards />
						</Suspense>
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
										{user?.user_metadata?.full_name ||
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
									<SidebarVineyards />
								</Suspense>
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
