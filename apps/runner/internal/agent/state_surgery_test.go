// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"strings"
	"testing"
)

// STATE_SURGERY is a privileged state-mutation surface. Arming the `import` repair (issue #526) must
// NOT widen it. These tests pin the fail-closed posture: every guard must reject BEFORE any state is
// touched, and only "import" may ever proceed.

func surgeryJob(snapshot map[string]any) *Job {
	return &Job{ID: "job-1", ConfigSnapshot: snapshot}
}

// discardSender satisfies LogSender without going anywhere — these tests assert refusals, not logs.
type discardSender struct{}

func (discardSender) SendLog(_, _, _, _ string) error { return nil }

func newDiscardLogger() *JobLogger { return NewJobLogger(discardSender{}, "job-1", "STDOUT") }

// The opt-in gate is the outermost guard: a runner that never armed state surgery must refuse
// everything, including import.
func TestStateSurgery_RefusesWhenNotArmed(t *testing.T) {
	t.Setenv("ALETHIA_BREAKGLASS_STATE_SURGERY_ENABLED", "")

	w := &Runner{}
	err := w.executeStateSurgery(context.Background(), surgeryJob(map[string]any{
		"operation":        "import",
		"resource_address": "module.azure_cache[0].azurerm_managed_redis.this",
		"resource_id":      "/subscriptions/x/redis/r",
	}), newDiscardLogger(), newDiscardLogger())

	if err == nil {
		t.Fatal("an un-armed runner must refuse state surgery")
	}
	if !strings.Contains(err.Error(), "INERT") || !strings.Contains(err.Error(), "no state was touched") {
		t.Errorf("refusal must be explicit that nothing was mutated; got: %v", err)
	}
}

// Arming the runner must arm ONLY import — every other operation stays unimplemented, so this does
// not become a general state-mutation surface.
func TestStateSurgery_ArmedButOnlyImportIsImplemented(t *testing.T) {
	t.Setenv("ALETHIA_BREAKGLASS_STATE_SURGERY_ENABLED", "true")

	for _, op := range []string{"", "rm", "mv", "replace-provider", "push"} {
		t.Run("operation="+op, func(t *testing.T) {
			w := &Runner{}
			err := w.executeStateSurgery(context.Background(), surgeryJob(map[string]any{
				"operation": op,
			}), newDiscardLogger(), newDiscardLogger())

			if err == nil {
				t.Fatalf("operation %q must NOT be implemented — only import is armed", op)
			}
			if !strings.Contains(err.Error(), "not implemented") || !strings.Contains(err.Error(), "no state was touched") {
				t.Errorf("refusal must be explicit that nothing was mutated; got: %v", err)
			}
		})
	}
}

// An import with a missing half of the orphan pair is unusable — refuse before touching state rather
// than attempting a partial repair.
func TestStateSurgery_ImportRequiresTheOrphanPair(t *testing.T) {
	t.Setenv("ALETHIA_BREAKGLASS_STATE_SURGERY_ENABLED", "true")

	cases := []map[string]any{
		{"operation": "import"},                                            // neither
		{"operation": "import", "resource_address": "module.a.b"},          // no id
		{"operation": "import", "resource_id": "/subscriptions/x/redis/r"}, // no address
		{"operation": "import", "resource_address": "", "resource_id": ""}, // empty
	}
	for _, snap := range cases {
		w := &Runner{}
		err := w.executeStateSurgery(context.Background(), surgeryJob(snap), newDiscardLogger(), newDiscardLogger())
		if err == nil {
			t.Fatalf("import without a complete (address, id) pair must be refused; snapshot=%v", snap)
		}
		if !strings.Contains(err.Error(), "no state was touched") {
			t.Errorf("refusal must be explicit that nothing was mutated; got: %v", err)
		}
	}
}
