// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build windows

package kubecache

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// tryLock takes an exclusive LockFileEx lock on the first byte of f without blocking: true when
// taken, false when another handle holds it.
func tryLock(f *os.File) (bool, error) {
	err := windows.LockFileEx(windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, new(windows.Overlapped))
	if err == nil {
		return true, nil
	}
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return false, nil
	}
	return false, err
}

// unlockFile releases the lock on f.
func unlockFile(f *os.File) error {
	return windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, new(windows.Overlapped))
}

// checkOwner is a no-op on Windows: access is governed by the ACL the cache directory inherits from
// the user's profile, which the Unix owner and mode bits do not describe.
func checkOwner(os.FileInfo) error { return nil }

// permsOpen is always false on Windows, for the same reason: Go synthesises the mode bits there
// from the read-only attribute, so 0666 says nothing about who else can read the file.
func permsOpen(os.FileInfo) bool { return false }
