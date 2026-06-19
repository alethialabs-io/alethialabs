"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { SettingRow, SettingsCard } from "@/components/settings/settings-card";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth/client";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

const nameSchema = z.object({ name: z.string().min(1, "Required").max(100) });
type NameData = z.infer<typeof nameSchema>;

/** A destructive action behind a confirm dialog. */
function ConfirmAction({
	trigger,
	title,
	description,
	confirmLabel,
	onConfirm,
}: {
	trigger: ReactNode;
	title: string;
	description: string;
	confirmLabel: string;
	onConfirm: () => void;
}) {
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={onConfirm}
						className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
					>
						{confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/** Active-organization settings: rename + danger zone (leave / delete). Enterprise. */
export function OrgGeneral() {
	const router = useRouter();
	const activeOrgId = useWorkspaceStore((s) => s.activeOrgId);
	const org = useWorkspaceStore((s) =>
		s.organizations.find((o) => o.id === s.activeOrgId),
	);
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);

	const form = useForm<NameData>({
		resolver: zodResolver(nameSchema),
		values: { name: org?.name ?? "" },
	});

	const onSave = async (d: NameData) => {
		if (!activeOrgId) return;
		const { error } = await authClient.organization.update({
			data: { name: d.name },
			organizationId: activeOrgId,
		});
		if (error) {
			toast.error(error.message ?? "Couldn't update the organization");
			return;
		}
		toast.success("Organization updated");
		await fetchWorkspace();
	};

	const leaveAndExit = async (
		run: () => Promise<{ error: { message?: string } | null }>,
		failMsg: string,
	) => {
		if (!activeOrgId) return;
		const { error } = await run();
		if (error) {
			toast.error(error.message ?? failMsg);
			return;
		}
		await fetchWorkspace();
		router.push("/dashboard");
	};

	return (
		<div className="space-y-6">
			<SettingsCard
				title="Organization name"
				description="Shown across the console and in invitations."
			>
				<FormProvider {...form}>
					<form
						onSubmit={form.handleSubmit(onSave)}
						className="flex items-end gap-3"
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem className="flex-1">
									<Label className="text-sm">Name</Label>
									<FormControl>
										<Input placeholder="Acme Inc." {...field} />
									</FormControl>
									<FormMessage className="text-[11px]" />
								</FormItem>
							)}
						/>
						<Button
							type="submit"
							disabled={!form.formState.isDirty || form.formState.isSubmitting}
						>
							Save
						</Button>
					</form>
				</FormProvider>
			</SettingsCard>

			<SettingsCard
				title="Danger zone"
				description="These actions are irreversible."
			>
				<div className="divide-y divide-border/50">
					<SettingRow
						label="Leave organization"
						description="Remove yourself from this organization. You'll lose access to its resources."
						danger
					>
						<ConfirmAction
							trigger={
								<Button variant="outline" size="sm" className="border-destructive/40 text-destructive hover:bg-destructive/10">
									Leave
								</Button>
							}
							title="Leave this organization?"
							description="You'll lose access to its zones, specs, and runners. An owner will need to re-invite you."
							confirmLabel="Leave organization"
							onConfirm={() =>
								void leaveAndExit(
									() =>
										authClient.organization.leave({
											organizationId: activeOrgId ?? "",
										}),
									"Couldn't leave the organization",
								)
							}
						/>
					</SettingRow>
					<SettingRow
						label="Delete organization"
						description="Permanently delete this organization and all of its data."
						danger
					>
						<ConfirmAction
							trigger={
								<Button variant="destructive" size="sm">
									Delete
								</Button>
							}
							title="Delete this organization?"
							description="This permanently deletes the organization, its members, and its access grants. This cannot be undone."
							confirmLabel="Delete organization"
							onConfirm={() =>
								void leaveAndExit(
									() =>
										authClient.organization.delete({
											organizationId: activeOrgId ?? "",
										}),
									"Couldn't delete the organization",
								)
							}
						/>
					</SettingRow>
				</div>
			</SettingsCard>
		</div>
	);
}
