// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
)

// This file holds the interactive runners that drive a live terminal widget
// (spinner / confirm). They apply the grayscale theme from theme.go but can't be
// unit-tested headless (they call .Run() on a TTY), so they live apart from the
// testable theme logic and are excluded from the logic-coverage badge.

// RunSpinner shows a grayscale loading spinner with the given title while action
// runs, returning when it completes.
func RunSpinner(title string, action func()) error {
	return spinner.New().
		Title(" " + title).
		Style(SpinnerStyle).
		TitleStyle(SecondaryStyle).
		Action(action).
		Run()
}

// AuthRequiredPrompt renders the reusable "you're not logged in" notice and asks
// whether to log in now, returning the user's choice. Centralizes the auth-gate UX
// so every command that hits an unauthenticated state looks identical.
func AuthRequiredPrompt() (bool, error) {
	Error("You are not logged in or your session has expired.")
	var confirm bool
	err := NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title("Would you like to log in now?").
				Affirmative("Yes").
				Negative("No").
				Value(&confirm),
		),
	).Run()
	if err != nil {
		return false, err
	}
	return confirm, nil
}
