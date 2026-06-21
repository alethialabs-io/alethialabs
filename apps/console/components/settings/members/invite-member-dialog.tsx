"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { UserPlus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { authClient } from "@/lib/auth/client";

// Inviteable roles (owner is the org creator — assigned via ownership transfer, not invite).
const INVITE_ROLES = ["admin", "operator", "viewer"] as const;

const inviteSchema = z.object({
	email: z.string().email("Enter a valid email"),
	role: z.enum(INVITE_ROLES),
});
type InviteData = z.infer<typeof inviteSchema>;

/** Invite a teammate to the active organization (Enterprise). */
export function InviteMemberDialog({
	onInvited,
	trigger,
}: {
	onInvited?: () => void;
	trigger?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const form = useForm<InviteData>({
		resolver: zodResolver(inviteSchema),
		defaultValues: { email: "", role: "viewer" },
		mode: "onChange",
	});

	const onSubmit = async (data: InviteData) => {
		try {
			await authClient.organization.inviteMember({
				email: data.email,
				role: data.role,
			});
			toast.success(`Invitation sent to ${data.email}`);
			setOpen(false);
			form.reset();
			onInvited?.();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to send invite");
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{trigger ?? (
					<Button size="sm" className="gap-2">
						<UserPlus className="h-4 w-4" />
						Invite member
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Invite member</DialogTitle>
					<DialogDescription>
						They&apos;ll receive an email to join this organization with the role
						you choose.
					</DialogDescription>
				</DialogHeader>
				<FormProvider {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<FormField
							control={form.control}
							name="email"
							render={({ field }) => (
								<FormItem>
									<Label className="text-sm">Email</Label>
									<FormControl>
										<Input
											type="email"
											placeholder="teammate@company.com"
											autoFocus
											{...field}
										/>
									</FormControl>
									<FormMessage className="text-[11px]" />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="role"
							render={({ field }) => (
								<FormItem>
									<Label className="text-sm">Role</Label>
									<Select value={field.value} onValueChange={field.onChange}>
										<FormControl>
											<SelectTrigger className="h-9 capitalize">
												<SelectValue />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{INVITE_ROLES.map((r) => (
												<SelectItem key={r} value={r} className="capitalize">
													{r}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FormMessage className="text-[11px]" />
								</FormItem>
							)}
						/>
						<DialogFooter>
							<Button type="submit" disabled={form.formState.isSubmitting}>
								Send invite
							</Button>
						</DialogFooter>
					</form>
				</FormProvider>
			</DialogContent>
		</Dialog>
	);
}
