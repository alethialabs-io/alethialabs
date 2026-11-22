"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One cloud's connect form on the wizard engine, wired to the one server call that saves and
// verifies it. Every cloud's sheet body calls this with its own definition
// (`cloud-connect.wizard.ts`) and gets back the same flow, which `ConnectForm` renders.
//
// What it guarantees:
//   - ONE SERVER ROUND TRIP PER PRESS. Connect validates the form, then saves into the pending
//     identity — the one the host seeded, else a connect session started at that moment — and
//     verifies, through `useConnectionTest` (double submit ignored, board invalidated).
//     Opening the sheet starts nothing on the server: a person who looks and closes leaves no row.
//   - A RETRY SAVES INTO THE SAME IDENTITY. The identity a press used is kept for the next press.
//   - FIELD ERRORS GO TO THEIR FIELDS. The form's names are the server's, so a refusal naming
//     `roleArn` is shown under the role ARN; anything else is said above the button.
//   - SUCCESS IS HANDED BACK AT ONCE. A verified connect calls `session.onVerified` with the
//     identity id, before the person presses Done, so the screen behind can select the account.
//     The draft is cleared then too: what it held is now a connected account.

import { useEffect, useRef } from "react";
import type { DefaultValues, FieldValues } from "react-hook-form";
import { type CloudVerifyResult, connectCloudAccount } from "@/app/server/actions/identities";
import {
	type ConnTestState,
	useConnectionTest,
} from "@/components/connectors/use-connection-test";
import type { ActionResult } from "@/lib/actions/result";
import type { ConnectableCloudSlug } from "@/lib/cloud-providers/generated/catalog";
import { clearDraft } from "@/lib/wizard/draft";
import { useWizardEnvironment } from "@/lib/wizard/location";
import type { Wizard, WizardDefinition } from "@/lib/wizard/types";
import { useWizard } from "@/lib/wizard/use-wizard";

/** What `connectCloudAccount` takes. */
export type ConnectInput = Parameters<typeof connectCloudAccount>[0];

/** What the sheet hands every cloud's form: which cloud, where its draft lives, and the identity. */
export interface ConnectSession {
	readonly provider: ConnectableCloudSlug;
	/** The draft's scope: the org and the cloud. The engine prepends the viewer. */
	readonly scope: string;
	/** The pending identity to save into: the host's seed, or a connect session started now. */
	readonly identity: () => Promise<ActionResult<{ identityId: string }>>;
	/** A verified connect, with the identity it was saved to. */
	readonly onVerified: (identityId: string) => void;
	/** Leaves the sheet. `finished` is true after a verified connect. */
	readonly close: (finished: boolean) => void;
}

/** One cloud's connect form, running. */
export interface ConnectFlow<V extends FieldValues, TOut> {
	readonly wizard: Wizard<V, TOut>;
	/** Where the save-and-verify stands. */
	readonly state: ConnTestState;
	/** Validates the form and, when it passes, saves and verifies. */
	submit(): void;
	/** Returns to the form while a verify is in flight; a save already sent still lands. */
	cancel(): void;
	/** Leaves the sheet after a verified connect: clears the draft and the overlay's params. */
	done(): void;
}

/** What a cloud's form passes besides its definition. */
export interface ConnectWizardOptions<TOut> {
	readonly session: ConnectSession;
	/** Builds the server input from the parsed form and the identity to save into. */
	readonly toInput: (values: TOut, identityId: string) => ConnectInput;
}

/** Runs one cloud's connect form. See the header for what it guarantees. */
export function useConnectWizard<V extends FieldValues, TOut>(
	definition: WizardDefinition<V, TOut>,
	defaultValues: DefaultValues<V>,
	{ session, toInput }: ConnectWizardOptions<TOut>,
): ConnectFlow<V, TOut> {
	const { viewerId } = useWizardEnvironment();
	// The wizard calls this once every field passes; it is pointed at the latest render below.
	const save = useRef<(values: TOut) => void>(() => undefined);
	// The identity the last press saved into, so a retry does not start a second session.
	const identityId = useRef<string | null>(null);

	const wizard = useWizard<V, TOut>(definition, {
		defaultValues,
		scope: session.scope,
		onSubmit: (values) => save.current(values),
	});

	const test = useConnectionTest({
		onValidationError: (fields) => {
			const placed: Record<string, string[]> = {};
			for (const [name, messages] of Object.entries(fields)) {
				// The identity and the method are the sheet's, not the person's: said above the button.
				const key = name === "identityId" || name === "method" || name === "provider" ? "_form" : name;
				placed[key] = [...(placed[key] ?? []), ...(messages ?? [])];
			}
			wizard.applyFieldErrors(placed);
		},
		onVerified: (result: CloudVerifyResult) => {
			if (definition.draft !== null && typeof viewerId === "string") {
				clearDraft({ id: definition.id, viewerId, scope: session.scope });
			}
			session.onVerified(result.identityId);
		},
	});

	useEffect(() => {
		save.current = (values) =>
			test.run(
				async (): Promise<ActionResult<CloudVerifyResult>> => {
					let id = identityId.current;
					if (id === null) {
						const started = await session.identity();
						if (!started.ok) return { ok: false, error: started.error };
						id = started.data.identityId;
						identityId.current = id;
					}
					return connectCloudAccount(toInput(values, id));
				},
				{ provider: session.provider },
			);
	});

	return {
		wizard,
		state: test.state,
		submit: () => {
			if (test.state.phase === "saving" || test.state.phase === "success") return;
			void wizard.submit();
		},
		cancel: test.cancel,
		done: () => {
			wizard.complete();
			session.close(true);
		},
	};
}
