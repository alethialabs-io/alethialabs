"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { registerWorker } from "@/app/server/actions/workers";
import { Check, Copy, Loader2, Server, AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

interface RegisterWorkerSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

interface Credentials {
	workerId: string;
	workerToken: string;
	workerName: string;
	workerMode: string;
}

function CopyField({ label, value }: { label: string; value: string }) {
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		await navigator.clipboard.writeText(value);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<div className="space-y-1.5">
			<Label className="text-xs text-muted-foreground">{label}</Label>
			<div className="flex items-center gap-2">
				<code className="flex-1 rounded-md bg-muted px-3 py-2 text-xs font-mono break-all border border-border/50">
					{value}
				</code>
				<Button
					variant="outline"
					size="icon"
					className="shrink-0 h-9 w-9"
					onClick={copy}
				>
					{copied ? (
						<Check className="h-3.5 w-3.5 text-emerald-500" />
					) : (
						<Copy className="h-3.5 w-3.5" />
					)}
				</Button>
			</div>
		</div>
	);
}

export function RegisterWorkerSheet({
	open,
	onOpenChange,
}: RegisterWorkerSheetProps) {
	const router = useRouter();
	const [name, setName] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [credentials, setCredentials] = useState<Credentials | null>(null);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) return;

		setIsSubmitting(true);
		try {
			const result = await registerWorker(name.trim(), "self-hosted");
			setCredentials({
				workerId: result.worker.id,
				workerToken: result.worker_token,
				workerName: result.worker.name,
				workerMode: result.worker.mode,
			});
			router.refresh();
		} catch (error: any) {
			toast.error(error.message || "Failed to register worker");
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleClose = (open: boolean) => {
		if (!open) {
			setName("");
			setCredentials(null);
		}
		onOpenChange(open);
	};

	return (
		<Sheet open={open} onOpenChange={handleClose}>
			<SheetContent
				side="right"
				className="w-full sm:max-w-lg overflow-y-auto p-0"
			>
				<SheetHeader className="px-6 pt-6 pb-4 border-b border-border/40">
					<SheetTitle className="flex items-center gap-2">
						<Server className="h-4 w-4" />
						Register Worker
					</SheetTitle>
					<SheetDescription>
						{credentials
							? "Save these credentials — the token cannot be recovered."
							: "Register a self-hosted worker that runs in your own infrastructure."}
					</SheetDescription>
				</SheetHeader>

				<div className="px-6 py-6">
					{credentials ? (
						<div className="space-y-6">
							<div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
								<div className="flex gap-3">
									<AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
									<div className="space-y-1">
										<p className="text-sm font-medium">
											Save these credentials now
										</p>
										<p className="text-xs text-muted-foreground">
											The worker token is shown only once
											and cannot be recovered. If you lose
											it, you'll need to register a new
											worker.
										</p>
									</div>
								</div>
							</div>

							<CopyField
								label="Worker ID"
								value={credentials.workerId}
							/>
							<CopyField
								label="Worker Token"
								value={credentials.workerToken}
							/>

							<div className="space-y-2 pt-2">
								<Label className="text-xs text-muted-foreground">
									Start with environment variables
								</Label>
								<pre className="rounded-md bg-muted p-3 text-xs font-mono overflow-x-auto border border-border/50 leading-relaxed">
{`export GRAPE_WORKER_ID=${credentials.workerId}
export GRAPE_WORKER_TOKEN=${credentials.workerToken}
grape worker start`}
								</pre>
							</div>

							<div className="space-y-2">
								<Label className="text-xs text-muted-foreground">
									Or with flags
								</Label>
								<pre className="rounded-md bg-muted p-3 text-xs font-mono overflow-x-auto border border-border/50 leading-relaxed">
{`grape worker start \\
  --worker-id=${credentials.workerId} \\
  --worker-token=${credentials.workerToken}`}
								</pre>
							</div>

							<Button
								className="w-full"
								onClick={() => handleClose(false)}
							>
								Done
							</Button>
						</div>
					) : (
						<form onSubmit={handleSubmit} className="space-y-5">
							<div className="space-y-2">
								<Label htmlFor="worker-name" className="text-sm">
									Name
								</Label>
								<Input
									id="worker-name"
									placeholder="e.g. fargate-eu-west-1"
									value={name}
									onChange={(e) => setName(e.target.value)}
									className="h-9"
									autoFocus
								/>
								<p className="text-xs text-muted-foreground">
									A human-readable name to identify this worker.
								</p>
							</div>

							<p className="text-xs text-muted-foreground">
								The worker will run in your infrastructure with your
								cloud permissions.
							</p>

							<Button
								type="submit"
								className="w-full"
								disabled={!name.trim() || isSubmitting}
							>
								{isSubmitting ? (
									<Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
								) : (
									<Server className="mr-2 h-3.5 w-3.5" />
								)}
								Register Worker
							</Button>
						</form>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
