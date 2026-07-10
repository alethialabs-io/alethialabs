// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// HTTPBackendConfig selects OpenTofu's `http` state backend pointed at the
// console's per-job tofu-state proxy (apps/console/app/api/jobs/[id]/state).
//
// Unlike the s3 backend it carries NO storage credentials: the console derives
// the state object key server-side from the job row and authorizes the request
// with a per-job state token presented as the HTTP Basic password. The token is
// published to the child `tofu` via the process env (TF_HTTP_PASSWORD), never
// written into the workdir — the Step-3 container mounts the workdir, so a
// creds-bearing backend.hcl there would hand the token to untrusted code.
type HTTPBackendConfig struct {
	// ConsoleURL is the control-plane origin (e.g. https://console.alethialabs.io),
	// WITHOUT the /api suffix; the route paths are appended to it.
	ConsoleURL string
	// JobID is the provisioning job the state proxy authorizes against.
	JobID string
	// Token is the per-job state token (console-minted, HS256). Presented as the
	// HTTP Basic password via TF_HTTP_PASSWORD; never written to disk.
	Token string
}

// stateAddress returns the backend's read/update/delete endpoint.
func (c *HTTPBackendConfig) stateAddress() string {
	return fmt.Sprintf("%s/api/jobs/%s/state", strings.TrimRight(c.ConsoleURL, "/"), c.JobID)
}

// WriteBackendHCL writes a backend.hcl for `tofu init -backend-config=<file>`
// selecting the console http proxy. It writes NO secrets — the state token
// travels via TF_HTTP_PASSWORD (see SetAuthEnv). App Router cannot export the
// LOCK/UNLOCK verbs, so locking uses POST/DELETE against a separate lock address.
func (c *HTTPBackendConfig) WriteBackendHCL(dir string) (string, error) {
	addr := c.stateAddress()
	lockAddr := addr + "/lock"
	content := fmt.Sprintf(`address        = %q
lock_address   = %q
unlock_address = %q
lock_method    = "POST"
unlock_method  = "DELETE"
`, addr, lockAddr, lockAddr)

	path := filepath.Join(dir, "backend.hcl")
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		return "", fmt.Errorf("failed to write backend.hcl: %w", err)
	}
	return path, nil
}

// SetAuthEnv publishes the state token to the child `tofu` process via
// TF_HTTP_USERNAME/TF_HTTP_PASSWORD — the http backend reads these for every
// backend call (read, lock, update, unlock), so they must stay set across
// init+plan+apply. It returns a restore func that puts the previous values back.
//
// Setting process-global env is safe because a managed runner executes one job
// at a time (SLOTS=1); this mirrors the suspend/restore AWS-cred dance the s3
// backend used, and the child inherits os.Environ() at exec (NOT tfexec.SetEnv,
// see packages/core/tofu/tofu.go).
func (c *HTTPBackendConfig) SetAuthEnv() func() {
	prevUser, hadUser := os.LookupEnv("TF_HTTP_USERNAME")
	prevPass, hadPass := os.LookupEnv("TF_HTTP_PASSWORD")
	_ = os.Setenv("TF_HTTP_USERNAME", "alethia")
	_ = os.Setenv("TF_HTTP_PASSWORD", c.Token)
	return func() {
		restore := func(key, prev string, had bool) {
			if had {
				_ = os.Setenv(key, prev)
			} else {
				_ = os.Unsetenv(key)
			}
		}
		restore("TF_HTTP_USERNAME", prevUser, hadUser)
		restore("TF_HTTP_PASSWORD", prevPass, hadPass)
	}
}
