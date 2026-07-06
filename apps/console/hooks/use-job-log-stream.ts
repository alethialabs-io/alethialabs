// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useState } from "react";

export interface JobLogEntry {
	id: number;
	log_chunk: string;
	stream_type: string | null;
	created_at: string;
}

/**
 * Streams a job's logs over SSE (/api/stream/jobs/:id). The server sends the backlog on connect; the
 * browser's EventSource auto-reconnects and resumes from the last id (Last-Event-ID).
 */
export function useJobLogStream(jobId: string | null): { logs: JobLogEntry[] } {
	const [logs, setLogs] = useState<JobLogEntry[]>([]);

	useEffect(() => {
		setLogs([]);
		if (!jobId) return;

		const es = new EventSource(`/api/stream/jobs/${jobId}`);
		es.onmessage = (e) => {
			let row: JobLogEntry;
			try {
				row = JSON.parse(e.data);
			} catch {
				return;
			}
			setLogs((prev) =>
				prev.some((l) => l.id === row.id) ? prev : [...prev, row],
			);
		};
		// On error EventSource auto-reconnects and resumes via Last-Event-ID.
		es.onerror = () => {};

		return () => es.close();
	}, [jobId]);

	return { logs };
}
