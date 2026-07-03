// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var channelsCmd = &cobra.Command{
	Use:     "channels",
	Aliases: []string{"channel"},
	Short:   "Manage notification channels",
	Long: `Notification channels are delivery destinations (webhook, email, Slack,
PagerDuty, and more) that alert rules fan out to. List, create, verify, and delete
the active organization's channels.`,
}

var channelsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List notification channels",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var channels []api.Channel
			ui.RunSpinner("Fetching channels...", func() { channels, err = client.ListChannels() })
			if err != nil {
				failf("Failed to list channels: %v", err)
			}
			if len(channels) == 0 {
				ui.Muted("No notification channels found.")
				return
			}
			_ = ui.ShowTable(channelListColumns, channelRows(channels), "channels")
			return
		}
		if err := runChannelsList(client, os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list channels: %v", err)
		}
	},
}

var channelListColumns = []string{"Name", "Type", "Verified", "Enabled", "ID"}

// channelRows projects channels into plain table rows.
func channelRows(channels []api.Channel) [][]string {
	rows := make([][]string, len(channels))
	for i, c := range channels {
		rows[i] = []string{c.Name, c.Type, yesNo(c.IsVerified), yesNo(c.Enabled), c.ID}
	}
	return rows
}

// yesNo renders a bool as the brand marker (true) or a dash (false).
func yesNo(b bool) string {
	if b {
		return ui.SymbolDefault
	}
	return ui.SymbolDash
}

// runChannelsList fetches and renders the channels (non-interactive path).
func runChannelsList(c apiClient, out io.Writer, format string) error {
	channels, err := c.ListChannels()
	if err != nil {
		return err
	}
	if len(channels) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No notification channels found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: channelListColumns,
		Rows:    channelRows(channels),
	}, channels)
}

var (
	channelType          string
	channelRecipients    []string
	channelURL           string
	channelSigningSecret string
	channelRoutingKey    string
)

var channelsCreateCmd = &cobra.Command{
	Use:   "create <name>",
	Short: "Create a notification channel",
	Long: `Create a notification channel. The destination depends on --type:
  email             one or more --recipient flags
  slack/webhook/... a --url (with optional --signing-secret)
  pagerduty         a --routing-key

The endpoint is verified before the channel is saved (a channel never exists
unverified).`,
	Args: cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runChannelsCreate(api.NewClient(token), os.Stdout, args[0], channelType, channelConfig()); err != nil {
			failf("Failed to create channel: %v", err)
		}
	},
}

// channelConfig assembles the create payload's `config` bag from the flags,
// translating the CLI's snake_case secret flags into the wire shape.
func channelConfig() map[string]interface{} {
	config := map[string]interface{}{}
	if len(channelRecipients) > 0 {
		config["recipients"] = channelRecipients
	}
	if channelURL != "" {
		config["url"] = channelURL
	}
	if channelSigningSecret != "" {
		config["signing_secret"] = channelSigningSecret
	}
	if channelRoutingKey != "" {
		config["routing_key"] = channelRoutingKey
	}
	return config
}

// runChannelsCreate creates a channel and confirms it.
func runChannelsCreate(c apiClient, out io.Writer, name, channelType string, config map[string]interface{}) error {
	ch, err := c.CreateChannel(name, channelType, config)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Created %s channel %s (%s)", ch.Type, ch.Name, ch.ID)))
	return nil
}

var channelsVerifyCmd = &cobra.Command{
	Use:   "verify <id>",
	Short: "Send a test event through a channel and mark it verified",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runChannelsVerify(api.NewClient(token), os.Stdout, args[0]); err != nil {
			failf("Failed to verify channel: %v", err)
		}
	},
}

// runChannelsVerify verifies a channel and confirms it.
func runChannelsVerify(c apiClient, out io.Writer, id string) error {
	ch, err := c.VerifyChannel(id)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Verified channel "+ch.Name))
	return nil
}

var channelsDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete a notification channel",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if !confirm("Delete this channel?", "Alert rules bound to it will lose this destination. This cannot be undone.") {
			return
		}
		if err := runChannelsDelete(api.NewClient(token), os.Stdout, args[0]); err != nil {
			failf("Failed to delete channel: %v", err)
		}
	},
}

// runChannelsDelete deletes a channel and confirms it.
func runChannelsDelete(c apiClient, out io.Writer, id string) error {
	if err := c.DeleteChannel(id); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Channel deleted"))
	return nil
}

func init() {
	channelsCreateCmd.Flags().StringVar(&channelType, "type", "", "Channel type (webhook, email, slack, pagerduty, …)")
	channelsCreateCmd.Flags().StringArrayVar(&channelRecipients, "recipient", nil, "Email recipient (repeatable; email channels)")
	channelsCreateCmd.Flags().StringVar(&channelURL, "url", "", "Destination webhook URL (slack/webhook/…)")
	channelsCreateCmd.Flags().StringVar(&channelSigningSecret, "signing-secret", "", "Optional webhook signing secret")
	channelsCreateCmd.Flags().StringVar(&channelRoutingKey, "routing-key", "", "PagerDuty Events API routing key")
	_ = channelsCreateCmd.MarkFlagRequired("type")

	channelsCmd.AddCommand(channelsListCmd)
	channelsCmd.AddCommand(channelsCreateCmd)
	channelsCmd.AddCommand(channelsVerifyCmd)
	channelsCmd.AddCommand(channelsDeleteCmd)
	rootCmd.AddCommand(channelsCmd)
}
