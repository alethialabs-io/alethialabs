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
	ArrowRight,
	Check,
	Cloud,
	Copy,
	GitBranch,
	LayoutDashboard,
	LogOut,
	Lock,
	Terminal,
	User,
	Workflow,
	Zap,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(() => {
		navigator.clipboard.writeText(text);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}, [text]);

	return (
		<button
			onClick={handleCopy}
			className="text-muted-foreground hover:text-foreground transition-colors"
			aria-label="Copy to clipboard"
		>
			{copied ? (
				<Check className="h-4 w-4 text-green-500" />
			) : (
				<Copy className="h-4 w-4" />
			)}
		</button>
	);
}

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
							<Link href="/dashboard/vines">
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
								<Button variant="ghost" size="sm" className="text-sm">
									Log in
								</Button>
							</Link>
							<Link href="/auth/signin">
								<Button size="sm" className="text-sm">
									Sign Up
								</Button>
							</Link>
						</div>
					)}
				</div>
			</header>

			{/* Hero */}
			<section className="container mx-auto px-4 pt-28 pb-20 md:pt-40 md:pb-28">
				<div className="max-w-[64rem] mx-auto text-center flex flex-col items-center">
					<Badge
						variant="outline"
						className="mb-8 rounded-full px-3 py-1 text-xs tracking-tight bg-muted/50 border-border/50"
					>
						Open Source Infrastructure Platform
					</Badge>
					<h1 className="font-bold text-4xl sm:text-5xl md:text-6xl lg:text-7xl tracking-tighter text-foreground mb-6 leading-[1.1] max-w-[54rem]">
						Configure in the browser.
						<br />
						<span className="text-muted-foreground">
							Deploy from the terminal.
						</span>
					</h1>
					<p className="text-muted-foreground text-lg sm:text-xl mb-10 max-w-[40rem] mx-auto leading-relaxed">
						Trellis is a web control plane for AWS infrastructure.
						Design your stack visually, then provision it with the
						Grape CLI — Terraform, EKS, and ArgoCD, handled for you.
					</p>
					<div className="flex flex-col sm:flex-row gap-3 w-full sm:w-auto justify-center mb-12">
						<Link href={user ? "/dashboard" : "/auth/signin"}>
							<Button
								size="lg"
								className="h-12 px-8 text-base w-full sm:w-auto"
							>
								{user ? "Go to Dashboard" : "Get Started"}
								<ArrowRight className="ml-2 h-4 w-4" />
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

					{/* Terminal snippet */}
					<div className="w-full max-w-[32rem] rounded-lg border border-border/60 bg-neutral-950 text-left overflow-hidden shadow-xl">
						<div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-white/10">
							<div className="h-2.5 w-2.5 rounded-full bg-white/20" />
							<div className="h-2.5 w-2.5 rounded-full bg-white/20" />
							<div className="h-2.5 w-2.5 rounded-full bg-white/20" />
							<span className="ml-2 text-xs text-white/40 font-mono">
								terminal
							</span>
						</div>
						<div className="p-4 font-mono text-sm space-y-2">
							<div className="flex items-center justify-between gap-4">
								<p>
									<span className="text-white/40">$ </span>
									<span className="text-white/90">brew install grape</span>
								</p>
								<CopyButton text="brew install grape" />
							</div>
							<div className="flex items-center justify-between gap-4">
								<p>
									<span className="text-white/40">$ </span>
									<span className="text-white/90">grape login</span>
								</p>
								<CopyButton text="grape login" />
							</div>
							<div className="flex items-center justify-between gap-4">
								<p>
									<span className="text-white/40">$ </span>
									<span className="text-white/90">grape bootstrap</span>
								</p>
								<CopyButton text="grape bootstrap" />
							</div>
							<p className="text-green-400/80 pt-1">
								&#10003; EKS cluster provisioned. ArgoCD installed. Ready
								to deploy.
							</p>
						</div>
					</div>
				</div>
			</section>

			{/* How it works */}
			<section className="border-t border-border/40 bg-muted/20">
				<div className="container mx-auto px-4 py-24 md:py-32">
					<div className="text-center mb-16 max-w-[42rem] mx-auto">
						<h2 className="font-bold text-3xl md:text-4xl tracking-tighter text-foreground mb-4">
							Three steps. Zero drift.
						</h2>
						<p className="text-muted-foreground text-lg leading-relaxed">
							Trellis and Grape work together — one configures, the
							other executes. Git is the source of truth.
						</p>
					</div>

					<div className="grid md:grid-cols-3 gap-8 max-w-[60rem] mx-auto">
						<div className="relative flex flex-col items-start">
							<span className="text-5xl font-bold text-muted-foreground/20 mb-4 tracking-tighter">
								01
							</span>
							<h3 className="text-lg font-semibold text-foreground mb-2">
								Design in Trellis
							</h3>
							<p className="text-muted-foreground text-sm leading-relaxed">
								Pick your AWS region, choose your infrastructure
								modules — VPC, EKS, RDS, CloudFront, WAF — and
								configure everything through a guided wizard. No
								HCL required.
							</p>
						</div>

						<div className="relative flex flex-col items-start">
							<span className="text-5xl font-bold text-muted-foreground/20 mb-4 tracking-tighter">
								02
							</span>
							<h3 className="text-lg font-semibold text-foreground mb-2">
								Bootstrap with Grape
							</h3>
							<p className="text-muted-foreground text-sm leading-relaxed">
								One command provisions your EKS cluster, installs
								ArgoCD, and wires up GitOps. Infrastructure stays
								in your AWS account — Trellis never touches your
								credentials.
							</p>
						</div>

						<div className="relative flex flex-col items-start">
							<span className="text-5xl font-bold text-muted-foreground/20 mb-4 tracking-tighter">
								03
							</span>
							<h3 className="text-lg font-semibold text-foreground mb-2">
								Ship with GitOps
							</h3>
							<p className="text-muted-foreground text-sm leading-relaxed">
								ArgoCD watches your infrastructure repo and
								reconciles changes automatically. Push a config
								change, and your cluster converges — no manual
								applies, no drift.
							</p>
						</div>
					</div>
				</div>
			</section>

			{/* Features */}
			<section className="border-t border-border/40">
				<div className="container mx-auto px-4 py-24 md:py-32">
					<div className="text-center mb-16 max-w-[42rem] mx-auto">
						<h2 className="font-bold text-3xl md:text-4xl tracking-tighter text-foreground mb-4">
							Built for real infrastructure
						</h2>
						<p className="text-muted-foreground text-lg leading-relaxed">
							Not another YAML abstraction. Trellis generates
							production Terraform and Helm — you own every line.
						</p>
					</div>

					<div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 max-w-[64rem] mx-auto">
						<Card className="bg-background shadow-sm border-border/50 transition-colors hover:border-border">
							<CardHeader>
								<Cloud className="h-5 w-5 mb-3 text-foreground" />
								<CardTitle className="text-base">
									Full AWS Stack
								</CardTitle>
								<CardDescription className="text-sm leading-relaxed">
									VPC, EKS, RDS, ElastiCache, CloudFront, and
									WAF — configured with production best
									practices out of the box.
								</CardDescription>
							</CardHeader>
						</Card>

						<Card className="bg-background shadow-sm border-border/50 transition-colors hover:border-border">
							<CardHeader>
								<GitBranch className="h-5 w-5 mb-3 text-foreground" />
								<CardTitle className="text-base">
									GitOps-First
								</CardTitle>
								<CardDescription className="text-sm leading-relaxed">
									ArgoCD installed and configured automatically.
									Git becomes your audit trail and single source
									of truth.
								</CardDescription>
							</CardHeader>
						</Card>

						<Card className="bg-background shadow-sm border-border/50 transition-colors hover:border-border">
							<CardHeader>
								<Lock className="h-5 w-5 mb-3 text-foreground" />
								<CardTitle className="text-base">
									Bring Your Own Cloud
								</CardTitle>
								<CardDescription className="text-sm leading-relaxed">
									Cross-account IAM roles with external IDs. No
									static keys stored, no vendor lock-in.
									Infrastructure stays in your account.
								</CardDescription>
							</CardHeader>
						</Card>

						<Card className="bg-background shadow-sm border-border/50 transition-colors hover:border-border">
							<CardHeader>
								<Terminal className="h-5 w-5 mb-3 text-foreground" />
								<CardTitle className="text-base">
									CLI + Web, Unified
								</CardTitle>
								<CardDescription className="text-sm leading-relaxed">
									Configure visually in Trellis, execute locally
									with Grape. Same state, two interfaces —
									operators and developers both covered.
								</CardDescription>
							</CardHeader>
						</Card>

						<Card className="bg-background shadow-sm border-border/50 transition-colors hover:border-border">
							<CardHeader>
								<Zap className="h-5 w-5 mb-3 text-foreground" />
								<CardTitle className="text-base">
									One-Command Bootstrap
								</CardTitle>
								<CardDescription className="text-sm leading-relaxed">
									<code className="text-xs bg-muted px-1 py-0.5 rounded">
										grape bootstrap
									</code>{" "}
									provisions EKS, installs ArgoCD, and streams
									logs back to Trellis in real time.
								</CardDescription>
							</CardHeader>
						</Card>

						<Card className="bg-background shadow-sm border-border/50 transition-colors hover:border-border">
							<CardHeader>
								<Workflow className="h-5 w-5 mb-3 text-foreground" />
								<CardTitle className="text-base">
									Safe Teardown
								</CardTitle>
								<CardDescription className="text-sm leading-relaxed">
									Disables ArgoCD self-healing, drains load
									balancers, and destroys cleanly. No orphaned
									resources, no surprise bills.
								</CardDescription>
							</CardHeader>
						</Card>
					</div>
				</div>
			</section>

			{/* Install CTA */}
			<section className="border-t border-border/40 bg-muted/20">
				<div className="container mx-auto px-4 py-24 md:py-32">
					<div className="max-w-[48rem] mx-auto text-center">
						<h2 className="font-bold text-3xl md:text-4xl tracking-tighter text-foreground mb-4">
							Install Grape. Start building.
						</h2>
						<p className="text-muted-foreground text-lg mb-10 leading-relaxed max-w-[36rem] mx-auto">
							A single binary with zero runtime dependencies.
							Available via Homebrew.
						</p>

						<div className="flex items-center justify-center gap-3 rounded-lg border border-border/60 bg-neutral-950 px-5 py-3.5 max-w-md mx-auto mb-10">
							<code className="font-mono text-sm text-white/90 flex-1 text-left">
								<span className="text-white/40">$ </span>
								brew install grape
							</code>
							<CopyButton text="brew install grape" />
						</div>

						<div className="flex flex-col sm:flex-row gap-3 justify-center">
							<Link href={user ? "/dashboard" : "/auth/signin"}>
								<Button
									size="lg"
									className="h-12 px-8 text-base w-full sm:w-auto"
								>
									Open Trellis
									<ArrowRight className="ml-2 h-4 w-4" />
								</Button>
							</Link>
							<Link href="/installation">
								<Button
									variant="outline"
									size="lg"
									className="h-12 px-8 text-base w-full sm:w-auto"
								>
									Read the Docs
								</Button>
							</Link>
						</div>
					</div>
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
						Open source, developed by{" "}
						<a
							href="https://borislav.tovr.eu"
							target="_blank"
							rel="noopener noreferrer"
							className="text-foreground hover:underline"
						>
							Borislav Borisov
						</a>
						{" · "}
						<a
							href="https://github.com/bobikenobi12"
							target="_blank"
							rel="noopener noreferrer"
							className="text-foreground hover:underline"
						>
							GitHub
						</a>
						{" · "}
						<a
							href="https://www.linkedin.com/in/bborisov1/"
							target="_blank"
							rel="noopener noreferrer"
							className="text-foreground hover:underline"
						>
							LinkedIn
						</a>
					</p>
				</div>
			</footer>
		</div>
	);
}
