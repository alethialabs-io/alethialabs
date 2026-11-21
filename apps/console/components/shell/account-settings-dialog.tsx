"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Calendar, Download, Mail, Shield, User } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	myDeletionBlockers,
	requestMyDataExport,
	scheduleMyAccountDeletion,
} from "@/app/server/actions/privacy/self-serve";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { authClient } from "@/lib/auth/client";
import { useViewer } from "@/components/providers/viewer-provider";
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

/**
 * The signed-in user's linked sign-in providers, for the badges. better-auth answers
 * `{ data, error }` rather than throwing, so an error is rethrown here to land in the query's error
 * state instead of reading as "no providers".
 */
async function linkedProviders(): Promise<string[]> {
	const res = await authClient.listAccounts();
	if (res.error) throw new Error(res.error.message ?? "Could not list linked accounts");
	return (res.data ?? []).map((a) => a.providerId);
}

/**
 * The cache key for {@link linkedProviders}, per signed-in user. Not an oRPC key: this is
 * better-auth's own endpoint. One entry per person, however many copies of the dialog are mounted
 * (the sidebar, the mobile drawer and the icon rail each mount one) — and a different person signed
 * in to the same tab never reads the previous one's providers.
 */
function linkedProvidersKey(userId: string) {
	return ["auth", "linked-providers", userId] as const;
}

interface AccountSettingsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * The account/profile settings dialog opened from the sidebar account menu's gear. Shows
 * the user's account overview (avatar, name, email, linked auth providers, member-since),
 * lets them edit their display name (persisted via Better Auth `updateUser`), emails them a
 * download of their data (`requestMyDataExport`), and exposes the account danger zone, whose
 * "Delete account" button schedules the account's deletion 14 days out behind a typed
 * confirmation (`scheduleMyAccountDeletion`, lib/privacy/self-deletion.ts).
 */
