// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !linux

package e2e

import "syscall"

// helperTofuSysProcAttr models the LINUX terraform-exec (the nightly's platform) off Linux too: tofu
// leads its own process group, so a signal to the runner's group does not reach it. Pdeathsig has
// no equivalent here, which is why startHelperRunner's cleanup kills tofu's group itself.
func helperTofuSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}
