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
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useAwsOnboarding } from "@/hooks/use-aws-onboarding";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { User as IUser } from "@supabase/supabase-js";
import { SidebarVineyards } from "@/components/sidebar-vineyards";
import {
	AlertTriangle,
	ArrowRight,
	Bell,
	Cloud,
	Folder,
	GitBranch,
	History,
	LayoutDashboard,
	LogOut,
	Menu,
	Plus,
	Search,
	Server,
	Settings,
	User,
	Workflow,
	X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
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
	const { showAwsAlert, setShowAwsAlert } = useAwsOnboarding();

	useEffect(() => {
		const getUser = async () => {
			const supabase = createClient();
			const {
				data: { user },
			} = await supabase.auth.getUser();
			setUser(user);
		};
		getUser();
	}, []);

	const handleLogout = async () => {
		const supabase = createClient();
		await supabase.auth.signOut();
		router.push("/");
	};

	const navigation = [
		{ name: "Overview", href: "/dashboard", icon: LayoutDashboard },
		{ name: "Plant a Vine", href: "/dashboard/configure", icon: Plus },
		{ name: "Vines", href: "/dashboard/vines", icon: Folder },
		{ name: "Clusters", href: "/dashboard/clusters", icon: Server },
		{ name: "History", href: "/dashboard/history", icon: History },
		{ name: "Providers", href: "/dashboard/providers", icon: Cloud },
		{ name: "Workers", href: "/dashboard/workers", icon: Workflow },
		{ name: "Git", href: "/dashboard/git", icon: GitBranch },
	];

	const getUserInitials = () => {
		if (!user?.email) return "U";
		return user.email.substring(0, 2).toUpperCase();
	};

	return (
		<div className="flex h-full w-full flex-col bg-background overflow-hidden">
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
						<Link
							href="/dashboard"
							className="flex items-center gap-3 transition-opacity hover:opacity-80"
						>
							<img
								src="/itgix-favicon-32x32.png"
								alt="ItGix Logo"
								className="w-6 h-6 grayscale"
							/>
							<h2 className="font-semibold text-sm tracking-tight text-foreground">
								Trellis
							</h2>
						</Link>
					</div>

					<div className="flex items-center gap-2 sm:gap-4">
						{/* Search Bar - Hidden on small screens */}
						<div className="hidden md:flex items-center">
							<div className="relative">
								<Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
								<Input
									placeholder="Search..."
									className="w-64 bg-muted/30 border-border/50 pl-9 h-9 text-sm focus-visible:ring-1 focus-visible:ring-ring transition-colors"
								/>
							</div>
						</div>

						{/* Notifications */}
						<Popover>
							<PopoverTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="relative h-9 w-9 text-muted-foreground hover:text-foreground"
								>
									<Bell className="h-4 w-4" />
									{showAwsAlert && (
										<span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-destructive" />
									)}
									<span className="sr-only">
										Toggle notifications
									</span>
								</Button>
							</PopoverTrigger>
							<PopoverContent className="w-80 p-0" align="end">
								<div className="flex flex-col gap-1 border-b border-border/40 p-4">
									<p className="text-sm font-semibold text-foreground">
										Notifications
									</p>
									<p className="text-xs text-muted-foreground">
										{showAwsAlert
											? "You have 1 unread message."
											: "You have no new messages."}
									</p>
								</div>
								<div className="max-h-[300px] overflow-y-auto">
									{showAwsAlert ? (
										<div className="p-4 flex gap-4 hover:bg-muted/50 transition-colors">
											<div className="mt-0.5 p-1.5 bg-destructive/10 rounded-md shrink-0 h-fit">
												<AlertTriangle className="h-4 w-4 text-destructive" />
											</div>
											<div className="flex-1 space-y-1">
												<p className="text-sm font-medium leading-none text-destructive">
													AWS Account Disconnected
												</p>
												<p className="text-xs text-muted-foreground leading-relaxed mt-1.5 mb-2">
													You haven't connected your AWS account yet. You can still create configurations, but you won't be able to provision any infrastructure until you connect.
												</p>
												<div className="pt-1">
													<Link href="/dashboard/providers">
														<Button
															variant="outline"
															size="sm"
															className="border-destructive/30 hover:bg-destructive/10 text-destructive text-xs h-7 px-3 w-full"
														>
															Connect AWS Account
															<ArrowRight className="ml-1.5 h-3 w-3" />
														</Button>
													</Link>
												</div>
											</div>
										</div>
									) : (
										<div className="p-8 text-center text-sm text-muted-foreground">
											You're all caught up!
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
										href="/dashboard/configure"
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
							const isActive = pathname === item.href;
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
									const isActive = pathname === item.href;
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
				<main className="flex-1 overflow-y-auto bg-background p-4 sm:p-6 lg:p-8 xl:p-10">
					<Suspense
						fallback={
							<div className="flex items-center justify-center h-full min-h-[50vh]">
								<div className="w-6 h-6 border-2 border-foreground border-t-transparent rounded-full animate-spin"></div>
							</div>
						}
					>
						{children}
					</Suspense>
				</main>
			</div>
		</div>
	);
}
