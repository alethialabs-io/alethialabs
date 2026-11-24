// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build windows

package tofu

import "os/exec"

// setOwnProcessGroup is a no-op on Windows, where there is no graceful interrupt to protect.
func setOwnProcessGroup(*exec.Cmd) {}

// killProcessGroup kills the tofu process; Windows has no SIGINT, so a cancel is a kill.
func killProcessGroup(cmd *exec.Cmd) { _ = cmd.Process.Kill() }
