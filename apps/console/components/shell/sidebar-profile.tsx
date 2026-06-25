"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LogOut, Settings, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ThemeMenu } from "@/components/theme-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth/client";
import { globalHref } from "@/lib/routing";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { NotificationsPopover } from "./notifications-popover";

/** Two-letter initials for the avatar fallback, from the user's email. */
function userInitials(email?: string | null): string {
	if (!email) return "U";
	return email.slice(0, 2).toUpperCase();
}

/**
 * The pinned bottom bar of the sidebar: the user identity opens an account menu (profile,
 * theme, sign out), a gear links to settings, and the bell opens the notifications popover.
 */
export function SidebarProfile() {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const { data: session } = authClient.useSession();
	const user = session?.user ?? null;

	/** Signs out and returns to the marketing root. */
	const handleLogout = async () => {
		await authClient.signOut();
		router.push("/");
	};

	return (
		<div className="flex h-14 shrink-0 items-center gap-1.5 border-t px-2.5">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-muted/60"
					>
						<Avatar className="h-7 w-7">
							<AvatarFallback className="bg-muted text-[10px] font-medium text-muted-foreground">
								{userInitials(user?.email)}
							</AvatarFallback>
						</Avatar>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-[13px] font-medium text-foreground">
								{user?.name ?? "User"}
							</span>
							<span className="block truncate font-mono text-[10px] text-muted-foreground">
								{user?.email ?? "—"}
							</span>
						</span>
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" side="top" className="w-56">
					<DropdownMenuLabel className="font-normal">
						<div className="flex flex-col space-y-1">
							<p className="text-sm font-medium leading-none">Account</p>
							<p className="text-xs leading-none text-muted-foreground">
								{user?.email ?? "Loading…"}
							</p>
						</div>
					</DropdownMenuLabel>
					<DropdownMenuSeparator />
					<DropdownMenuItem asChild>
						<Link href={globalHref(orgSlug, "profile")} className="cursor-pointer">
							<User className="mr-2 h-4 w-4 text-muted-foreground" />
							Profile Settings
						</Link>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<ThemeMenu />
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

			<Link
				href={globalHref(orgSlug, "settings")}
				aria-label="Settings"
				className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
			>
				<Settings className="h-4 w-4" />
			</Link>

			<NotificationsPopover />
		</div>
	);
}
