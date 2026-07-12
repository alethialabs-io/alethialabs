// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

// TestAgentLogger_EmitsJSONWithFields asserts the handler writes one JSON object per
// line carrying the message + structured fields.
func TestAgentLogger_EmitsJSONWithFields(t *testing.T) {
	var buf bytes.Buffer
	l := newAgentLogger(&buf, slog.LevelInfo)
	l.With("runner_id", "r-1").Info("claimed job", "job_type", "PLAN", "job_id", "j-9")

	var rec map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &rec); err != nil {
		t.Fatalf("log line is not valid JSON: %v (%q)", err, buf.String())
	}
	if rec["msg"] != "claimed job" {
		t.Errorf("msg = %v, want %q", rec["msg"], "claimed job")
	}
	if rec["runner_id"] != "r-1" || rec["job_type"] != "PLAN" || rec["job_id"] != "j-9" {
		t.Errorf("missing correlation fields: %v", rec)
	}
	if rec["level"] != "INFO" {
		t.Errorf("level = %v, want INFO", rec["level"])
	}
}

// TestAgentLogger_LevelGating asserts a logger at info drops debug lines.
func TestAgentLogger_LevelGating(t *testing.T) {
	var buf bytes.Buffer
	l := newAgentLogger(&buf, slog.LevelInfo)
	l.Debug("should be dropped")
	if buf.Len() != 0 {
		t.Errorf("debug line emitted at info level: %q", buf.String())
	}
	l.Info("should appear")
	if !strings.Contains(buf.String(), "should appear") {
		t.Errorf("info line missing: %q", buf.String())
	}
}

func TestParseLevel(t *testing.T) {
	cases := map[string]slog.Level{
		"debug": slog.LevelDebug,
		"DEBUG": slog.LevelDebug,
		"warn":  slog.LevelWarn,
		"error": slog.LevelError,
		"":      slog.LevelInfo,
		"bogus": slog.LevelInfo,
	}
	for in, want := range cases {
		if got := parseLevel(in); got != want {
			t.Errorf("parseLevel(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestTraceIDFromTraceparent(t *testing.T) {
	valid := "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	if got := traceIDFromTraceparent(valid); got != "0af7651916cd43dd8448eb211c80319c" {
		t.Errorf("trace-id = %q, want the 32-hex middle segment", got)
	}
	for _, bad := range []string{"", "not-a-traceparent", "00-short-b7ad6b7169203331-01"} {
		if got := traceIDFromTraceparent(bad); got != "" {
			t.Errorf("traceIDFromTraceparent(%q) = %q, want empty", bad, got)
		}
	}
}

// TestSystemLogger_ShipsSystemStreamWithTrace asserts the unified SYSTEM sink ships on
// the SYSTEM stream carrying the job's traceparent, preserving drain-on-Close.
func TestSystemLogger_ShipsSystemStreamWithTrace(t *testing.T) {
	sender := &mockLogSender{}
	tp := "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	sys := NewSystemLogger(sender, "job-7", tp)
	if _, err := sys.Write([]byte("heartbeat failed")); err != nil {
		t.Fatalf("write: %v", err)
	}
	sys.Close()

	if got := strings.Join(sender.chunks, ""); got != "heartbeat failed" {
		t.Errorf("chunk = %q, want %q", got, "heartbeat failed")
	}
	if len(sender.streams) == 0 || sender.streams[0] != "SYSTEM" {
		t.Errorf("stream = %v, want SYSTEM", sender.streams)
	}
	if len(sender.traceparents) == 0 || sender.traceparents[0] != tp {
		t.Errorf("traceparent = %v, want %q", sender.traceparents, tp)
	}
}

// TestJobLoggerWithTrace_CarriesTraceparent asserts the customer STDOUT stream carries
// the job's traceparent on shipped chunks (correlation without weakening the stream).
func TestJobLoggerWithTrace_CarriesTraceparent(t *testing.T) {
	sender := &mockLogSender{}
	tp := "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	jl := NewJobLoggerWithTrace(sender, "job-8", "STDOUT", tp)
	jl.Write([]byte("provisioning..."))
	jl.Close()

	if len(sender.streams) == 0 || sender.streams[0] != "STDOUT" {
		t.Errorf("stream = %v, want STDOUT", sender.streams)
	}
	if len(sender.traceparents) == 0 || sender.traceparents[0] != tp {
		t.Errorf("traceparent = %v, want %q", sender.traceparents, tp)
	}
}
