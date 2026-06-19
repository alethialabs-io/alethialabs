"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Button } from "@/components/ui/button";
import { AddRunnerSheet } from "@/components/runners/add-runner-sheet";
import { Plus } from "lucide-react";
import { useState } from "react";

export function AddRunnerButton() {
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
				Add Runner
			</Button>
			<AddRunnerSheet open={open} onOpenChange={setOpen} />
		</>
	);
}
