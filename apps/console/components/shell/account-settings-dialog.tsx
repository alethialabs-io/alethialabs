"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { Calendar, Mail, Shield, User } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { authClient } from "@/lib/auth/client";
import { formatDate } from "@repo/format";
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/avatar";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { SectionHeading } from "@repo/ui/section-heading";

/** Friendly labels for the auth providers surfaced as badges. */
const PROVIDER_LABELS: Record<string, string> = {
	google: "Google",
	github: "GitHub",
	gitlab: "GitLab",
	bitbucket: "Bitbucket",
	email: "Email",
};

const profileSchema = z.object({
	name: z.string().min(1, "Enter a display name").max(120),
});
type ProfileInput = z.infer<typeof profileSchema>;

interface AccountSettingsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * The account/profile settings dialog opened from the sidebar account menu's gear. Shows
 * the user's account overview (avatar, name, email, linked auth providers, member-since),
 * lets them edit their display name (persisted via Better Auth `updateUser`), and exposes
 * the account danger zone. The Delete Account button in that zone is INERT and stays inert
 * until a maintainer rules on which erasure flow it belongs to — the note at the call site
 * states the open question and #4273 carries it.
 */
export function AccountSettingsDialog({
	open,
	onOpenChange,
}: AccountSettingsDialogProps) {
	const { data: session } = authClient.useSession();
	const user = session?.user ?? null;
	const [providers, setProviders] = useState<string[]>([]);

	const {
		register,
		handleSubmit,
		reset,
		formState: { errors, isSubmitting, isDirty },
	} = useForm<ProfileInput>({
		resolver: zodResolver(profileSchema),
		values: { name: user?.name ?? "" },
	});

	// Load the linked auth providers once a session exists (for the badges).
	useEffect(() => {
		if (!user) return;
		authClient.listAccounts().then((res) => {
			setProviders((res.data ?? []).map((a) => a.providerId));
		});
	}, [user]);

	/** Persists the new display name, then toasts; the session hook reflects the change. */
	const onSubmit = handleSubmit(async (values) => {
		try {
			await authClient.updateUser({ name: values.name });
			toast.success("Profile updated");
			reset({ name: values.name });
		} catch {
			toast.error("Couldn't update your profile. Please try again.");
		}
	});

	const shownProviders = providers.length > 0 ? providers : ["email"];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Account Settings</DialogTitle>
					<DialogDescription>
						Manage your account information and preferences.
					</DialogDescription>
				</DialogHeader>

				{/* Account overview */}
				<div className="flex items-start gap-4">
					<Avatar className="h-16 w-16 border border-border/50">
						<AvatarImage
							src={user?.image || "/generic-user-avatar.png"}
							alt="User avatar"
						/>
						<AvatarFallback className="bg-muted text-lg text-muted-foreground">
							{user?.email?.charAt(0).toUpperCase() || "U"}
						</AvatarFallback>
					</Avatar>
					<div className="grid flex-1 gap-4 sm:grid-cols-2">
						<div className="space-y-1">
							<Label className="flex items-center gap-1.5 text-ui-xs font-medium uppercase tracking-wider text-muted-foreground">
								<User className="h-3 w-3" />
								Full Name
							</Label>
							<p className="text-sm font-medium text-foreground">
								{user?.name || "Not set"}
							</p>
						</div>
						<div className="space-y-1">
							<Label className="flex items-center gap-1.5 text-ui-xs font-medium uppercase tracking-wider text-muted-foreground">
								<Mail className="h-3 w-3" />
								Email
							</Label>
							<p className="truncate text-sm font-medium text-foreground">
								{user?.email || "No email"}
							</p>
						</div>
						<div className="space-y-1">
							<Label className="flex items-center gap-1.5 text-ui-xs font-medium uppercase tracking-wider text-muted-foreground">
								<Shield className="h-3 w-3" />
								Authentication
							</Label>
							<div className="flex flex-wrap gap-1.5">
								{shownProviders.map((providerId) => (
									<Badge
										key={providerId}
										variant="secondary"
										className="h-5 border-border/50 bg-muted/50 px-2 py-0.5 text-ui-xs font-normal text-muted-foreground"
									>
										{PROVIDER_LABELS[providerId] ?? providerId}
									</Badge>
								))}
							</div>
						</div>
						<div className="space-y-1">
							<Label className="flex items-center gap-1.5 text-ui-xs font-medium uppercase tracking-wider text-muted-foreground">
								<Calendar className="h-3 w-3" />
								Member Since
							</Label>
							<p className="text-sm font-medium text-foreground">
								{user?.createdAt ? formatDate(user.createdAt) : "Unknown"}
							</p>
						</div>
					</div>
				</div>

				<div className="h-px bg-border" />

				{/* Edit display name */}
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="grid gap-4 sm:max-w-sm">
						<div className="space-y-2">
							<Label htmlFor="account-name" className="text-xs">
								Display Name
							</Label>
							<Input
								id="account-name"
								placeholder="Enter your name"
								className="h-9 text-sm"
								{...register("name")}
							/>
							{errors.name && (
								<p className="text-xs text-destructive">{errors.name.message}</p>
							)}
						</div>
						<div className="space-y-2">
							<Label htmlFor="account-email" className="text-xs">
								Email
							</Label>
							<Input
								id="account-email"
								type="email"
								value={user?.email || ""}
								disabled
								className="h-9 bg-muted/50 text-sm text-muted-foreground"
							/>
							<p className="text-ui-xs text-muted-foreground">
								Email cannot be changed after registration.
							</p>
						</div>
					</div>
					<Button
						type="submit"
						size="sm"
						className="h-9 text-xs font-medium"
						disabled={isSubmitting || !isDirty}
					>
						{isSubmitting ? "Saving…" : "Save Changes"}
					</Button>
				</form>

				<div className="h-px bg-border" />

				{/* Danger zone.

				    THIS BUTTON IS DELIBERATELY INERT, AND THE DECISION BEHIND IT IS STILL OPEN (#4273).
				    It has no `onClick`, and `apps/console/destructive-actions.yaml` records it as the
				    registry's one `status: inert` row for exactly that reason. Do not "finish" it — the
				    thing that is missing is a ruling, not a handler.

				    What is undecided is which flow the click belongs to, and both candidates already
				    exist in `app/server/actions/privacy/cases.ts`:

				      · `fulfilErasure` — the destructive one. It REFUSES outright unless the request's
				        identity has been verified through the privileged verification step: "Identity is
				        not verified. Nothing is destroyed until we know who asked — an erasure performed
				        on an unverified request is itself a data breach." Whether an authenticated
				        console session is that verification is a DATA-PROTECTION question, not a wiring
				        one; answering it in code answers it for the product.

				      · `openPrivacyCase("erasure")` — the request path. Records the erasure request and
				        leaves fulfilment to the verified flow. Slower for the operator, and it makes the
				        button mean something different from what its own copy above promises.

				    Until a maintainer picks one, the honest surface is a control that does nothing over a
				    control that does the wrong thing to somebody's account. The e2e coverage for this
				    dialog (`apps/console/e2e/account-settings.spec.ts`) asserts the inertness rather than
				    working around it, so wiring the button without also moving that spec and the registry
				    entry is a red gate, by design. */}
				<div className="rounded-md border border-destructive/20 bg-destructive/5 p-4">
					<SectionHeading
						title="Delete Account"
						level={4}
						description="Once you delete your account, there is no going back. All your configurations and data will be permanently deleted."
						actions={
							<Button
								variant="destructive"
								size="sm"
								className="h-9 shrink-0 text-xs font-medium"
							>
								Delete Account
							</Button>
						}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
