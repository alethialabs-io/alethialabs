// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"fmt"
	"sort"
	"strings"
)

// cliDemoRiderReason is why the three RIDER scenarios cannot run on the cli-demo dimension. Each one
// LAYERS onto the DEPLOY snapshot the harness seeds (keylessDBConfig.applyToSnapshot,
// secretsXacctConfig.applyToSnapshot, xacctRegistryConfig.applyToSnapshot): a database, a *-xacct
// connector row, a foreign-image service. On cli-demo the DEPLOY is created BY THE CLI and that
// snapshot is never written, so the runner renders none of it and the layer would poll a live,
// billed cluster for objects nobody pushed.
const cliDemoRiderReason = "the cli-demo DEPLOY is created by the CLI, so the seeded snapshot these " +
	"layer onto is never written — nothing they assert on would be rendered"

// cliDemoRiderDecision resolves the riders against the cli-demo dimension, before any spend.
//
//   - not cli-demo           → (nil, nil): the riders stand exactly as each decide() resolved them.
//   - cli-demo, riders OFF   → one NOT RUN note per rider, so a cli-demo run SAYS the riders were not
//     proven instead of saying nothing (e2e-nightly.yml withholds their variables on cli-demo, and a
//     withheld variable is otherwise indistinguishable from one nobody set — #2630's lesson).
//   - cli-demo, a rider ON   → an error naming it. Reachable only outside the workflow (which refuses
//     an explicit dispatch in the resolve job and withholds the variables): a local run that sets one.
//
// on maps each rider's display name to whether its decide() turned it on.
func cliDemoRiderDecision(cliDemo bool, on map[string]bool) (notes []string, err error) {
	if !cliDemo {
		return nil, nil
	}
	names := make([]string, 0, len(on))
	for name := range on {
		names = append(names, name)
	}
	sort.Strings(names)
	var enabled []string
	for _, name := range names {
		if on[name] {
			enabled = append(enabled, name)
			continue
		}
		notes = append(notes, fmt.Sprintf("%s NOT RUN on cli-demo — %s. It was NOT proven by this run; ride it on a floor or gitops night.", name, cliDemoRiderReason))
	}
	if len(enabled) > 0 {
		return notes, fmt.Errorf("cli-demo cannot carry %s: %s. Refusing before any spend", strings.Join(enabled, ", "), cliDemoRiderReason)
	}
	return notes, nil
}
