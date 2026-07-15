// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
)

// executeStateSurgery is the runner-side handler for a break-glass STATE_SURGERY job — a privileged,
// two-person-approved, fully-audited repair of a corrupt/stranded tofu state, queued (by the console
// break-glass surface) through the NORMAL job pipeline so it flows over claim_next_job → the
// tofu-state lock/backend and state fencing stays intact (never a raw state UPDATE).
//
// STILL FAIL-CLOSED. It refuses unless the runner opts in via ALETHIA_BREAKGLASS_STATE_SURGERY_ENABLED,
// and even then it implements exactly ONE operation: `import`. Every other operation is still refused
// as unimplemented, so this does NOT open a general state-mutation surface — the safety posture of the
// original inert executor is preserved. What changes is that the ONE repair that cannot destroy
// anything is now available, instead of leaving operators with no way out at all.
//
// WHY `import` IS WORTH ARMING (issue #526).
// A failed apply can leave a real cloud resource OUTSIDE tofu state: the cloud accepts the create,
// then fails it asynchronously, so tofu's create errors and never records it. The environment is then
// PERMANENTLY WEDGED — every later apply dies with `already exists ... needs to be imported`, and on
// real Azure even `destroy` failed ("the Resource Group still contains Resources"). The only exit was
// hand-surgery in the cloud console.
//
// Import is uniquely SAFE here: it only brings an EXISTING resource under management, and can destroy
// nothing. Contrast the pre-existing `orphan_clean` break-glass action — a cross-cloud FORCE-DESTROY
// (shipped inert) aimed at leftovers of an environment that is already GONE; pointed at a LIVE
// environment it could delete a customer's database. It is the wrong shape for this and stays inert.
// Import is also, literally, the remedy the provider names in its own error message.
//
// The (address, cloud id) pair comes from the failed apply itself — provisioner.ClassifyApplyError
// records it on the job's orphan_risk metadata — so the operator CONFIRMS a repair we already
// diagnosed, rather than hand-typing state surgery.
func (w *Runner) executeStateSurgery(ctx context.Context, job *Job, stdout, stderr *JobLogger) error {
	stateKey, _ := job.ConfigSnapshot["state_key"].(string)
	operation, _ := job.ConfigSnapshot["operation"].(string)
	fmt.Fprintf(stdout, "break-glass STATE_SURGERY requested for %q (operation=%q)\n", stateKey, operation)

	if os.Getenv("ALETHIA_BREAKGLASS_STATE_SURGERY_ENABLED") != "true" {
		return fmt.Errorf(
			"state surgery executor is INERT (fail-closed): this runner has not set ALETHIA_BREAKGLASS_STATE_SURGERY_ENABLED — no state was touched")
	}

	if operation != "import" {
		// Everything except the proven, non-destructive import remains unimplemented on purpose.
		return fmt.Errorf(
			"state surgery operation %q is not implemented — only \"import\" is armed (it is the one repair that cannot destroy anything); refusing to mutate tofu state through an unproven path (no state was touched)",
			operation)
	}

	address, _ := job.ConfigSnapshot["resource_address"].(string)
	cloudID, _ := job.ConfigSnapshot["resource_id"].(string)
	if address == "" || cloudID == "" {
		return fmt.Errorf(
			"state surgery import requires resource_address and resource_id — the orphan pair recorded on the failed deploy's orphan_risk metadata; got address=%q id=%q (no state was touched)",
			address, cloudID)
	}

	vc, err := snapshotToProjectConfig(job.ConfigSnapshot)
	if err != nil {
		return fmt.Errorf("failed to parse config snapshot: %w", err)
	}
	provider := vc.Provider
	if provider == "" {
		provider = "aws"
	}

	// Same http state backend as deploy/drift ⇒ the import takes the state lock and fencing holds.
	stateBackend, err := w.stateBackend(job.ID)
	if err != nil {
		return err
	}

	res, err := provisioner.RunStateImport(ctx, provisioner.ImportParams{
		ProjectConfig: vc,
		Provider:      provider,
		TemplatesDir:  filepath.Join(resolveProjectTemplatesDir(), provider),
		CategoriesDir: resolveCategoriesTemplatesDir(),
		StateBackend:  stateBackend,
		Address:       address,
		CloudID:       cloudID,
		Stdout:        stdout,
		Stderr:        stderr,
	})
	if err != nil {
		return err
	}

	fmt.Fprintf(stdout,
		"STATE_SURGERY import complete: %s is now tracked in state (imported=%v). The environment is no longer wedged — the next plan/apply can manage this resource normally.\n",
		res.Address, res.Imported)
	return nil
}
