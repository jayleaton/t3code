# T3 Agents

> [!IMPORTANT]
> **T3 Agents is an unofficial fork and UI wrapper around [T3 Code](https://github.com/pingdotgg/t3code),
> the original project by the T3 Tools team.**
>
> We do not maintain, own, or manage T3 Code. Everything underneath this interface — the server,
> orchestration, provider adapters, and provider CLIs — comes from the upstream project, and we only
> add UI on top of it. Because upstream keeps moving, things here can break, lag behind, or change
> without notice. For the supported, maintained product, use
> **[T3 Code](https://github.com/pingdotgg/t3code)**.

## Grant's fork

This is Grant Charge's copy of T3 Agents. It comes from
[jayleaton/t3code](https://github.com/jayleaton/t3code). Jayj Eaton makes T3 Agents.
Grant adds a small number of changes on top of it.

### What Grant added

**1. Warnings for risky commands**

- Sometimes an agent asks you to approve a command.
- If the command can delete or destroy work, the app shows a red warning.
- The warning tells you what the command does.
- Examples: delete many files, force push, or delete a database.
- You see the warning only in Supervised mode. In Full access mode, the agent does not ask.

**2. A warning for a cold prompt cache**

- Claude keeps your chat in a fast memory for a short time. This memory is the prompt cache.
- On a subscription, this time is 1 hour. With an API key, it is 5 minutes.
- After that time, your next message is slower and costs more.
- A Claude chat can have more than 100,000 tokens. Then a banner tells you when the cache is cold.
- The banner has a "Compact first" button. You can also close the banner.
- The context meter shows how long the cache stays warm.

**3. Plain technical English replies**

- Agents reply in short, clear sentences. This is the default.
- The style follows ASD-STE100 (Simplified Technical English).
- To stop it, go to Settings → Threads → "Plain technical English replies".

**4. The rewrite button (wand)**

- The wand button is next to the paperclip.
- Click it to make your draft short and clear before you send it.
- Code, file paths, names and @mentions do not change.
- To get your old text back, click Undo. Undo stays on the screen for 30 seconds.
- The button uses the text model in Settings. Grant uses OpenCode with DeepSeek V4.1 Flash.

**5. Jayj's newest changes**

- On 7 November 2026, the fork got 772 changes from jayleaton/t3code.

### How the fork stays up to date

The fork updates itself. A GitHub workflow does these steps
([grant-upstream-sync.yml](.github/workflows/grant-upstream-sync.yml)):

1. Every 6 hours, it looks for Jayj's newest nightly release.
2. If the fork has that release, it stops.
3. If not, it merges the release into `main`.
4. Then it runs Jayj's checks and Grant's tests.
5. If all checks pass, it pushes the merge to `main`.
6. If the merge has a conflict, or a check fails, it opens a pull request. A person or an agent must
   fix the problem.

When `main` changes, a second workflow makes a new release
([grant-release.yml](.github/workflows/grant-release.yml)):

1. It builds a Mac app (Apple silicon) and a Linux app (AppImage).
2. It puts them on this fork's [Releases page](https://github.com/GrantCharge/t3code/releases).

The sync workflow needs a secret with the name `FORK_SYNC_TOKEN`. This is a GitHub token. It must
have permission to write code, pull requests and workflows. The built-in GitHub token cannot do this.

### How to update your apps

**Linux server**

- A timer starts `t3-headless-update` each day at 04:30 (Bangkok time).
- The script gets the newest release from this fork and installs it.
- If the new version does not start, the script goes back to the old version.

**Mac**

- Apple did not sign this app. Because of this, the app cannot install updates itself.
- The app tells you when an update is ready. Then do these steps:
  1. Get the `.dmg` file from the [Releases page](https://github.com/GrantCharge/t3code/releases).
  2. Quit T3 Agents.
  3. Open the `.dmg` file. Drag the app into Applications.

**After an update**

- Sometimes OpenCode shows no models after the server starts again.
- Wait 5 minutes. Or go to Settings → Providers and click Refresh.

### Rules for this fork

- Grant's changes go only to this fork. They do not go to jayleaton/t3code or pingdotgg/t3code.
- Do not change Jayj's `fork-*` workflows. They run only on his repository. If you change them,
  you get merge conflicts.

T3 Agents is a focused front end for the [T3 Code](https://github.com/pingdotgg/t3code) agent harness
control surface. It lets you direct the agents on your machine — Claude Code, Codex, Cursor, Grok
Build, OpenCode, Google Antigravity, and fx — from one workspace, with the same mobile app
([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824),
[Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), web app, and
[Electron-based desktop app](https://t3.codes) surfaces as upstream.

## "Wait, what are you selling me?"

Nothing. This fork exists because we wanted to build on top of T3 Code, not because we are selling
anything. T3 Code itself was built by its own team to be performant, remote-ready, and truly open; if
you want the project those words describe, use [the original](https://github.com/pingdotgg/t3code).

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity, and fx. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.
> - fx: install [fx](https://fx.sh) and run `fx login` on the machine running the T3 Code server ([setup guide](./docs/user/providers-fx.md))

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from this fork's [GitHub Releases](https://github.com/jayleaton/t3code/releases), or from your favorite package registry. Upstream releases live at [pingdotgg/t3code](https://github.com/pingdotgg/t3code/releases):

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

#### Nix (nixpkgs)

```bash
nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code
```

The package is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code)
and includes the desktop app (`t3code-desktop`) and the `t3` command.
See [Nix installation](./docs/user/install.md#nix-nixpkgs) for NixOS configuration and updates.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
