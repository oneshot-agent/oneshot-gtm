# Background monitoring

A finder that runs only while your terminal is open is a hobby. Install the dashboard as a service and it comes back after a restart or a crash.

The dashboard server runs the scheduler itself, so an enabled trigger is polled while the dashboard is up. On a headless machine run `find watch` instead. Run one or the other for a workspace, never both: each polls the same triggers.

The scheduler polls finders and runs the learning jobs. It does not send. A batch goes out when you press **Batch send…** or run `find drain`.

## The dashboard as a service

`ui --install-service` generates a service file that starts the dashboard at login and restarts it after a crash: a launchd agent on macOS, a systemd user unit on Linux. It prints the file; `--write` puts it in place. The workspace's name, home and port are read from the workspace the command runs in, so run it once per workspace.

```bash
oneshot-gtm ui --install-service                     # inspect the file
oneshot-gtm ui --install-service --write             # default workspace
oneshot-gtm --workspace acme ui --install-service --write
```

**macOS (launchd).** The label is `com.oneshot-gtm.workspace.<name>` (`default` without named workspaces). Logs go to `<home>/dashboard.log`.

```bash
launchctl load ~/Library/LaunchAgents/com.oneshot-gtm.workspace.acme.plist

# after pulling new code and rebuilding the web app
launchctl kickstart -k gui/$(id -u)/com.oneshot-gtm.workspace.acme

# after re-running --write (a new port, a moved checkout): launchd reads the file only when it loads it
launchctl unload ~/Library/LaunchAgents/com.oneshot-gtm.workspace.acme.plist
launchctl load ~/Library/LaunchAgents/com.oneshot-gtm.workspace.acme.plist

# uninstall
launchctl unload ~/Library/LaunchAgents/com.oneshot-gtm.workspace.acme.plist
rm ~/Library/LaunchAgents/com.oneshot-gtm.workspace.acme.plist
```

**Linux (systemd user unit).** The unit is `oneshot-gtm-workspace-<name>.service`. Logs go to the user journal: `journalctl --user -u oneshot-gtm-workspace-acme`.

```bash
systemctl --user daemon-reload
systemctl --user enable --now oneshot-gtm-workspace-acme

# after pulling new code and rebuilding the web app
systemctl --user restart oneshot-gtm-workspace-acme

# after re-running --write
systemctl --user daemon-reload && systemctl --user restart oneshot-gtm-workspace-acme

# uninstall
systemctl --user disable --now oneshot-gtm-workspace-acme
rm ~/.config/systemd/user/oneshot-gtm-workspace-acme.service
```

- The service needs the web build (`bun run --cwd apps/web build`) and will not generate without it.
- A stop you ask for is respected. Only a crash restarts it.
- It starts at login, not at power-on. On Linux, `loginctl enable-linger $USER` changes that.
- After moving bun or the checkout, or changing the port, run `--write` again and reload. A restart alone keeps the old values.
- It needs a clone. `bunx oneshot-gtm-server` has no service file.

## The watch daemon as a service

`find watch --install-service` does the same for the headless daemon. Paths are written absolute, including the active workspace home, so `--workspace acme find watch --install-service` pins the service to that workspace.

**macOS (launchd).** Logs go to `<home>/find-watch.log`.

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

On a headless box, run `loginctl enable-linger $USER` once so the unit starts at boot.

**Windows (Task Scheduler).** There is no service template. Schedule `find watch --once`, which runs every due trigger and exits:

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

A cron wrapper needs to tell idle from broken. `--fail-on-empty` gives it the third answer.

|       | `find watch --once`                      | `find drain <play>`                                           | `find import`                   |
| ----- | ---------------------------------------- | ------------------------------------------------------------- | ------------------------------- |
| **0** | candidates queued, or the flag is absent | rows sent, or the flag is absent                              | rows imported, or no flag       |
| **1** | a due trigger errored                    | with the flag: a row errored, or the spend ceiling stopped it | the import failed               |
| **2** | with the flag: ran clean, queued nothing | with the flag: no approved rows                               | with the flag: nothing imported |

An error beats emptiness: a run that errored and produced nothing exits `1`. "Queued nothing" counts candidates that reached the queue, so a poll whose every hit was a duplicate reads as empty. The flag needs `--once`; the daemon rejects it.

```bash
oneshot-gtm find watch --once --quiet --fail-on-empty
case $? in
  0) ;;                                  # candidates queued
  2) echo "nothing found this tick" ;;   # idle, not broken
  *) echo "watch failed" >&2 ;;
esac
```

## Spend ceiling

Per-run caps bound one run. They do not stop several finders from overspending across a day. `config spend-ceiling <amount>`, or the Wallet card on Setup, sets a daily limit in USD for the whole workspace.

- Checked before every finder run and every batch send. Spend is reserved first, so two runs at once cannot both slip under it.
- Once reached, finders and batches stop with a named reason, `daily spend ceiling reached`, shown on the trigger cards and in `doctor`. Approved rows stay approved.
- A single send you make by hand is never blocked. That is a decision, and the ceiling is for what runs without one.
- It resets at local midnight. Unset means no limit.

The [learning jobs](./learning.md) reserve against the same ceiling.
