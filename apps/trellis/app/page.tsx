"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { createClient } from "@/lib/supabase/client";
import { User as IUser } from "@supabase/supabase-js";
import {
	Cloud,
	Database,
	GitBranch,
	Settings,
	Shield,
	Zap,
	User,
	LogOut,
	LayoutDashboard,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
	const [user, setUser] = useState<IUser | null>(null);
	const router = useRouter();

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
		setUser(null);
		router.refresh();
	};

	const getUserInitials = () => {
		if (!user?.email) return "U";
		return user.email.substring(0, 2).toUpperCase();
	};

	return (
		<div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
			{/* Header */}
			<header className="border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
				<div className="container mx-auto px-4 h-14 flex items-center justify-between">
					<div className="flex items-center space-x-3">
						<img
							src="/itgix-favicon-32x32.png"
							alt="ItGix Logo"
							className="w-6 h-6 grayscale"
						/>
						<span className="font-semibold text-sm tracking-tight">
							Trellis
						</span>
					</div>
					
					{user ? (
						<div className="flex items-center gap-4">
							<Link href="/dashboard/configurations">
								<Button variant="ghost" size="sm" className="text-sm">
									Configurations
								</Button>
							</Link>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										className="relative h-8 w-8 rounded-full"
									>
										<Avatar className="h-8 w-8">
											<AvatarImage
												src="/generic-user-avatar.png"
												alt="User"
											/>
											<AvatarFallback className="bg-muted text-muted-foreground text-xs">
												{getUserInitials()}
											</AvatarFallback>
										</Avatar>
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent className="w-56" align="end">
									<DropdownMenuLabel className="font-normal">
										<div className="flex flex-col space-y-1">
											<p className="text-sm font-medium leading-none">Account</p>
											<p className="text-xs text-muted-foreground leading-none">
												{user.email}
											</p>
										</div>
									</DropdownMenuLabel>
									<DropdownMenuSeparator />
									<DropdownMenuItem asChild>
										<Link href="/dashboard" className="cursor-pointer">
											<LayoutDashboard className="mr-2 h-4 w-4" />
											Dashboard
										</Link>
									</DropdownMenuItem>
									<DropdownMenuItem asChild>
										<Link href="/dashboard/profile" className="cursor-pointer">
											<User className="mr-2 h-4 w-4" />
											Profile
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
					) : (
						<div className="flex items-center gap-2">
							<Link href="/auth/signin">
								<Button
									variant="ghost"
									size="sm"
									className="text-sm"
								>
									Log in
								</Button>
							</Link>
							<Link href="/auth/signin">
								<Button
									size="sm"
									className="text-sm"
								>
									Sign Up
								</Button>
							</Link>
						</div>
					)}
				</div>
			</header>

			{/* Hero Section */}
			<section className="container mx-auto px-4 pt-32 pb-24 md:pt-48 md:pb-32">
				<div className="max-w-[64rem] mx-auto text-center flex flex-col items-center">
					<Badge variant="outline" className="mb-8 rounded-full px-3 py-1 text-xs tracking-tight bg-muted/50 border-border/50">
						Enterprise Application Development Platform
					</Badge>
					<h1 className="font-bold text-4xl sm:text-5xl md:text-6xl lg:text-7xl tracking-tighter text-foreground mb-6 leading-tight max-w-[54rem]">
						Deploy AWS Infrastructure <br className="hidden sm:inline" />
						<span className="text-muted-foreground">In Minutes.</span>
					</h1>
					<p className="text-muted-foreground text-lg sm:text-xl mb-10 max-w-[42rem] mx-auto leading-normal">
						Streamline your cloud deployment workflow with our
						intelligent configuration platform. Generate
						production-ready Terraform, Kubernetes, and ArgoCD
						configurations with enterprise-grade security.
					</p>
					<div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto justify-center">
						<Link href={user ? "/dashboard" : "/auth/signin"}>
							<Button
								size="lg"
								className="h-12 px-8 text-base w-full sm:w-auto"
							>
								{user ? "Go to Dashboard" : "Start Deploying"}
							</Button>
						</Link>
						<Link href="/installation">
							<Button
								variant="outline"
								size="lg"
								className="h-12 px-8 text-base w-full sm:w-auto"
							>
								Documentation
							</Button>
						</Link>
					</div>
				</div>
			</section>

			{/* Features Grid */}
			<section className="border-t border-border/40 bg-muted/20">
				<div className="container mx-auto px-4 py-24 md:py-32">
					<div className="text-center mb-16 max-w-[42rem] mx-auto">
						<h2 className="font-bold text-3xl md:text-4xl tracking-tighter text-foreground mb-4">
							Everything you need for deployment
						</h2>
						<p className="text-muted-foreground text-lg leading-normal">
							From infrastructure provisioning to application
							deployment, our platform handles the complexity so you
							can focus on building great products.
						</p>
					</div>

					<div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 max-w-[64rem] mx-auto">
						<Card className="bg-background shadow-sm border-border/50 transition-colors hover:border-border">
							<CardHeader>
								<Cloud className="h-5 w-5 mb-4 text-foreground" />
								<CardTitle className="text-lg">AWS Infrastructure</CardTitle>
								<CardDescription className="text-sm leading-relaxed">
									Automated VPC, EKS, RDS, and CloudFront
									configuration with best practices built-in.
								</CardDescription>
							</CardHeader>
						</Card>

						<Card className="bg-background shadow-sm border-border/50 transition-colors hover:border-border">
							<CardHeader>
								<GitBranch className="h-5 w-5 mb-4 text-foreground" />
								<CardTitle className="text-lg">GitOps Integration</CardTitle>
								<CardDescription className="text-sm leading-relaxed">
									Seamless ArgoCD setup with automated repository
									management and deployment pipelines.
								</CardDescription>
							</CardHeader>
						</Card>

						<Card className="bg-background shadow-sm border-border/50 transition-colors hover:border-border">
							<CardHeader>
								<Settings className="h-5 w-5 mb-4 text-foreground" />
								<CardTitle className="text-lg">Smart Configuration</CardTitle>
								<CardDescription className="text-sm leading-relaxed">
									Intelligent form-based configuration that
									generates production-ready Terraform code.
								</CardDescription>
							</CardHeader>
						</Card>

						<Card className="bg-background shadow-sm border-border/50 transition-colors hover:border-border">
							<CardHeader>
								<Shield className="h-5 w-5 mb-4 text-foreground" />
								<CardTitle className="text-lg">Enterprise Security</CardTitle>
								<CardDescription className="text-sm leading-relaxed">
									Built-in security best practices, IAM policies,
									and compliance-ready configurations.
								</CardDescription>
							</CardHeader>
						</Card>

						<Card className="bg-background shadow-sm border-border/50 transition-colors hover:border-border">
							<CardHeader>
								<Database className="h-5 w-5 mb-4 text-foreground" />
								<CardTitle className="text-lg">Database Management</CardTitle>
								<CardDescription className="text-sm leading-relaxed">
									Automated RDS setup with scaling, backups, and
									monitoring configurations.
								</CardDescription>
							</CardHeader>
						</Card>

						<Card className="bg-background shadow-sm border-border/50 transition-colors hover:border-border">
							<CardHeader>
								<Zap className="h-5 w-5 mb-4 text-foreground" />
								<CardTitle className="text-lg">Auto-Scaling</CardTitle>
								<CardDescription className="text-sm leading-relaxed">
									Karpenter integration for intelligent Kubernetes
									node scaling and cost optimization.
								</CardDescription>
							</CardHeader>
						</Card>
					</div>
				</div>
			</section>

			{/* CTA Section */}
			<section className="container mx-auto px-4 py-24 md:py-32">
				<div className="max-w-[42rem] mx-auto text-center">
					<h2 className="font-bold text-3xl md:text-4xl tracking-tighter text-foreground mb-4">
						Ready to transform your workflow?
					</h2>
					<p className="text-muted-foreground text-lg mb-8 leading-normal">
						Join enterprise teams who have reduced their
						infrastructure deployment time by 90% with our
						intelligent configuration platform.
					</p>
					<Link href="/auth/signin">
						<Button
							size="lg"
							className="h-12 px-8 text-base"
						>
							Start Building Now
						</Button>
					</Link>
				</div>
			</section>

			{/* Footer */}
			<footer className="border-t border-border/40 py-8">
				<div className="container mx-auto px-4 flex flex-col md:flex-row items-center justify-between gap-4">
					<div className="flex items-center space-x-3">
						<img
							src="/itgix-favicon-32x32.png"
							alt="ItGix Logo"
							className="w-5 h-5 grayscale opacity-70"
						/>
						<span className="font-medium text-sm text-muted-foreground tracking-tight">
							Trellis
						</span>
					</div>
					<p className="text-muted-foreground text-sm">
						© {new Date().getFullYear()} ItGix. All rights reserved.
					</p>
				</div>
			</footer>
		</div>
	);
}