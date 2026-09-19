"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { Calendar, Mail, Shield, User } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { PRIVACY_RESPONSE_DAYS } from "@/app/server/actions/privacy/response-period";
import { requestMyErasure } from "@/app/server/actions/privacy/self-serve";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
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
 * the account danger zone, whose "Request deletion" button opens an erasure privacy case
 * about the signed-in user (`requestMyErasure`) behind a confirmation — a request a person
 * fulfils, not a deletion (#4273).
 */
export function AccountSettingsDialog({
	open,
	onOpenChange,
}: AccountSettingsDialogProps) {
	const { data: session } = authClient.useSession();
	const user = session?.user ?? null;
	const [providers, setProviders] = useState<string[]>([]);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [requesting, setRequesting] = useState(false);

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

	/**
	 * Opens the erasure request for the signed-in user and says what happened — a request with a
	 * reference that was sent to the privacy inbox, never a deletion. A second press while one is
	 * open gets the existing reference back. A deployment with no privacy contact opens nothing, and
	 * the toast says so rather than implying anyone was told.
	 */
	const onRequestErasure = async () => {
		setRequesting(true);
		try {
			const result = await requestMyErasure();
			if (result.outcome === "already_open") {
				toast.info(
					`You already have an open erasure request (${result.reference}). Nothing has been deleted yet.`,
				);
			} else if (result.outcome === "opened") {
				toast.success(
					`Erasure request ${result.reference} opened. Nothing has been deleted yet — the request was sent to the privacy team.`,
				);
			} else {
				toast.error(
					"No request was opened: this deployment has no privacy contact configured. Ask your administrator to erase your account.",
				);
			}
		} catch {
			toast.error("Couldn't open the erasure request. Please try again.");
		} finally {
			setRequesting(false);
		}
	};

	const shownProviders = providers.length > 0 ? providers : ["email"];

	return (
		<>
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

					{/* Danger zone — REQUESTS deletion; it deletes nothing (#4273).

					    The maintainer's ruling (2026-09-18, revised on #4273): this button opens an ERASURE
					    PRIVACY CASE about the signed-in user, with identity recorded as verified by the session,
					    and a person fulfils it. The case is emailed to the privacy inbox as it is opened, or it
					    is not opened at all (#4875) — which is what lets the copy say it was "sent to the
					    privacy team". It does not call `fulfilErasure`, which today writes a
					    tombstone and deletes no row (#4854 tracks the executor). So the copy says a request is
					    opened and never that anything was deleted — if the executor lands and this becomes a
					    real erasure, the copy, `account.delete` in `destructive-actions.yaml` and
					    `e2e/account-settings.spec.ts` all move with it.

					    The settings dialog CLOSES before the confirmation opens, rather than stacking the
					    confirmation on top of it: `e2e/audit/destructive.spec.ts` finds the confirmation as the
					    FIRST dialog on the page, and a settings dialog still open underneath would be found
					    first. */}
					<div className="rounded-md border border-destructive/20 bg-destructive/5 p-4">
						<SectionHeading
							title="Delete account"
							level={4}
							description={`Ask for your account and the personal data tied to it to be erased. Pressing the button opens an erasure request and sends it to the privacy team — nothing is deleted at that moment. A response is due within ${PRIVACY_RESPONSE_DAYS} days of the request.`}
							actions={
								<Button
									variant="destructive"
									size="sm"
									className="h-9 shrink-0 text-xs font-medium"
									disabled={requesting}
									onClick={() => {
										onOpenChange(false);
										setConfirmOpen(true);
									}}
								>
									{requesting ? "Opening request…" : "Request deletion"}
								</Button>
							}
						/>
					</div>
				</DialogContent>
			</Dialog>
			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title="Request deletion of your account?"
				description={`This opens an erasure request for ${user?.email ?? "your account"} and sends it to the privacy team. Nothing is deleted now, and your account keeps working while the request is handled.`}
				confirmLabel="Open erasure request"
				onConfirm={onRequestErasure}
			/>
		</>
	);
}
