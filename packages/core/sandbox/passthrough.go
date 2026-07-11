// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package sandbox

import (
	"context"
	"fmt"
)

// Passthrough runs the Job in-process with the host's full environment — i.e. NO
// isolation. It reproduces today's behavior exactly and is the default backend until
// an isolating backend is proven. Because it is fail-OPEN, it is deliberately loud
// (emits a per-job warning) and can be made to REFUSE on any non-self runner — where
// untrusted BYO code will eventually run and real isolation is mandatory — by setting
// EnforceManaged once a real backend is available. EnforceManaged is left false today
// so existing managed provisioning (trusted templates only) is unaffected.
type Passthrough struct {
	// Operator is the runner operator ("managed" | "self"); consulted by EnforceManaged.
	Operator string
	// EnforceManaged, when true, makes Run FAIL on any runner that is not an explicit
	// self operator, instead of silently running unsandboxed. Flip this on the day an
	// isolating backend ships, so a mis-configuration can never silently downgrade a
	// managed (or mis-set) runner to no isolation.
	EnforceManaged bool
}

// Run executes job in-process. It warns (via spec.Warn) that isolation is disabled and,
// when EnforceManaged is set, refuses rather than running unsandboxed UNLESS the operator
// is an explicit "self" (customer's own cloud + creds = their risk boundary). The check is
// fail-CLOSED against the operator string: only "self" is lenient, so an empty/miscased/
// unknown operator ("", "Managed", typo) refuses instead of running untrusted tofu in-process
// on a platform-account runner. Trusted (non-BYO) self-runner template provisioning still
// runs — EnforceManaged never refuses a self operator; and when EnforceManaged is false
// (today's default) Run never refuses at all, so trusted managed provisioning is unaffected.
func (p Passthrough) Run(ctx context.Context, spec Spec, job Job) error {
	msg := fmt.Sprintf(
		"job isolation DISABLED (PassthroughSandbox): running %q job %s in-process with the full host environment — safe only for trusted (non-BYO) work",
		spec.Kind, spec.JobID,
	)
	if spec.Warn != nil {
		spec.Warn(msg)
	}
	if p.EnforceManaged && p.Operator != "self" {
		return fmt.Errorf(
			"refusing to run %q job %s unsandboxed on a non-self runner (operator=%q): no isolation backend is configured",
			spec.Kind, spec.JobID, p.Operator,
		)
	}
	return job(ctx)
}

var _ Sandbox = Passthrough{}
