# Changelog

## Unreleased

- **Stop team.** While any agent runs, the top bar shows **Stop team**. It lists the running
  agents and offers **Stop agents** (ends their Claude Code sessions, all at once; work,
  worktrees, branches, plans and the team are kept) or **Stop agents and quit Fleet**, which
  then exits Fleet with code 0 so the login item doesn't bring it back until the next login or
  `fleet --start`. The page then says Fleet has stopped and how to start it again.
- **Docs:** a Stopping section covering the drawer's Stop, Stop team, quitting, `fleet --stop`
  (`--all`) and Ctrl-C.
- **Home page.** `fleet home` (or `fleet open`, or `fleet` outside a git repo) opens Fleet's
  home page at `http://localhost:7788`: every project Fleet knows, running or stopped, its URL,
  agents running, what needs you, open PRs, and API-equivalent cost for today, 7 days and all
  time. **Open**, **Start** and **Stop** per project; **Forget** for a project whose repo is
  gone. It runs in the background, starts whenever `fleet` runs in a repo, and starts at login
  once any repo does (`com.jainildesai.fleet.home`, `fleet-home.service`; `fleet home
  --autostart` / `--no-autostart`). Each project's top bar links back to it with **Home**.
- **Install as an app.** The home page has a web app manifest and pixel icons: install it from
  Chrome or Edge, or Safari's File → Add to Dock.
