#!/usr/bin/env sh
# Planted fixture — a destructive command that never passes through the harness gate.
# The self-test flags it: a high-risk command is present, but the script neither sources the
# harness library nor gates the command. (Never executed; scanned as data by the lint.)
git push --force origin main
