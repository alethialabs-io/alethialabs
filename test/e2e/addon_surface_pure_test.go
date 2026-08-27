// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR proof that the add-on surface the e2e seeds is the one the catalog SHIPS — no
// cloud, no build tag.
//
// The run-scoped debug overrides are the thing worth guarding here. An override mechanism that can
// rewrite add-on values is one edit away from a run that no longer proves the catalog at all, so
// the properties asserted are "unset changes nothing" and "an override never drops what the catalog
// already set".
package e2e

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// #2866's diagnostic override. falco crash-loops on Talos and its LAST log line is
// `Error: Initialization issues during scap_init` — #2895 proved the detail is not truncated but
// simply not emitted, because scap lives in falco's `libs` layer whose logger is off by default.
// The pinned chart's own values say libs_logger "is not recommended for production use", so it must
// not go in the catalog a customer installs; it is a run-scoped override instead.
func TestApplyAddOnDebugOverrides(t *testing.T) {
	base := func() []types.AddOnInstall {
		return []types.AddOnInstall{
			{ID: "falco", Values: map[string]interface{}{
				"falco":  map[string]interface{}{"json_output": false},
				"driver": map[string]interface{}{"kind": "auto"},
			}},
			{ID: "reloader", Values: map[string]interface{}{"reloader": map[string]interface{}{"watchGlobally": true}}},
		}
	}

	t.Run("unset changes nothing", func(t *testing.T) {
		t.Setenv(envAddOnDebugValues, "")
		got := applyAddOnDebugOverrides(base())
		f := got[0].Values["falco"].(map[string]interface{})
		if _, ok := f["libs_logger"]; ok {
			t.Error("libs_logger must not appear unless the run asks for it — the e2e proves the SHIPPED catalog")
		}
	})

	t.Run("an unnamed add-on is untouched", func(t *testing.T) {
		t.Setenv(envAddOnDebugValues, "falco")
		if got := applyAddOnDebugOverrides(base()); len(got[1].Values) != 1 {
			t.Errorf("reloader was modified: %+v", got[1].Values)
		}
	})

	t.Run("falco gets libs_logger WITHOUT losing its catalog values", func(t *testing.T) {
		// The load-bearing half: a shallow assignment on `falco` would drop `json_output`, and the
		// run would then prove a configuration the catalog does not ship.
		t.Setenv(envAddOnDebugValues, "falco")
		got := applyAddOnDebugOverrides(base())
		f := got[0].Values["falco"].(map[string]interface{})
		ll, ok := f["libs_logger"].(map[string]interface{})
		if !ok {
			t.Fatalf("libs_logger missing: %+v", got[0].Values)
		}
		if ll["enabled"] != true || ll["severity"] != "debug" {
			t.Errorf("libs_logger wrong: %+v", ll)
		}
		if _, kept := f["json_output"]; !kept {
			t.Error("the catalog's falco.json_output was dropped by the override")
		}
		if _, kept := got[0].Values["driver"]; !kept {
			t.Error("the catalog's driver values were dropped by the override")
		}
	})

	t.Run("an unknown id is accepted and does nothing", func(t *testing.T) {
		t.Setenv(envAddOnDebugValues, "reloader,nosuchaddon")
		if got := applyAddOnDebugOverrides(base()); len(got[1].Values) != 1 {
			t.Errorf("reloader gained values it has no override for: %+v", got[1].Values)
		}
	})

	t.Run("a nil Values map is created rather than panicking", func(t *testing.T) {
		t.Setenv(envAddOnDebugValues, "falco")
		if got := applyAddOnDebugOverrides([]types.AddOnInstall{{ID: "falco"}}); got[0].Values == nil {
			t.Fatal("Values still nil")
		}
	})
}
