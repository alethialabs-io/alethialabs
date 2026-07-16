// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useState } from "react";

/**
 * Debounce a rapidly-changing value (a search input) before it drives a query.
 * Extracted from the roles/sso/classification managers, which each carried an
 * identical local copy — the console filter standard's debounce step.
 */
export function useDebouncedValue<T>(value: T, delay = 250): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setDebounced(value), delay);
		return () => clearTimeout(t);
	}, [value, delay]);
	return debounced;
}
