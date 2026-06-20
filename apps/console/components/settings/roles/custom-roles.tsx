"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { type CustomRole, deleteRole, listCustomRoles } from "@/app/server/actions/roles";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RoleEditorDialog } from "./role-editor-dialog";

/** Custom-role list + create/edit/delete (Enterprise; rendered inside the gate). */
export function CustomRoles() {
	const [roles, setRoles] = useState<CustomRole[] | null>(null);

	const load = useCallback(() => {
		listCustomRoles()
			.then(setRoles)
			.catch(() => setRoles([]));
	}, []);
	useEffect(() => {
		load();
	}, [load]);

	const remove = async (r: CustomRole) => {
		try {
			await deleteRole(r.id);
			toast.success("Role deleted");
			load();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to delete role");
		}
	};

	return (
		<div className="space-y-3">
			<div className="flex justify-end">
				<RoleEditorDialog
					onSaved={load}
					trigger={
						<Button size="sm" className="gap-2">
							<Plus className="h-4 w-4" />
							New role
						</Button>
					}
				/>
			</div>

			{roles === null ? (
				<Skeleton className="h-16 w-full" />
			) : roles.length === 0 ? (
				<p className="rounded-lg border border-dashed border-border/60 bg-muted/10 px-4 py-8 text-center text-sm text-muted-foreground">
					No custom roles yet. Create one to tailor a permission set for your
					organization.
				</p>
			) : (
				<div className="space-y-2">
					{roles.map((r) => (
						<div
							key={r.id}
							className="flex items-center justify-between rounded-lg border border-border/50 bg-card px-4 py-3"
						>
							<div className="min-w-0">
								<p className="truncate text-sm font-medium text-foreground">{r.name}</p>
								<p className="text-xs text-muted-foreground">
									{r.permissionKeys.length} permission
									{r.permissionKeys.length === 1 ? "" : "s"}
								</p>
							</div>
							<div className="flex items-center gap-1">
								<RoleEditorDialog
									role={r}
									onSaved={load}
									trigger={
										<Button variant="ghost" size="icon" className="h-8 w-8">
											<Pencil className="h-4 w-4" />
											<span className="sr-only">Edit {r.name}</span>
										</Button>
									}
								/>
								<Button
									variant="ghost"
									size="icon"
									className="h-8 w-8 text-destructive"
									onClick={() => void remove(r)}
								>
									<Trash2 className="h-4 w-4" />
									<span className="sr-only">Delete {r.name}</span>
								</Button>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
