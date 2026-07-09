// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// AddOnHealth is the ArgoCD Application status the console shows for a marketplace add-on.
// Health ∈ {Healthy, Progressing, Degraded, Suspended, Missing, Unknown}; Sync ∈ {Synced,
// OutOfSync, Unknown}. Mirrors the TS `AddOnStatusReport` written back to project_addons.
type AddOnHealth struct {
	Health string `json:"health"`
	Sync   string `json:"sync"`
}

// argoAppList is the trimmed shape of `kubectl get applications.argoproj.io -o json` we read.
type argoAppList struct {
	Items []struct {
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
		Status struct {
			Health struct {
				Status string `json:"status"`
			} `json:"health"`
			Sync struct {
				Status string `json:"status"`
			} `json:"sync"`
		} `json:"status"`
	} `json:"items"`
}

// ReadAddOnHealth reads the ArgoCD health + sync status for the given Application names by
// listing the Applications in the argocd namespace once and filtering. Best-effort: a read
// failure (kubectl/cluster hiccup) returns each requested name as Unknown rather than an
// error, so a status blip never fails a deploy. The same probe is reusable for a scheduled
// refresh and for the L4 "environment verified-healthy" signal.
func ReadAddOnHealth(names []string, stdout, stderr io.Writer) map[string]AddOnHealth {
	out := make(map[string]AddOnHealth, len(names))
	for _, n := range names {
		out[n] = AddOnHealth{Health: "Unknown", Sync: "Unknown"}
	}
	if len(names) == 0 {
		return out
	}

	raw, err := utils.ExecuteCommandWithOutput(
		"kubectl get applications.argoproj.io -n argocd -o json",
		".",
		nil,
	)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not read add-on health: %v\n", err)
		return out
	}

	var list argoAppList
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		fmt.Fprintf(stderr, "Warning: could not parse add-on health: %v\n", err)
		return out
	}

	want := make(map[string]struct{}, len(names))
	for _, n := range names {
		want[n] = struct{}{}
	}
	for _, item := range list.Items {
		if _, ok := want[item.Metadata.Name]; !ok {
			continue
		}
		out[item.Metadata.Name] = AddOnHealth{
			Health: orUnknown(item.Status.Health.Status),
			Sync:   orUnknown(item.Status.Sync.Status),
		}
	}
	return out
}

// orUnknown normalises an empty status string to "Unknown".
func orUnknown(s string) string {
	if s == "" {
		return "Unknown"
	}
	return s
}
