// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AwsConnection } from "@/components/onboarding/aws-connection";
import { SkipButton } from "@/components/onboarding/skip-button"; // New client component
import { redirect } from "next/navigation";
import { getAwsExternalId, saveAwsIdentity } from "../actions";

export default async function AwsOnboardingPage() {
	// 1. Get the External ID (Server Side)
	let setupData: { identityId: string; externalId: string };
	try {
		setupData = await getAwsExternalId();
	} catch (error) {
		console.error("Failed to init AWS setup:", error);
		return (
			<div className="flex items-center justify-center min-h-[400px] w-full">
				<div className="p-8 text-center text-destructive bg-destructive/5 border border-destructive/20 rounded-md max-w-md animate-in fade-in zoom-in-95 duration-300">
					<h3 className="text-sm font-semibold mb-2">Initialization Failed</h3>
					<p className="text-xs opacity-80">Failed to initialize AWS onboarding. Please try refreshing the page.</p>
				</div>
			</div>
		);
	}

	async function handleComplete(roleArn: string) {
		"use server";
		return saveAwsIdentity(setupData.identityId, roleArn);
	}

	return (
		<div className="flex flex-col items-center justify-center min-h-[calc(100vh-10rem)] w-full py-8 px-4 sm:px-6 lg:px-8 relative">
			{/* Improved Skip Button Positioning */}
			<div className="absolute top-0 right-4 sm:right-6 lg:right-8 pt-4">
				<SkipButton />
			</div>

			<div className="w-full flex justify-center animate-in fade-in slide-in-from-bottom-4 duration-700 delay-150">
				<AwsConnection
					externalId={setupData.externalId}
					onComplete={handleComplete}
				/>
			</div>
		</div>
	);
}
