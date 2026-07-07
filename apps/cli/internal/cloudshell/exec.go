// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package cloudshell drives the cloud providers' own tooling on the user's
// behalf: Google Cloud Shell for GCP (remote), and the locally installed
// aws/az CLIs for AWS/Azure. It runs the embedded connector installers and
// captures the credentials they emit.
package cloudshell

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

var (
	// ErrGcloudNotFound is returned when the gcloud CLI is not on PATH.
	ErrGcloudNotFound = errors.New("gcloud CLI not found on PATH")
	// ErrGcloudNotAuthed is returned when gcloud has no active credentials.
	ErrGcloudNotAuthed = errors.New("gcloud is not authenticated")
	// ErrAwsNotFound is returned when the aws CLI is not on PATH.
	ErrAwsNotFound = errors.New("aws CLI not found on PATH")
	// ErrAzNotFound is returned when the az CLI is not on PATH.
	ErrAzNotFound = errors.New("az CLI not found on PATH")
)

// runStreaming runs a command, mirroring its combined output to stdout while
// capturing it, and returns everything it printed.
func runStreaming(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	var buf bytes.Buffer
	mw := io.MultiWriter(os.Stdout, &buf)
	cmd.Stdout = mw
	cmd.Stderr = mw
	cmd.Stdin = os.Stdin
	err := cmd.Run()
	return buf.String(), err
}

// runCapture runs a command capturing only stdout, for queries.
func runCapture(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errBuf.String())
		if msg == "" {
			return "", err
		}
		return "", fmt.Errorf("%s", msg)
	}
	return strings.TrimSpace(out.String()), nil
}

// have reports whether a tool is available on PATH.
func have(tool string) bool {
	_, err := exec.LookPath(tool)
	return err == nil
}

// extractBetweenMarkers returns the text between the installer's START/END
// CONFIG markers, ignoring the rest of the (noisy) command output.
func extractBetweenMarkers(output string) (string, bool) {
	const startMarker = "--- START CONFIG"
	const endMarker = "--- END CONFIG ---"

	start := strings.Index(output, startMarker)
	if start == -1 {
		return "", false
	}
	nl := strings.IndexByte(output[start:], '\n')
	if nl == -1 {
		return "", false
	}
	contentStart := start + nl + 1

	end := strings.Index(output[contentStart:], endMarker)
	if end == -1 {
		return "", false
	}
	return strings.TrimSpace(output[contentStart : contentStart+end]), true
}

// shellQuote single-quotes a string for safe interpolation into a remote shell
// command.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
