// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// THE `e2e-run` SWEEP HANDLE (#5096).
//
// Every e2e sweeper and the orphan reaper found a run's cloud resources by `alethia:project-id`
// (`alethia_project-id` on the label clouds), which packages/core/cloud/tags.go emits from
// ProjectConfig.ID. The seeded paths below build that config themselves and set the ID to
// `e2e-<ENV>`. The `cli-demo` dimension does not: the CONSOLE builds its config from a project the
// CLI created, so the ID is a UUID, and a leaked CLI-created stack was invisible to every sweeper.
//
// The maintainer's ruling (option 1) is a classification dimension, because classification is a
// real product input — a governed org taxonomy the console snapshots into the job and tags.go
// stamps onto every resource as `alethia:<dimension>` — so nothing e2e-specific reaches the product:
//
//   - cli-demo: the seed step defines the `e2e-run` dimension in the org with this run's value
//     (apps/console/scripts/seed-cli-demo-token.mts), and the `classify` beat assigns it through the
//     real binary (`alethia classification assign project <id> e2e-run <value>`).
//   - the seeded paths: the value goes straight into the snapshot's `classification` map, which is
//     where the console would have put it.
//
// The sweepers then accept EITHER handle (scripts/e2e/lib/scope-key.sh), so the stacks standing
// from before this change — which carry only project-id — stay visible.

// e2eRunDimension is the classification dimension key. It is also the name segment of the tag the
// sweepers select on (`alethia:e2e-run` / `alethia_e2e-run`), which packages/core/cloud pins.
const e2eRunDimension = "e2e-run"

// e2eRunValue is the dimension's value for one run: `e2e-<ENV>`, the same value the seeded path's
// project-id handle has always carried, so an in-run sweep keyed on either handle takes one ENV.
// In CI ENV is `<run_id>-<attempt>`, which is the only shape the preflight discovery accepts for
// this handle — an org can define an `e2e-run` dimension of its own, so `e2e-` alone is not enough
// there. It is a valid classification slug (lowercase, single `-` separators) for any such ENV.
func e2eRunValue(env string) string { return "e2e-" + env }

// e2eRunClassification is the snapshot `classification` map a seeded run carries: the frozen
// `{dimension_key: [value_slug]}` shape resolveClassificationSnapshot produces in the console.
func e2eRunClassification(env string) map[string][]string {
	return map[string][]string{e2eRunDimension: {e2eRunValue(env)}}
}
