// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"reflect"
	"testing"
)

// setChannelFlags installs the channel-create flag globals for one case and
// restores them afterwards, so the table cases stay independent.
func setChannelFlags(t *testing.T, recipients []string, url, signingSecret, routingKey string) {
	t.Helper()
	prevRecipients, prevURL := channelRecipients, channelURL
	prevSecret, prevRouting := channelSigningSecret, channelRoutingKey
	channelRecipients, channelURL = recipients, url
	channelSigningSecret, channelRoutingKey = signingSecret, routingKey
	t.Cleanup(func() {
		channelRecipients, channelURL = prevRecipients, prevURL
		channelSigningSecret, channelRoutingKey = prevSecret, prevRouting
	})
}

// TestChannelConfig covers the create payload assembly: only the flags actually
// set become config keys, under the snake_case wire names.
func TestChannelConfig(t *testing.T) {
	cases := []struct {
		name          string
		recipients    []string
		url           string
		signingSecret string
		routingKey    string
		want          map[string]interface{}
	}{
		{
			name: "no flags",
			want: map[string]interface{}{},
		},
		{
			name:       "email recipients",
			recipients: []string{"a@b.com", "c@d.com"},
			want:       map[string]interface{}{"recipients": []string{"a@b.com", "c@d.com"}},
		},
		{
			name:          "webhook with signing secret",
			url:           "https://hooks.example.com/x",
			signingSecret: "s3cr3t",
			want: map[string]interface{}{
				"url":            "https://hooks.example.com/x",
				"signing_secret": "s3cr3t",
			},
		},
		{
			name:       "pagerduty routing key",
			routingKey: "R0UT1NG",
			want:       map[string]interface{}{"routing_key": "R0UT1NG"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setChannelFlags(t, tc.recipients, tc.url, tc.signingSecret, tc.routingKey)
			if got := channelConfig(); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("channelConfig() = %#v, want %#v", got, tc.want)
			}
		})
	}
}

// TestEnabledLabel covers both arms of the fleet-pool enabled label.
func TestEnabledLabel(t *testing.T) {
	if got := enabledLabel(true); got != "enabled" {
		t.Errorf("enabledLabel(true) = %q, want \"enabled\"", got)
	}
	if got := enabledLabel(false); got != "paused" {
		t.Errorf("enabledLabel(false) = %q, want \"paused\"", got)
	}
}
