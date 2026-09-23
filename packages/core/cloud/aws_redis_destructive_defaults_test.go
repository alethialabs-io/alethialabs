// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestAWSProvider_RedisDefaultsMatchWhatIsLive pins the two ElastiCache toggles whose console
// default, until #4320, could not reach a resource.
//
// WHY THIS EXISTS, and why it is a test rather than a comment. Both knobs were declared at the
// template root and read by nothing, so `aws/modules/redis`'s own defaults won — and BOTH of those
// default `true`. Every cache provisioned to date therefore runs cluster mode ON and streams to
// CloudWatch, while this provider has been sending `false` for both and being ignored.
//
// Wiring them (#4320) makes the console's value real. Had it stayed `false`, the FIRST apply after
// that wire on any existing AWS deployment would have:
//
//   - flipped ElastiCache cluster mode true→false, which is a TOPOLOGY change and replaces the
//     cache, not an in-place update; and
//   - destroyed `aws_cloudwatch_log_group.redis` and every event it retained — the resource sits
//     under `count = var.cloudwatch_logs_enabled ? 1 : 0` — while the firehose fallback is also off
//     by default, so the cache would deliver no logs at all.
//
// Nobody asked for either. Maintainer decision 2026-09-22: fix the console default, not the
// template. The template's job is to honour its input; its input was wrong.
//
// So these values are not a preference — they are "what is already true in the field", and changing
// either one is a decision to mutate live infrastructure on the next apply. That is exactly the
// shape of change that should not pass silently, which is why it is pinned here with the
// consequence written down rather than left to a reviewer noticing a bool flip in a 200-line map.
//
// ⚠️ If a future change genuinely intends one of these to be `false` by default, it must also say
// what happens to existing deployments on their next apply. Editing this test to match a new value
// without that answer is the failure this test exists to prevent.
func TestAWSProvider_RedisDefaultsMatchWhatIsLive(t *testing.T) {
	p := &awsProvider{}
	tfvars := p.ProviderTfvars(&types.ProjectConfig{
		Cluster: types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
		DNS:     types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
		Caches:  []types.ProjectCacheConfig{{Name: "main", Engine: types.CacheEngineRedis}},
	})

	for _, tc := range []struct {
		key  string
		want bool
		cost string
	}{
		{
			key:  "redis_cluster_mode_enabled",
			want: true,
			cost: "sending false replaces the cache — an ElastiCache topology change, not an in-place update",
		},
		{
			key:  "redis_cloudwatch_logs_enabled",
			want: true,
			cost: "sending false destroys aws_cloudwatch_log_group.redis and every event it retained",
		},
	} {
		got, present := tfvars[tc.key]
		if !present {
			t.Errorf("%s is absent from the tfvars map — the template then falls back to the module "+
				"default, which is how this knob was dead in the first place", tc.key)
			continue
		}
		if got != tc.want {
			t.Errorf("%s = %v, want %v.\n  On an existing deployment: %s.\n"+
				"  If this change is intended, state what happens to deployments already in the field.",
				tc.key, got, tc.want, tc.cost)
		}
	}
}
