"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import type { ReactNode } from "react";
import { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { createRole, type CustomRole, updateRole } from "@/app/server/actions/roles";
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
import { PermissionMatrix } from "./permission-matrix";

const schema = z.object({
	name: z.string().min(1, "Name required").max(60),
	permissions: z.array(z.string()),
});
type Data = z.infer<typeof schema>;

/** Create or edit a custom role via the permission matrix (Enterprise). */
export function RoleEditorDialog({
	role,
	trigger,
	onSaved,
}: {
	role?: CustomRole;
	trigger: ReactNode;
	onSaved?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const form = useForm<Data>({
		resolver: zodResolver(schema),
		values: { name: role?.name ?? "", permissions: role?.permissionKeys ?? [] },
	});

	const onSubmit = async (d: Data) => {
		try {
			if (role) await updateRole(role.id, d.name, d.permissions);
			else await createRole(d.name, d.permissions);
			toast.success(role ? "Role updated" : "Role created");
			setOpen(false);
			onSaved?.();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save role");
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{role ? "Edit role" : "New role"}</DialogTitle>
					<DialogDescription>
						Pick the exact permissions this role grants. Assign it to members or
						teams, scoped org-wide or to a resource.
					</DialogDescription>
				</DialogHeader>
				<FormProvider {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<Label className="text-sm">Role name</Label>
									<FormControl>
										<Input placeholder="spec-deployer" {...field} />
									</FormControl>
									<FormMessage className="text-[11px]" />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="permissions"
							render={({ field }) => (
								<FormItem>
									<Label className="text-sm">Permissions</Label>
									<PermissionMatrix value={field.value} onChange={field.onChange} />
								</FormItem>
							)}
						/>
						<DialogFooter>
							<Button type="submit" disabled={form.formState.isSubmitting}>
								{role ? "Save changes" : "Create role"}
							</Button>
						</DialogFooter>
					</form>
				</FormProvider>
			</DialogContent>
		</Dialog>
	);
}
