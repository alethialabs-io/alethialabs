"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Button } from "@repo/ui/button";
import { AddRunnerDialog } from "@/components/runners/add-runner-dialog";
import { Plus } from "lucide-react";
import { useState } from "react";

export function AddRunnerButton() {
	const [open, setOpen] = useState(false);

	return (
		<>
			<Button
				size="sm"
				className="h-9 gap-1.5 text-xs font-medium"
				onClick={() => setOpen(true)}
			>
				<Plus className="h-3.5 w-3.5" />
				Add runner
			</Button>
			<AddRunnerDialog open={open} onOpenChange={setOpen} />
		</>
	);
}
