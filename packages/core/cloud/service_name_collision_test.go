// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The refusal must happen on EVERY cloud: the collapse is in manifest rendering, which no cloud
// varies. A gate that only some providers call is the shape that lets a defect through on the
// provider nobody tested.
func TestValidateConfig_RefusesCollidingServiceNamesOnEveryCloud(t *testing.T) {
	for _, name := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		t.Run(name, func(t *testing.T) {
			p, err := NewCloudProvider(name)
			if err != nil {
				t.Fatalf("NewCloudProvider(%q): %v", name, err)
			}
			cfg := &types.ProjectConfig{
				Services: []types.ProjectServiceConfig{
					{Name: "api"}, {Name: "API"},
				},
			}
			err = p.ValidateConfig(cfg)
			if err == nil {
				t.Fatalf("%s accepted two services that render one Kubernetes object", name)
			}
			// The message is the whole explanation the user gets instead of a plan, so it has to
			// name both services — "invalid configuration" alone is not actionable.
			for _, want := range []string{"api", "API"} {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("%s: error must name %q; got: %v", name, want, err)
				}
			}
		})
	}
}

// …and must NOT refuse names that merely look similar. Rule 1 of validate.go: strictly narrower
// than the templates, or it starts refusing projects that deploy fine today.
func TestValidateConfig_AcceptsDistinctServiceNames(t *testing.T) {
	for _, name := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		p, err := NewCloudProvider(name)
		if err != nil {
			t.Fatalf("NewCloudProvider(%q): %v", name, err)
		}
		cfg := &types.ProjectConfig{
			Services: []types.ProjectServiceConfig{
				{Name: "api"}, {Name: "api-worker"}, {Name: "web"},
			},
		}
		if err := p.ValidateConfig(cfg); err != nil {
			t.Fatalf("%s refused three distinct service names: %v", name, err)
		}
	}
}
