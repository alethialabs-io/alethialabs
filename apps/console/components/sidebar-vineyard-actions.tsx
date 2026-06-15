"use client";
// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
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

import { updateVineyard, deleteVineyard } from "@/app/server/actions/vineyards";
import { useVineyardsStore } from "@/lib/stores/use-vineyards-store";

interface VineyardActionsProps {
	vineyardId: string;
	vineyardName: string;
	vineCount: number;
}

/** Dropdown with rename/delete actions for a sidebar vineyard row. */
export function VineyardActions({ vineyardId, vineyardName, vineCount }: VineyardActionsProps) {
	const router = useRouter();
	const pathname = usePathname();
	const { renameVineyard, removeVineyard } = useVineyardsStore();

	const [showRename, setShowRename] = useState(false);
	const [showDelete, setShowDelete] = useState(false);
	const [newName, setNewName] = useState(vineyardName);
	const [acting, setActing] = useState(false);

	/** Persists the new name via server action and updates the store optimistically. */
	async function handleRename() {
		const trimmed = newName.trim();
		if (!trimmed || trimmed === vineyardName) {
			setShowRename(false);
			return;
		}

		setActing(true);
		try {
			await updateVineyard(vineyardId, { name: trimmed });
			renameVineyard(vineyardId, trimmed);
			toast.success("Vineyard renamed");
			setShowRename(false);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to rename vineyard");
		} finally {
			setActing(false);
		}
	}

	/** Deletes the vineyard and navigates away if currently viewing it. */
	async function handleDelete() {
		setActing(true);
		try {
			await deleteVineyard(vineyardId);
			removeVineyard(vineyardId);
			toast.success("Vineyard deleted");
			setShowDelete(false);

			if (pathname.startsWith(`/dashboard/vineyards/${vineyardId}`)) {
				router.push("/dashboard");
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to delete vineyard");
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
						className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors opacity-0 group-hover/vineyard:opacity-100 focus:opacity-100"
						onClick={(e) => e.stopPropagation()}
					>
						<MoreHorizontal className="h-3.5 w-3.5" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" side="right" className="w-36">
					<DropdownMenuItem onClick={() => {
						setNewName(vineyardName);
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
						<DialogTitle>Rename Vineyard</DialogTitle>
						<DialogDescription>
							Enter a new name for this vineyard.
						</DialogDescription>
					</DialogHeader>
					<form onSubmit={(e) => { e.preventDefault(); handleRename(); }}>
						<Input
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							placeholder="Vineyard name"
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
						<AlertDialogTitle>Delete &ldquo;{vineyardName}&rdquo;?</AlertDialogTitle>
						<AlertDialogDescription>
							This will permanently delete this vineyard
							{vineCount > 0 && ` and its ${vineCount} vine${vineCount !== 1 ? "s" : ""}`}.
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