export function AccountSettingsDialog({
	open,
	onOpenChange,
}: AccountSettingsDialogProps) {
	const { viewer: user } = useViewer();
	const router = useRouter();
	// Fetched once, and only when the dialog is first OPENED (#6114, F003): the dialog is mounted up
	// to three times by the shell, and each copy used to fetch on mount — three requests on every
	// page load for badges nobody had opened. The linked providers do not change while a page is
	// open, so the answer is kept for the session.
	const { data: providers = [] } = useQuery({
		queryKey: linkedProvidersKey(user?.id ?? ""),
		queryFn: linkedProviders,
		enabled: open && !!user,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	});
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [checking, setChecking] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [blockers, setBlockers] = useState<string[]>([]);

	const {
		register,
		handleSubmit,
		reset,
		formState: { errors, isSubmitting, isDirty },
	} = useForm<ProfileInput>({
		resolver: zodResolver(profileSchema),
		values: { name: user?.name ?? "" },
	});

	/**
	 * Persists the new display name, then toasts. better-auth signals the session change, and
	 * `useViewer()` follows the live session from then on, so the shell shows the new name.
	 */
	const onSubmit = handleSubmit(async (values) => {
		try {
			const res = await authClient.updateUser({ name: values.name });
			// better-auth answers a refusal as `{ error }` rather than throwing; it is a failure.
			if (res.error) throw new Error(res.error.message ?? "Profile update refused");
			toast.success("Profile updated");
			reset({ name: values.name });
		} catch {
			toast.error("Couldn't update your profile. Please try again.");
		}
	});

	/**
	 * Asks what would stop the deletion BEFORE the confirmation opens, so a person with a live
	 * environment or a team to hand over is told that instead of being asked to type their address.
	 * The settings dialog closes first: the destructive-action spec finds the confirmation as the
	 * FIRST dialog on the page.
	 */
	const onDeleteClicked = async () => {
		setChecking(true);
		try {
			const found = await myDeletionBlockers();
			setBlockers(found.map((b) => b.message));
			if (found.length === 0) {
				onOpenChange(false);
				setConfirmOpen(true);
			}
		} catch {
			toast.error("Couldn't check whether your account can be deleted. Please try again.");
		} finally {
			setChecking(false);
		}
	};

	/**
	 * Schedules the deletion. On success every session of the account has been revoked, so the
	 * browser goes to the sign-in page, which is also where the person cancels. Answers `false`
	 * when nothing was scheduled, which keeps the confirmation open.
	 */
	const onConfirmDeletion = async (): Promise<boolean> => {
		try {
			const result = await scheduleMyAccountDeletion();
			if (result.outcome === "blocked") {
				setBlockers(result.blockers.map((b) => b.message));
				toast.error("Your account can't be deleted yet. Open Account settings to see why.");
				return true;
			}
			toast.success(
				`Your account will be deleted on ${formatDate(result.scheduledFor)}. Sign in before then to cancel.`,
			);
			router.replace("/login");
			return true;
		} catch {
			toast.error("Couldn't schedule the deletion. Please try again.");
			return false;
		}
	};

	/** Emails the person a link to a JSON export of their data. */
	const onExport = async () => {
		setExporting(true);
		try {
			const result = await requestMyDataExport();
			if (result.outcome === "rate_limited") {
				toast.error("You have asked for several exports today. Try again tomorrow.");
			} else {
				toast.success(
					`Your data export is ready. We emailed ${user?.email ?? "you"} a download link that works until ${formatDate(result.expiresAt, "datetime")}.`,
				);
			}
		} catch {
			toast.error("Couldn't prepare your data export. Please try again.");
		} finally {
			setExporting(false);
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

					{/* Your data — the access and portability rights, answered at once (lib/privacy/export.ts). */}
					<SectionHeading
						title="Your data"
						level={4}
						description="Download a copy of the personal data your account holds, as a JSON file with a signed manifest. We email you a link that works for 72 hours, only while you are signed in."
						actions={
							<Button
								variant="outline"
								size="sm"
								className="h-9 shrink-0 text-xs font-medium"
								disabled={exporting}
								onClick={() => void onExport()}
							>
								<Download className="h-3.5 w-3.5" />
								{exporting ? "Preparing…" : "Download my data"}
							</Button>
						}
					/>

					<div className="h-px bg-border" />

					{/* Danger zone — SCHEDULES the deletion; it runs by itself 14 days later unless the
					    person signs in again or uses the emailed cancel link (the maintainer's decision;
					    lib/privacy/self-deletion.ts). A typed confirmation, because what follows the grace
					    period cannot be undone. */}
					<div className="rounded-md border border-destructive/20 bg-destructive/5 p-4">
						<SectionHeading
							title="Delete account"
							level={4}
							description="Delete your account and the personal data tied to it. The deletion runs 14 days after you confirm; you are signed out, and signing in again before then, or the link we email you, cancels it."
							actions={
								<Button
									variant="destructive"
									size="sm"
									className="h-9 shrink-0 text-xs font-medium"
									disabled={checking}
									onClick={() => void onDeleteClicked()}
								>
									{checking ? "Checking…" : "Delete account"}
								</Button>
							}
						/>
						{blockers.length > 0 ? (
							<div role="alert" className="mt-3 space-y-2 text-xs text-destructive">
								<p className="font-medium">Your account can&apos;t be deleted yet:</p>
								<ul className="list-disc space-y-1 pl-4">
									{blockers.map((b) => (
										<li key={b}>{b}</li>
									))}
								</ul>
							</div>
						) : null}
					</div>
				</DialogContent>
			</Dialog>
			<ConfirmAction
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title="Delete your account?"
				description={`Your account will be deleted in 14 days. You will be signed out now; signing in again before then, or the link we email to ${user?.email ?? "your address"}, cancels the deletion.`}
				confirmLabel="Schedule deletion"
				pendingLabel="Scheduling…"
				severity={{
					level: "destroy",
					subject: user?.email ?? "",
					consequences: [
						"Your profile, sign-in methods, sessions, AI conversations and access grants are deleted.",
						"Support threads keep the other party's messages; yours are removed. Audit entries are kept without your name.",
						"Invoices, orders and the terms you accepted are kept for as long as the law requires.",
					],
				}}
				run={onConfirmDeletion}
			/>
		</>
	);
}
