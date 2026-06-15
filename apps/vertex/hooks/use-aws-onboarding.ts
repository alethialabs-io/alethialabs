"use client";

import { hasCloudIdentity } from "@/app/server/actions/identities";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export function useAwsOnboarding() {
	const [showAwsAlert, setShowAwsAlert] = useState(false);
	const [isLoading, setIsLoading] = useState(true);
	const pathname = usePathname();

	useEffect(() => {
		const checkStatus = async () => {
			if (pathname?.includes("/dashboard/integrations") || pathname?.includes("/dashboard/providers")) {
				setIsLoading(false);
				return;
			}

			try {
				const hasIdentity = await hasCloudIdentity();

				if (!hasIdentity) {
					setShowAwsAlert(true);
				} else {
					setShowAwsAlert(false);
				}
			} catch (error) {
				console.error("Failed to check AWS status:", error);
			} finally {
				setIsLoading(false);
			}
		};

		checkStatus();
	}, [pathname]);

	return { showAwsAlert, setShowAwsAlert, isLoading };
}
