"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import { Calendar, Mail, Shield, User } from "lucide-react";
import { useEffect, useState } from "react";

export default function ProfilePage() {
	const [user, setUser] = useState<SupabaseUser | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const getUser = async () => {
			const supabase = createClient();
			const {
				data: { user },
			} = await supabase.auth.getUser();
			setUser(user);
			setLoading(false);
		};

		getUser();
	}, []);

	if (loading) {
		return (
			<div className="space-y-8 w-full max-w-[1000px]">
				<div className="space-y-1.5">
					<Skeleton className="h-8 w-48" />
					<Skeleton className="h-4 w-72" />
				</div>

				<div className="rounded-lg border border-border/40 shadow-sm">
					<div className="border-b border-border/40 p-6 bg-muted/5 space-y-1.5">
						<Skeleton className="h-5 w-40" />
						<Skeleton className="h-3 w-64" />
					</div>
					<div className="p-6">
						<div className="flex flex-col sm:flex-row items-start gap-8">
							<Skeleton className="h-20 w-20 sm:h-24 sm:w-24 rounded-full" />
							<div className="flex-1 grid gap-6 sm:grid-cols-2 w-full">
								{[1, 2, 3, 4].map((i) => (
									<div key={i} className="space-y-1.5">
										<Skeleton className="h-3 w-20" />
										<Skeleton className="h-4 w-36" />
									</div>
								))}
							</div>
						</div>
					</div>
				</div>

				<div className="rounded-lg border border-border/40 shadow-sm">
					<div className="border-b border-border/40 p-6 bg-muted/5 space-y-1.5">
						<Skeleton className="h-5 w-32" />
						<Skeleton className="h-3 w-48" />
					</div>
					<div className="p-6 space-y-5">
						<div className="grid gap-5 sm:max-w-md">
							{[1, 2].map((i) => (
								<div key={i} className="space-y-2">
									<Skeleton className="h-3 w-20" />
									<Skeleton className="h-9 w-full rounded-md" />
								</div>
							))}
						</div>
						<Skeleton className="h-9 w-28 rounded-md" />
					</div>
				</div>

				<div className="rounded-lg border border-destructive/20 shadow-sm">
					<div className="border-b border-destructive/10 p-6 bg-destructive/5 space-y-1.5">
						<Skeleton className="h-5 w-28" />
						<Skeleton className="h-3 w-44" />
					</div>
					<div className="p-6">
						<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
							<div className="space-y-1">
								<Skeleton className="h-4 w-28" />
								<Skeleton className="h-3 w-80" />
							</div>
							<Skeleton className="h-9 w-32 rounded-md" />
						</div>
					</div>
				</div>
			</div>
		);
	}

	const getProviderBadge = (provider: string) => {
		const providers: Record<string, { label: string }> = {
			google: { label: "Google" },
			github: { label: "GitHub" },
			gitlab: { label: "GitLab" },
			bitbucket: { label: "Bitbucket" },
			email: { label: "Email" },
		};
		const providerInfo = providers[provider] || { label: provider };
		
		return (
			<Badge variant="secondary" className="font-normal text-[11px] px-2 py-0.5 h-5 bg-muted/50 text-muted-foreground border-border/50">
				{providerInfo.label}
			</Badge>
		);
	};

	return (
		<div className="space-y-8 w-full max-w-[1000px]">
			<div className="space-y-1.5">
				<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
					Profile Settings
				</h1>
				<p className="text-muted-foreground text-sm">
					Manage your account information and preferences.
				</p>
			</div>

			{/* Profile Overview */}
			<Card className="shadow-sm border-border/40">
				<CardHeader className="border-b border-border/40 pb-4 bg-muted/5">
					<CardTitle className="text-base font-medium">
						Account Information
					</CardTitle>
					<CardDescription className="text-xs">
						Your personal details and authentication method.
					</CardDescription>
				</CardHeader>
				<CardContent className="pt-6">
					<div className="flex flex-col sm:flex-row items-start gap-8">
						<Avatar className="h-20 w-20 sm:h-24 sm:w-24 border border-border/50 shadow-sm">
							<AvatarImage
								src={
									user?.user_metadata?.avatar_url ||
									"/generic-user-avatar.png"
								}
								alt="User avatar"
							/>
							<AvatarFallback className="text-2xl bg-muted text-muted-foreground">
								{user?.email?.charAt(0).toUpperCase() || "U"}
							</AvatarFallback>
						</Avatar>
						<div className="flex-1 grid gap-6 sm:grid-cols-2 w-full">
							<div className="space-y-1.5">
								<Label className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
									<User className="h-3 w-3" />
									Full Name
								</Label>
								<p className="text-sm font-medium text-foreground">
									{user?.user_metadata?.full_name ||
										user?.user_metadata?.name ||
										"Not set"}
								</p>
							</div>
							<div className="space-y-1.5">
								<Label className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
									<Mail className="h-3 w-3" />
									Email Address
								</Label>
								<p className="text-sm font-medium text-foreground">
									{user?.email || "No email"}
								</p>
							</div>
							<div className="space-y-1.5">
								<Label className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
									<Shield className="h-3 w-3" />
									Authentication
								</Label>
								<div className="flex gap-2 flex-wrap">
									{user?.identities &&
									user.identities.length > 0 ? (
										user.identities.map((identity) => (
											<div key={identity.id}>
												{getProviderBadge(
													identity.provider,
												)}
											</div>
										))
									) : (
										<div>
											{user?.app_metadata?.provider &&
												getProviderBadge(
													user.app_metadata.provider,
												)}
										</div>
									)}
								</div>
							</div>
							<div className="space-y-1.5">
								<Label className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
									<Calendar className="h-3 w-3" />
									Member Since
								</Label>
								<p className="text-sm font-medium text-foreground">
									{user?.created_at
										? new Date(
												user.created_at,
											).toLocaleDateString("en-US", {
												year: "numeric",
												month: "long",
												day: "numeric",
											})
										: "Unknown"}
								</p>
							</div>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* Account Details */}
			<Card className="shadow-sm border-border/40">
				<CardHeader className="border-b border-border/40 pb-4 bg-muted/5">
					<CardTitle className="text-base font-medium">
						Profile Details
					</CardTitle>
					<CardDescription className="text-xs">
						Update your profile information.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5 pt-6">
					<div className="grid gap-5 sm:max-w-md">
						<div className="space-y-2">
							<Label htmlFor="name" className="text-xs">Display Name</Label>
							<Input
								id="name"
								placeholder="Enter your name"
								className="h-9 text-sm"
								defaultValue={
									user?.user_metadata?.full_name ||
									user?.user_metadata?.name ||
									""
								}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="email" className="text-xs">Email</Label>
							<Input
								id="email"
								type="email"
								value={user?.email || ""}
								disabled
								className="h-9 text-sm bg-muted/50 text-muted-foreground"
							/>
							<p className="text-[11px] text-muted-foreground">
								Email cannot be changed after registration.
							</p>
						</div>
					</div>
					<Button className="h-9 text-xs font-medium">
						Save Changes
					</Button>
				</CardContent>
			</Card>

			{/* Account Security */}
			<Card className="shadow-sm border-destructive/20">
				<CardHeader className="border-b border-destructive/10 pb-4 bg-destructive/5">
					<CardTitle className="text-base font-medium text-destructive">
						Danger Zone
					</CardTitle>
					<CardDescription className="text-xs text-destructive/80">
						Irreversible account actions.
					</CardDescription>
				</CardHeader>
				<CardContent className="pt-6">
					<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
						<div className="space-y-1">
							<h4 className="text-sm font-medium text-foreground">Delete Account</h4>
							<p className="text-xs text-muted-foreground max-w-lg">
								Once you delete your account, there is no going
								back. All your configurations and data will be
								permanently deleted.
							</p>
						</div>
						<Button variant="destructive" size="sm" className="h-9 text-xs font-medium shrink-0">
							Delete Account
						</Button>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
