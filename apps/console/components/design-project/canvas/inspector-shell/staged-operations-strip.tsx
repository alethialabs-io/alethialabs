"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The rail's own strip for staged operations (#6834), drawn only while nothing else applies them.
//
// An add-on install and a chart workload's overlay are staged in the document, and the changes bar
// is where a changeset is applied. Until that bar lists and runs operations it claims nothing
// (`useClaimStagedOperations`), and a staged operation would be a change no control on the page
// could apply. This strip is that control for exactly that long: it says how many are staged and
// that they apply directly, and offers Discard and Apply. The moment the bar claims the
// operations, this draws nothing.

import { useState } from "react";
import { Button } from "@repo/ui/button";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import type { StagedOperation } from "@/lib/canvas/store/types";
import { useOperations } from "@/lib/canvas/store/use-board";
import { useApplyStagedOperations } from "./apply-staged-operations";
import { forgetSecrets, useStagedOperationsClaimed } from "./staged-operations";

/** The strip, when there are staged operations and no other surface has claimed them. */
export function StagedOperationsStrip() {
	const operations = useOperations();
	const claimed = useStagedOperationsClaimed();
	if (claimed || operations.length === 0) return null;
	return <Strip operations={operations} />;
}

/** The strip's body. Mounted only when it has something to say, so its mutation is too. */
function Strip({ operations }: { operations: StagedOperation[] }) {
	const board = useBoard();
	const [refusal, setRefusal] = useState<string | null>(null);
	const apply = useApplyStagedOperations({
		onRefusal: (error) => setRefusal(error.message),
		onSuccess: () => setRefusal(null),
	});

	/** Take every staged operation off the changeset. */
	const discard = () => {
		if (apply.isPending) return;
		setRefusal(null);
		for (const operation of operations) {
			board.document.getState().unstageOperation(operation.id);
			forgetSecrets(operation.id);
		}
	};

	return (
		<section
			aria-label="Staged changes that apply directly"
			className="shrink-0 space-y-2 border-t border-border bg-surface-sunken px-4 py-3"
			data-slot="staged-operations"
		>
			<p className="text-ui-sm text-foreground">
				{operations.length === 1 ? "1 change is staged" : `${operations.length} changes are staged`}{" "}
				<span className="text-muted-foreground">
					outside the design. Applying writes{" "}
					{operations.length === 1 ? "it" : "them"} to this environment now; the cluster
					changes on the next deploy.
				</span>
			</p>
			<ul className="space-y-0.5">
				{operations.map((operation) => (
					<li key={operation.id} className="truncate font-mono text-ui-xs text-muted-foreground">
						{operation.summary}
					</li>
				))}
			</ul>
			{refusal ? (
				<p role="alert" className="text-ui-sm font-medium text-foreground">
					{refusal}
				</p>
			) : null}
			<div className="flex items-center justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={discard}
					aria-disabled={apply.isPending ? true : undefined}
				>
					Discard
				</Button>
				<Button
					type="button"
					size="sm"
					aria-disabled={apply.isPending ? true : undefined}
					onClick={() => {
						if (apply.isPending) return;
						setRefusal(null);
						apply.submit(operations);
					}}
				>
					{apply.isPending ? "Applying…" : "Apply now"}
				</Button>
			</div>
		</section>
	);
}
