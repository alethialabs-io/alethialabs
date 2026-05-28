"use client";

import { Button } from "@/components/ui/button";
import { RegisterWorkerSheet } from "@/components/workers/register-worker-sheet";
import { Server } from "lucide-react";
import { useState } from "react";

export function RegisterWorkerButton() {
	const [open, setOpen] = useState(false);

	return (
		<>
			<Button
				size="sm"
				className="h-9 text-xs font-medium"
				onClick={() => setOpen(true)}
			>
				<Server className="mr-2 h-3.5 w-3.5" />
				Register Worker
			</Button>
			<RegisterWorkerSheet open={open} onOpenChange={setOpen} />
		</>
	);
}
