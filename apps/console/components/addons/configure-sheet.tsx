"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The enable / configure sheet for one add-on: a form over the add-on's serializable knob
// descriptors (mirrors its Zod schema, which re-validates server-side). Submitting writes a
// PENDING project_addons row; the add-on applies on the next Deploy. Phase 1 is managed-apply
// only; the GitOps (bring-your-own-repo) mode lands in Phase 2.

import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { Switch } from "@repo/ui/switch";
import type { AddonMarketItem } from "@/app/server/actions/addons";
import { useEnableAddon } from "@/lib/query/use-addons-query";

/** Builds the form's default values from the add-on's fields (existing install wins). */
function initialValues(item: AddonMarketItem): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const f of item.fields) {
		out[f.key] = item.install?.values?.[f.key] ?? f.default;
	}
	return out;
}

/**
 * The configure sheet. Controlled by the parent (open/onOpenChange) so a single sheet serves
 * whichever add-on the user is enabling. `item` null-guards the closed state.
 */
export function ConfigureSheet({
	item,
	projectId,
	environmentId,
	open,
	onOpenChange,
}: {
	item: AddonMarketItem | null;
	projectId: string;
	environmentId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const enable = useEnableAddon(projectId, environmentId);
	const form = useForm<Record<string, unknown>>({
		values: item ? initialValues(item) : {},
	});

	if (!item) return null;
	const isInstalled = item.install !== null;

	const onSubmit = form.handleSubmit(async (values) => {
		try {
			await enable.mutateAsync({
				projectId,
				environmentId,
				addonId: item.id,
				mode: "managed",
				values,
			});
			toast.success(
				isInstalled
					? `${item.name} updated — Deploy to apply`
					: `${item.name} enabled — Deploy to install`,
			);
			onOpenChange(false);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save add-on");
		}
	});

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex w-full flex-col sm:max-w-md">
				<SheetHeader>
					<SheetTitle>
						{isInstalled ? "Configure" : "Enable"} {item.name}
					</SheetTitle>
					<SheetDescription>
						{item.summary} Installs the <code>{item.chart}</code> chart into{" "}
						<code>{item.namespace}</code>. Applies on your next Deploy.
					</SheetDescription>
				</SheetHeader>

				<form
					onSubmit={onSubmit}
					className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4"
				>
					<div className="space-y-5 py-2">
						{item.fields.length === 0 && (
							<p className="text-sm text-muted-foreground">
								No configuration needed — this add-on installs with sensible
								defaults.
							</p>
						)}
						{item.fields.map((f) => (
							<div key={f.key} className="space-y-2">
								{f.type === "boolean" ? (
									<div className="flex items-center justify-between">
										<Label htmlFor={f.key}>{f.label}</Label>
										<Switch
											id={f.key}
											defaultChecked={Boolean(
												item.install?.values?.[f.key] ?? f.default,
											)}
											onCheckedChange={(v) => form.setValue(f.key, v)}
										/>
									</div>
								) : (
									<>
										<Label htmlFor={f.key}>{f.label}</Label>
										<Input
											id={f.key}
											type={f.type === "number" ? "number" : "text"}
											min={f.min}
											max={f.max}
											{...form.register(
												f.key,
												f.type === "number" ? { valueAsNumber: true } : {},
											)}
										/>
									</>
								)}
								{f.help && (
									<p className="text-xs text-muted-foreground">{f.help}</p>
								)}
							</div>
						))}
					</div>

					<SheetFooter className="mt-auto flex-row justify-end gap-2 px-0">
						<SheetClose asChild>
							<Button type="button" variant="ghost">
								Cancel
							</Button>
						</SheetClose>
						<Button type="submit" disabled={enable.isPending}>
							{enable.isPending
								? "Saving…"
								: isInstalled
									? "Save changes"
									: "Enable add-on"}
						</Button>
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
	);
}
