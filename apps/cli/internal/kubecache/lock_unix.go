// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !windows

package kubecache

import (
	"errors"
	"os"
	"syscall"
)

// tryLock takes an exclusive flock on f without blocking: true when taken, false when another open
// file description holds it. flock locks belong to the open file description, so two opens of the
// same path in ONE process exclude each other too — which is what lets a test drive the contention
// with goroutines.
func tryLock(f *os.File) (bool, error) {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return false, nil
	}
	return false, err
}

// unlockFile releases the flock on f.
func unlockFile(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}

// checkOwner refuses a file or directory that is not owned by the effective user.
func checkOwner(fi os.FileInfo) error {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && int(st.Uid) != os.Geteuid() {
		return errors.New("is owned by another user")
	}
	return nil
}

// permsOpen reports whether a mode grants any group or other access.
func permsOpen(fi os.FileInfo) bool {
	return fi.Mode().Perm()&0o077 != 0
}
