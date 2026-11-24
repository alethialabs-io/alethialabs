// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !windows

package tofu

import (
	"os/exec"
	"syscall"
)

// setOwnProcessGroup starts the command in a process group of its own, as terraform-exec does, so
// an interrupt aimed at the runner's group (a terminal Ctrl-C) does not reach tofu a second time —
// tofu treats a second interrupt as "abort now, skip the state write".
func setOwnProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessGroup SIGKILLs the command's whole process group — tofu and the provider plugins it
// started — so a wedged apply cannot outlive the grace window through a plugin.
func killProcessGroup(cmd *exec.Cmd) {
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		_ = cmd.Process.Kill()
	}
}
