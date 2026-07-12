// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"io"
	"log/slog"
	"os"
	"regexp"
	"strings"
)

// traceparentRe matches a W3C version-00 traceparent, capturing the 32-hex trace-id.
var traceparentRe = regexp.MustCompile(`^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$`)

// traceIDFromTraceparent extracts the 32-hex trace-id from a traceparent, or "" if
// the string isn't a well-formed version-00 traceparent. Attached to logs as trace_id.
func traceIDFromTraceparent(traceparent string) string {
	m := traceparentRe.FindStringSubmatch(traceparent)
	if m == nil {
		return ""
	}
	return m[1]
}

// Structured operational logging for the runner, built on the stdlib log/slog (no
// third-party dep, matching the runner's stdlib-preferring posture). Emits one JSON
// object per line to stderr with the correlation keys (runner_id / trace_id / job_id)
// so a runner log joins the console logs + spans for the same W3C trace.

// baseLogger carries no correlation ids — the root every child derives from.
var baseLogger = newAgentLogger(os.Stderr, parseLevel(os.Getenv("ALETHIA_LOG_LEVEL")))

// agentLogger is the process-wide operational logger (JSON → stderr) with runner_id
// bound (after InitAgentLogger). Job-less loops (heartbeat / claim / wake) log
// through it directly; per-job code derives a child with LogWith.
var agentLogger = baseLogger

// parseLevel maps an ALETHIA_LOG_LEVEL string to a slog.Level (default info).
func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// newAgentLogger builds a JSON slog logger writing to w at the given level. Split
// out so tests can capture output into a buffer.
func newAgentLogger(w io.Writer, level slog.Level) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level}))
}

// InitAgentLogger binds runner_id onto the process-wide logger so every job-less
// operational line carries it. Called once at runner start.
func InitAgentLogger(runnerID string) {
	if runnerID != "" {
		agentLogger = baseLogger.With("runner_id", runnerID)
	}
}

// Log returns the process-wide operational logger (runner_id already bound). Use it
// for job-less lines (heartbeat / claim / wake reconnect).
func Log() *slog.Logger { return agentLogger }

// LogWith returns a child logger carrying the correlation ids for a job's lifetime.
// Empty ids are omitted. Derived from the id-less base so runner_id isn't duplicated.
func LogWith(runnerID, traceID, jobID string) *slog.Logger {
	l := baseLogger
	if runnerID != "" {
		l = l.With("runner_id", runnerID)
	}
	if traceID != "" {
		l = l.With("trace_id", traceID)
	}
	if jobID != "" {
		l = l.With("job_id", jobID)
	}
	return l
}
