// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package mcp

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Result is what one command run printed and how it ended.
type Result struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
	// Truncated reports that stdout or stderr went past its limit and was cut.
	Truncated bool
}

// Runner runs one CLI command line (without the program name) and reports what it printed.
type Runner interface {
	Run(ctx context.Context, argv []string) (Result, error)
}

// The limits on what a run may print. A tool result is read by a model with a bounded context, and
// a command that prints without end must not take the server's memory with it.
const (
	maxStdout = 4 << 20
	maxStderr = 256 << 10
)

// childEnvDrop are the environment variables the child does not inherit. The debug switch would add
// request diagnostics to what the agent reads; the server decides the agent switch itself.
var childEnvDrop = []string{"ALETHIA_DEBUG", "ALETHIA_AGENT"}

// ExecRunner runs commands as child processes of an executable: in production, this same binary.
type ExecRunner struct {
	// Path is the executable to run.
	Path string
	// Dir is the working directory of the child; empty is the server's own, which is where the MCP
	// client started it (normally the project directory, where alethia.yaml is).
	Dir string
	// Environ is the environment the child starts from; nil is the server's own.
	Environ []string
}

// Run runs argv in agent mode, with no standard input, and waits for it or for ctx.
//
// The child inherits the server's environment, so it reads the credential the CLI already holds
// (the system keychain, the credential file, or ALETHIA_TOKEN set in the client's server
// configuration) — the server itself never reads it, and no tool argument can carry one.
func (r ExecRunner) Run(ctx context.Context, argv []string) (Result, error) {
	cmd := exec.CommandContext(ctx, r.Path, argv...)
	cmd.Dir = r.Dir
	cmd.Env = childEnv(r.Environ)
	// Nil stdin is the null device: nothing can prompt, and nothing the agent sends on the server's
	// stdin reaches the child.
	cmd.Stdin = nil
	stdout := &limitedBuffer{max: maxStdout}
	stderr := &limitedBuffer{max: maxStderr}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	// A child that ignores the kill's grace period is not waited on for ever.
	cmd.WaitDelay = 5 * time.Second

	err := cmd.Run()
	res := Result{Stdout: stdout.Bytes(), Stderr: stderr.Bytes(), Truncated: stdout.cut || stderr.cut}
	if err == nil {
		return res, nil
	}
	if ctx.Err() != nil {
		return res, ctx.Err()
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		res.ExitCode = exitErr.ExitCode()
		return res, nil
	}
	return res, err
}

// childEnv returns the child's environment: base (or the server's own) without childEnvDrop, in
// agent mode.
func childEnv(base []string) []string {
	if base == nil {
		base = os.Environ()
	}
	out := make([]string, 0, len(base)+1)
	for _, kv := range base {
		name, _, _ := strings.Cut(kv, "=")
		drop := false
		for _, d := range childEnvDrop {
			if name == d {
				drop = true
				break
			}
		}
		if !drop {
			out = append(out, kv)
		}
	}
	return append(out, "ALETHIA_AGENT=yes")
}

// limitedBuffer keeps the first max bytes written to it and discards the rest, without failing the
// write (a failed write would kill the child with a broken pipe and hide its exit code).
type limitedBuffer struct {
	buf bytes.Buffer
	max int
	cut bool
}

// Write keeps what fits and reports every byte as written.
func (b *limitedBuffer) Write(p []byte) (int, error) {
	room := b.max - b.buf.Len()
	if room <= 0 {
		b.cut = b.cut || len(p) > 0
		return len(p), nil
	}
	if len(p) > room {
		b.buf.Write(p[:room])
		b.cut = true
		return len(p), nil
	}
	b.buf.Write(p)
	return len(p), nil
}

// Bytes returns what was kept.
func (b *limitedBuffer) Bytes() []byte { return b.buf.Bytes() }
