// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package e2e

import "syscall"

// helperTofuSysProcAttr is exactly what terraform-exec sets on Linux (tfexec/cmd_linux.go): tofu
// leads its own process group and is SIGKILLed when the runner dies.
func helperTofuSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}
