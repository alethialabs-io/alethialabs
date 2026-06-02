"use client";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useTendrilsStore, type TendrilRelease } from "@/lib/stores/use-tendrils-store";
import { formatDistanceToNow } from "date-fns";
import { ArrowUpCircle, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";

interface ReleaseNotesDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	version: string | null;
	workerId?: string;
	isOutdated?: boolean;
}

/** Modal showing release notes for a specific tendril version. */
export function ReleaseNotesDialog({
	open,
	onOpenChange,
	version,
	workerId,
	isOutdated,
}: ReleaseNotesDialogProps) {
	const router = useRouter();
	const { fetchReleaseNotes, updateTendril } = useTendrilsStore();
	const [release, setRelease] = useState<TendrilRelease | null>(null);
	const [loading, setLoading] = useState(false);
	const [updating, setUpdating] = useState(false);

	useEffect(() => {
		if (!open || !version) {
			setRelease(null);
			return;
		}
		setLoading(true);
		fetchReleaseNotes(version)
			.then(setRelease)
			.finally(() => setLoading(false));
	}, [open, version, fetchReleaseNotes]);

	const handleUpdate = async () => {
		if (!workerId) return;
		setUpdating(true);
		try {
			const { jobId } = await updateTendril(workerId);
			toast.success("Update job queued", {
				action: {
					label: "View job",
					onClick: () => router.push(`/dashboard/jobs/${jobId}`),
				},
			});
			onOpenChange(false);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to queue update");
		} finally {
			setUpdating(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<span className="font-mono">v{version}</span>
						{isOutdated && (
							<Badge
								variant="outline"
								className="text-[10px] py-0 text-amber-600 border-amber-200 bg-amber-50 dark:text-amber-400 dark:border-amber-800 dark:bg-amber-950"
							>
								Outdated
							</Badge>
						)}
					</DialogTitle>
					{release?.released_at && (
						<DialogDescription>
							Released {formatDistanceToNow(new Date(release.released_at), { addSuffix: true })}
						</DialogDescription>
					)}
				</DialogHeader>

				<div className="flex-1 overflow-y-auto min-h-0 py-2">
					{loading ? (
						<div className="space-y-2">
							<Skeleton className="h-4 w-3/4" />
							<Skeleton className="h-4 w-1/2" />
							<Skeleton className="h-4 w-5/6" />
						</div>
					) : release?.release_notes ? (
						<div className="prose prose-sm dark:prose-invert max-w-none [&_h2]:text-base [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:text-sm [&_ul]:my-1 [&_li]:my-0.5">
							<ReactMarkdown>{release.release_notes}</ReactMarkdown>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">No release notes available for this version.</p>
					)}
				</div>

				<DialogFooter>
					{isOutdated && workerId && (
						<Button
							size="sm"
							disabled={updating}
							onClick={handleUpdate}
						>
							{updating ? (
								<>
									<Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
									Updating...
								</>
							) : (
								<>
									<ArrowUpCircle className="mr-1.5 h-3.5 w-3.5" />
									Update Tendril
								</>
							)}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
