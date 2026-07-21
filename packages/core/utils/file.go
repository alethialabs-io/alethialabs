// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package utils

import "os"

// SecretFileMode is the permission mode for files that hold secret material at rest — tfvars with
// decrypted connector credentials, rendered kubeconfigs, tofu state, plan JSON. Owner read/write
// only (0600); never group/world readable. On a shared or self-hosted runner host a world-readable
// (0644) secret file lets any other local uid read long-lived third-party credentials.
const SecretFileMode os.FileMode = 0o600

// WriteSecretFile writes secret-bearing data to path with owner-only (0600) permissions. Use it for
// anything that may contain credentials, tokens, or state at rest instead of a bare os.WriteFile
// with a world-readable mode — it codifies the 0600 discipline the codebase already applies to
// kubeconfigs so every secret-bearing write stays consistent.
func WriteSecretFile(path string, data []byte) error {
	return os.WriteFile(path, data, SecretFileMode)
}
