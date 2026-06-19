"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { updateZone, deleteZone } from "@/app/server/actions/zones";
import { useZonesStore } from "@/lib/stores/use-zones-store";

interface SidebarZoneActionsProps {
	zoneId: string;
	zoneName: string;
	specCount: number;
}

/** Dropdown with rename/delete actions for a sidebar zone row. */
export function SidebarZoneActions({ zoneId, zoneName, specCount }: SidebarZoneActionsProps) {
	const router = useRouter();
	const pathname = usePathname();
	const { renameZone, removeZone } = useZonesStore();

	const [showRename, setShowRename] = useState(false);
	const [showDelete, setShowDelete] = useState(false);
	const [newName, setNewName] = useState(zoneName);
	const [acting, setActing] = useState(false);

	/** Persists the new name via server action and updates the store optimistically. */
	async function handleRename() {
		const trimmed = newName.trim();
		if (!trimmed || trimmed === zoneName) {
			setShowRename(false);
			return;
		}

		setActing(true);
		try {
			await updateZone(zoneId, { name: trimmed });
			renameZone(zoneId, trimmed);
			toast.success("Zone renamed");
			setShowRename(false);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to rename zone");
		} finally {
			setActing(false);
		}
	}

	/** Deletes the zone and navigates away if currently viewing it. */
	async function handleDelete() {
		setActing(true);
		try {
			await deleteZone(zoneId);
			removeZone(zoneId);
			toast.success("Zone deleted");
			setShowDelete(false);

			if (pathname.startsWith(`/dashboard/zones/${zoneId}`)) {
				router.push("/dashboard");
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to delete zone");
		} finally {
			setActing(false);
		}
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors opacity-0 group-hover/zone:opacity-100 focus:opacity-100"
						onClick={(e) => e.stopPropagation()}
					>
						<MoreHorizontal className="h-3.5 w-3.5" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" side="right" className="w-36">
					<DropdownMenuItem onClick={() => {
						setNewName(zoneName);
						setShowRename(true);
					}}>
						<Pencil className="mr-2 h-3.5 w-3.5" />
						Rename
					</DropdownMenuItem>
					<DropdownMenuItem
						className="text-destructive focus:text-destructive"
						onClick={() => setShowDelete(true)}
					>
						<Trash2 className="mr-2 h-3.5 w-3.5" />
						Delete
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			{/* Rename Dialog */}
			<Dialog open={showRename} onOpenChange={setShowRename}>
				<DialogContent className="sm:max-w-sm" onClick={(e) => e.stopPropagation()}>
					<DialogHeader>
						<DialogTitle>Rename Zone</DialogTitle>
						<DialogDescription>
							Enter a new name for this zone.
						</DialogDescription>
					</DialogHeader>
					<form onSubmit={(e) => { e.preventDefault(); handleRename(); }}>
						<Input
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							placeholder="Zone name"
							autoFocus
							className="mb-4"
						/>
						<DialogFooter>
							<Button variant="outline" type="button" onClick={() => setShowRename(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={acting || !newName.trim()}>
								{acting ? "Saving..." : "Save"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			{/* Delete AlertDialog */}
			<AlertDialog open={showDelete} onOpenChange={setShowDelete}>
				<AlertDialogContent onClick={(e) => e.stopPropagation()}>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete &ldquo;{zoneName}&rdquo;?</AlertDialogTitle>
						<AlertDialogDescription>
							This will permanently delete this zone
							{specCount > 0 && ` and its ${specCount} spec${specCount !== 1 ? "s" : ""}`}.
							This action cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={acting}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleDelete}
							disabled={acting}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{acting ? "Deleting..." : "Delete"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
