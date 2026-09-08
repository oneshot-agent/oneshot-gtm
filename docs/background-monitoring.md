# Background monitoring

The dashboard server runs an in-process scheduler, so enabling a trigger is enough — no separate daemon. On a cron box or a headless machine, run `find watch` instead.

## As a service

`find watch --install-service` generates a service file that keeps the watch daemon running in the background — a launchd user agent on macOS, a systemd user unit on Linux. It prints to stdout (redirect-friendly); add `--write` to drop it at the platform-conventional path. Every path is embedded absolute at generation time — the bun binary, the CLI entry, and the active `ONESHOT_GTM_HOME` (so `--workspace acme find watch --install-service` pins the service to that workspace) — because service managers don't source your shell profile. Regenerate with `--write` after moving bun or the checkout.

**macOS (launchd).** Logs go to `<home>/find-watch.log`; the agent restarts on crash and survives reboots.

```bash
oneshot-gtm find watch --install-service            # inspect the plist
oneshot-gtm find watch --install-service --write    # → ~/Library/LaunchAgents/com.oneshot-gtm.find-watch.plist
launchctl load ~/Library/LaunchAgents/com.oneshot-gtm.find-watch.plist

# uninstall
launchctl unload ~/Library/LaunchAgents/com.oneshot-gtm.find-watch.plist
rm ~/Library/LaunchAgents/com.oneshot-gtm.find-watch.plist
```

**Linux (systemd user unit).** Logs go to the user journal: `journalctl --user -u oneshot-gtm-find-watch`.

```bash
oneshot-gtm find watch --install-service --write    # → ~/.config/systemd/user/oneshot-gtm-find-watch.service
systemctl --user daemon-reload
systemctl --user enable --now oneshot-gtm-find-watch

# uninstall
systemctl --user disable --now oneshot-gtm-find-watch
rm ~/.config/systemd/user/oneshot-gtm-find-watch.service
```

On a headless box, also run `loginctl enable-linger $USER` once so the user unit starts at boot rather than at first login.

**Windows (Task Scheduler).** There's no user-service template; schedule the cron-style `find watch --once` instead, which runs all due triggers and exits:

```powershell
$watchAction = New-ScheduledTaskAction -Execute 'C:\Users\you\.bun\bin\bun.exe' `
  -Argument '"C:\path\to\oneshot-gtm\apps\cli\src\main.ts" find watch --once --quiet'
$watchTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'oneshot-gtm find watch' -Action $watchAction -Trigger $watchTrigger

# uninstall
Unregister-ScheduledTask -TaskName 'oneshot-gtm find watch' -Confirm:$false
```

**Cron** works on POSIX hosts: `*/15 * * * * ONESHOT_GTM_HOME=$HOME/.oneshot-gtm /path/to/bun /path/to/apps/cli/src/main.ts find watch --once --quiet`.

## Exit codes for scheduled runs

`find watch --once` exits `1` when a due trigger errored. Add `--fail-on-empty` and a run that worked but produced nothing exits `2` instead of `0`, with one line on stderr naming the triggers and the zero count — enough for a cron wrapper to tell a dry run from a productive one without reading the ledger. `find drain <play>` takes the same flag. Both are opt-in: without it, exit codes are exactly what they were.

|       | `find watch --once`                                | `find drain <play>`                                     |
| ----- | -------------------------------------------------- | ------------------------------------------------------- |
| **0** | candidates queued, or `--fail-on-empty` not passed | rows drained, or `--fail-on-empty` not passed           |
| **1** | a due trigger errored (with or without the flag)   | with the flag: a row errored, or the drain itself threw |
| **2** | with the flag: ran clean, queued nothing           | with the flag: no approved rows to drain                |

Errors win over emptiness: a run that both errored and produced nothing exits `1`, not `2`. "Queued nothing" counts candidates that reached the queue, not raw hits scanned — a poll whose every hit was a duplicate or off-ICP left the ledger untouched and reads as empty. `--fail-on-empty` needs `--once`; on the daemon (which never ends on its own) it's rejected rather than ignored.

```bash
oneshot-gtm find watch --once --quiet --fail-on-empty
case $? in
  0) ;;                                  # candidates queued
  2) echo "nothing found this tick" ;;   # idle, not broken
  *) echo "watch failed" >&2 ;;
esac
```

## Spend ceiling

Per-run caps (`maxCostUsd` on a finder, `maxSpendPerRun` on x-reposters) bound one call; they don't stop fifteen independently-scheduled finders and automatic drains from collectively overspending across a day. `config spend-ceiling <amount>` (or the Wallet card on `/setup`) sets an install-wide daily USD ceiling, checked before every automated finder run and drain. A reservation held for the call's duration closes the race between two concurrent automated paths, so they can't both slip under the ceiling before either one's spend has posted. Once reached, scheduled and run-now finders and drains halt with a named reason (`daily spend ceiling reached ($X.XX/$Y.YY spent today)`) visible on the trigger cards and in `doctor`. Manual `/queue` sends (approve, reject, mark-sent, send-draft) are never gated by it — a founder reviewing and sending one email by hand is a deliberate decision the ceiling should never block. The counter resets at local midnight, the same boundary the per-identity send caps use. Unset (the default) is unlimited.
