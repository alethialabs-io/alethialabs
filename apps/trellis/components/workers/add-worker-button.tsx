"use client";

import { Button } from "@/components/ui/button";
import { AddWorkerSheet } from "@/components/workers/add-worker-sheet";
import { Plus } from "lucide-react";
import { useState } from "react";

export function AddWorkerButton() {
	const [open, setOpen] = useState(false);

	return (
		<>
			<Button
				variant="outline"
				size="sm"
				className="h-9 text-xs font-medium"
				onClick={() => setOpen(true)}
			>
				<Plus className="mr-2 h-3.5 w-3.5" />
				Add Worker
			</Button>
			<AddWorkerSheet open={open} onOpenChange={setOpen} />
		</>
	);
}
