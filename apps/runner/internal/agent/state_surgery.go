// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"os"
)

// executeStateSurgery is the runner-side handler for a break-glass STATE_SURGERY job — a privileged,
// two-person-approved, fully-audited repair of a corrupt/stranded tofu state, queued (by the console
// break-glass surface) through the NORMAL job pipeline so it flows over claim_next_job → the
// tofu-state lock/backend and state fencing stays intact (never a raw state UPDATE).
//
// It ships INERT (fail-closed): a real state-surgery executor is a safety-critical, unproven surface,
// so this handler performs NO state mutation. Unless a runner explicitly opts in via
// ALETHIA_BREAKGLASS_STATE_SURGERY_ENABLED, it refuses immediately; and even when opted in, it still
// refuses with "not implemented" rather than mutating state through an unproven path. This keeps the
// end-to-end capability (audited + two-person ENQUEUE, pipeline routing, fencing) exercisable while
// guaranteeing no state is ever changed by an unproven executor. Enqueuing such a job therefore
// results in a clean FAILED job, which is the intended fail-closed behavior.
func (w *Runner) executeStateSurgery(_ context.Context, job *Job, stdout, _ *JobLogger) error {
	stateKey, _ := job.ConfigSnapshot["state_key"].(string)
	fmt.Fprintf(stdout, "break-glass STATE_SURGERY requested for %q\n", stateKey)

	if os.Getenv("ALETHIA_BREAKGLASS_STATE_SURGERY_ENABLED") != "true" {
		return fmt.Errorf(
			"state surgery executor is INERT (fail-closed): this runner has not set ALETHIA_BREAKGLASS_STATE_SURGERY_ENABLED — no state was touched")
	}
	// Armed but deliberately unimplemented: refuse rather than mutate state through an unproven path.
	return fmt.Errorf(
		"state surgery executor is not implemented — refusing to mutate tofu state through an unproven path (no state was touched)")
}
