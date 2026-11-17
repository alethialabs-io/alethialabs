"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The engine's two links to the page around it: the App Router, behind `WizardLocation`, and
// the signed-in viewer. This is the only file in `lib/wizard/` that imports `next/navigation`,
// which is what keeps the engine a file move away from a package.

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useViewer } from "@/components/providers/viewer-provider";
import {
	hrefWithParamPatch,
	isWizardOpenInUrl,
	STEP_PARAM,
	WIZARD_PARAM,
} from "@/lib/query/view-url-params";
import type { WizardEnvironment, WizardLocation } from "@/lib/wizard/types";

/** Whether an overlay wizard is open, and how to open or close it. */
export interface WizardOpener {
	readonly open: boolean;
	readonly setOpen: (open: boolean) => void;
}

/**
 * The environment of a wizard on a console page: the URL through the App Router, and the viewer.
 * Step changes keep the scroll position; a param the patch does not name is left as it is.
 */
export function useWizardEnvironment(): WizardEnvironment {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const { viewer, isPending } = useViewer();
	const search = searchParams.toString();
	const location: WizardLocation = {
		read: (name) => searchParams.get(name),
		push: (patch) => router.push(hrefWithParamPatch(pathname, search, patch), { scroll: false }),
		replace: (patch) =>
			router.replace(hrefWithParamPatch(pathname, search, patch), { scroll: false }),
		leave: (path) => router.replace(path),
	};
	return { location, viewerId: viewer !== null ? viewer.id : isPending ? undefined : null };
}

/**
 * The open state of overlay wizard `id`, derived from `?wizard=`. Opening and closing are the
 * user's intent, so each is a history entry: Back closes what a click opened.
 */
export function wizardOpener(location: WizardLocation, id: string): WizardOpener {
	const open = isWizardOpenInUrl({ get: (name) => location.read(name) }, id);
	return {
		open,
		setOpen: (next) => {
			if (next === open) return;
			location.push(next ? { [WIZARD_PARAM]: id } : { [WIZARD_PARAM]: null, [STEP_PARAM]: null });
		},
	};
}

/** The open state of overlay wizard `id` on a console page. */
export function useWizardOpener(id: string): WizardOpener {
	return wizardOpener(useWizardEnvironment().location, id);
}