- **Projects start at port 7789** (7788 is the home page's). A login item pinned to 7788 by an
  earlier version moves to the next free port the first time the home page starts, and says so.
  Its agents keep running; until they restart, the home page passes their hooks and Team MCP
  calls on to their project.
- **A repo folder named `home`** now gets the project name `home-<hash>`: `home` belongs to the
  home page's login item. A team set up earlier under `~/.fleet/projects/home` isn't picked up
  again; move it to the new folder name, or start the team again.
- **Linux:** the systemd service now has `KillMode=process`, so stopping or restarting Fleet
  leaves the agents' tmux sessions running, as on macOS.

## 0.5.0

- **Linux.** Fleet runs on Linux: `sudo apt install tmux`, then the same `npm install -g` and
  `fleet`. The browser opens with `xdg-open`. **Open in terminal** uses the first installed of
  `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `kitty`, `alacritty`,
  `wezterm` and `xterm`. Banners use `notify-send` when it's installed (no click action).
- **Windows through WSL.** Fleet runs inside WSL. The browser opens with `wslview` or
  `explorer.exe`, and **Open in terminal** opens a Windows Terminal tab in your distro. No
  banners on WSL. On native Windows, `fleet` now installs, and says how to set up WSL
  instead of running (`--version` and `--help` still work).
- **Start at login on Linux and WSL** is a systemd user service,
  `~/.config/systemd/user/fleet-<project>.service`, with the same port, log and
  restart-on-crash as on macOS. `--stop`, `--start`, `--no-autostart` and `--all` work the same.
  `loginctl enable-linger` starts it at boot. Without systemd (WSL's default), `--autostart`
  says how to turn it on in `/etc/wsl.conf`.
- **Setup checks** show which terminal Open in terminal will use on each platform, and give
  apt fixes (with links for dnf and pacman) instead of brew off macOS. When Fleet can't open a
  terminal, the help under the `tmux attach` command fits your platform: the Automation
  permission is only mentioned on macOS.
- The older session board's launch and focus buttons say they're macOS-only off macOS,
  instead of calling AppleScript.
- macOS is unchanged.

## 0.4.0

- **Several projects at once.** Run `fleet` in each repo. Without `--port`, a taken 7788 means
  the next free port (Fleet says which); `fleet` in a repo that already has a copy opens that
  one. `fleet --list` shows every running copy, and the top bar has a **⇄** switcher to the
  others. Running copies are kept in `~/.fleet/running/`.
- **Unique projects.** A project's home records its repo root (`repo-root`). A second repo with
  the same folder name gets `<name>-<hash>` instead of sharing the first one's team. Existing
  projects keep their name, tmux sessions and worktrees.
- **Two teams on one repo.** New agent worktrees use `fleet/<project>/<agent>` branches, so two
  checkouts of the same repo don't fight over `fleet/<agent>`. Existing worktrees and branches
  keep working. PR sync ignores other projects' `fleet/…` branches, and on a shared repo only
  claims a task's PR once the agent reported it.
- **Start at login per repo.** `fleet --autostart` writes `com.jainildesai.fleet.<project>`
  with its own port and log (`~/.fleet/fleet-<project>.log`); the older `com.jainildesai.fleet`
  item is recognised as its repo's and replaced on the same port. `--stop`, `--start` and
  `--no-autostart` act on this repo only; `--all` for every one. `--autostart` refuses to run
  from the npx cache. `--start` checks launchd's real state, so a copy that keeps exiting is
  restarted and its last exit code shown, not reported as running. A background copy whose repo
  already has a Fleet exits cleanly instead of being restarted forever. The stale-install
  warning also checks Fleet's own path.
- **One set of banners.** Only one copy watches every Claude session (banners,
  `events.jsonl`, `history.json`); another takes over when it stops.
- **Requirements in the UI.** The welcome screen and Settings → Project show each check
  (tmux, Claude Code, Claude Code sign-in, `gh`, GitHub remote, terminal) with ✓/✗, its fix
  command and **Check again**.
- **No GitHub remote or `gh`:** a new team starts with PR review off, and agents are told
  there are no PRs: commit on a branch, don't push.
- **Trust folder.** Claude Code's first-start folder-trust prompt can be answered from Action
  items or the agent's drawer (worktrees Fleet made only). Fleet presses Enter only once
  "Yes, I trust this folder" is highlighted.
- **Sign-in.** Fleet checks `claude auth status`, and notices Claude Code's login screen in an
  agent's terminal.
- **Terminal.** "Open in iTerm" is now **Open in terminal**: iTerm if installed, else
  Terminal.app (which failed before: zsh expanded the `=session` target). If macOS blocks it,
  Fleet shows the `tmux attach` command with Copy and how to allow it.
- **CLI.** `fleet --version`; a bad or missing `--port` value and unknown flags stop with a
  clear message; a repo with no commits stops with "Make a first commit".
- No `~/.claude` yet (Claude Code never run) no longer logs an error every 1.5 seconds.
- A permission prompt counts once in Action items, not also as "asking in its terminal".
- The "Needs input" badge stays readable (only its dot blinks), the activity panel is opaque,
  and the team list is hidden behind the welcome screen.
- README: a First run walkthrough, the permission-mode note, the terminal, and the `ETARGET` fix.

## 0.3.2

- Plan and deploy approvals now have Approve / Reject buttons. Rejecting tells the agent to
  stop, not to find another way.

## 0.3.1

- The top bar fits at every window width. Below 1536px it hides the repo path and the
  "Plan wall" label, so the project name always shows (hover it for the repo).
- The README shows the office, an agent's drawer, Action items and the Team settings.

## 0.3.0

Fleet is now an office for a team of Claude Code agents, built on
[JSM HQ](https://github.com/jsmastery-pro/jsm-hq) by JavaScript Mastery (MIT).

- **Pixel office.** HQ's office UI replaces the old dashboard. Each agent sits at a desk and
  shows what it's doing; tasks move on the plan wall; messages are rendered as Markdown.
- **A CTO-led team.** You talk to the CTO, which plans and assigns work to a Planner,
  Implementer, QA, Reviewer and Deployer. Agents start the first time they're needed.
- **Real sessions.** Every agent is `claude` in tmux, in its own git worktree under
  `~/.fleet/projects/<repo>/`. **Open in iTerm** attaches to it.
- **Actions.** Questions, plan and deploy approvals, and Claude Code permission prompts
  (Allow/Deny) in one list. A production deploy is labelled so it never looks routine.
- **Make it your flow.** Every agent, the CTO included, has an editable role you can load from
  a file, and its own skills you can paste or upload. `~/.fleet/roles/<role>.md` sets your
  own defaults for every new repo.
- **Pull requests.** With `gh`, Fleet follows the team's PRs: review comments go to the
  author, passed reviews to the CTO, merges close the task. PRs from forks are ignored.
- **Breaking:** Fleet now needs tmux and works on one git repo per run: the current folder
  or `--repo <path>`. It exits with a clear message outside a git repo.
- **Breaking:** the Agents, History, Usage, MCP and Plugins pages are gone. macOS
  notification banners still work, and history is still recorded.
- **Auto-start** now remembers the repo. If you set it up before 0.3.0, run
  `fleet --autostart` again from your repo, or the background copy can't start.

## 0.2.2

- `fleet --stop` also stops a copy run with `npx` or installed in a project folder
  (`node_modules/.bin/fleet`). 0.2.1 only found global installs and the background copy.

## 0.2.1

- `fleet --stop` stops Fleet for now, including the background copy, which otherwise macOS
  would restart. Auto-start stays on, so Fleet comes back at the next login.
- `fleet --start` starts the background copy again right away.

## 0.2.0

- **Start at login:** `fleet --autostart` sets Fleet up to run in the background from login
  (no browser tab, restarted if it crashes, logged to `~/.fleet/fleet.log`), and
  `fleet --no-autostart` turns it off. Fleet warns when the login item points at a Node
  version that no longer exists.
- `fleet --help` lists the options.

## 0.1.2

- The README opens with a short demo: agents updating live, a notification arriving, a
  session's subagents, and a History search. No changes to Fleet itself.

## 0.1.1

- Session names stay whole on narrow cards; the branch shortens instead. With the detail
  panel open, names like "checkout" were cut to "checko…".
- The npm page links to the new website, https://fleet.jainildesai.com.
- The README's session screenshot now shows the session panel it describes.

## 0.1.0

First public release, on npm as `@jainil_desai/fleet`.

- **Agents:** every live Claude Code session on the Mac, grouped by repo, with status, model,
  branch, current tool call, cost including subagents, and context use. Subagent trees and
  workflow phases in each session's panel.
- **History:** a record of every session (title, project, branch, model, cost, prompts, files
  edited) kept in `~/.fleet/history.json` after Claude Code deletes the transcript, with search
  and on-demand summaries.
- **Notifications:** inbox, tab badge and macOS banners when an agent needs you, finishes, or a
  subagent or workflow ends. Banners open the session's terminal tab when clicked if
  `terminal-notifier` is installed.
- **New agent:** launches `claude` in Terminal or iTerm through your login shell, with model,
  effort, permission mode, name, first prompt and optional worktree.
- **Usage, MCP servers, plugins & skills** pages, and plan limits through the statusline.
- Warns on the Agents page when Claude Code's transcript format isn't recognized.
- Workflow `journal.jsonl` files are no longer shown or counted as agents.
