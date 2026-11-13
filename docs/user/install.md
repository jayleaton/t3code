# Install Ada

Ada runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch Ada and configure providers afterwards.

## Command line

```bash
curl -fsSL https://raw.githubusercontent.com/jayleaton/t3code/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/jayleaton/t3code/main/scripts/install.ps1 | iex
```

This installs the `t3` binary to `~/.local/bin`. If that folder is not on your
`PATH` yet, the installer says so and, for zsh, bash on Linux, and fish, prints
a command to add it. On Windows, `t3` works in the same PowerShell window right
away; add the folder to your `PATH` for new windows. If a `t3` that the
installer or the desktop app did not create is already there, it leaves that
one alone and stops.

Every Ada release is a nightly, so the installer follows the nightly
channel. To pin an exact version, set `T3CODE_VERSION`:

```bash
curl -fsSL https://raw.githubusercontent.com/jayleaton/t3code/main/scripts/install.sh | T3CODE_VERSION=<version> sh
```

```powershell
$env:T3CODE_VERSION="<version>"; irm https://raw.githubusercontent.com/jayleaton/t3code/main/scripts/install.ps1 | iex
```

Each [release](https://github.com/jayleaton/t3code/releases) also carries
`install.sh` and `install.ps1`. Use only these scripts: T3 Code's
installers and its npm package install T3 Code's server and replace Ada's.

For a headless host, run the installer and then `t3 service install`. The
background service is the only headless setup that the app's **Update** button
can update ([details](./background-service.md)). Hosts that already run the
AppImage-based systemd unit can keep following
[Headless Linux host](../operations/headless-linux.md).

| Task                                             | Command                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| Start the server and open the web app            | `t3`                                                                    |
| Start the server without a browser               | `t3 serve`                                                              |
| Use it from your other devices                   | `t3 up` ([details](./remote-access.md))                                 |
| Keep it running in the background (macOS, Linux) | `t3 service install` ([details](./background-service.md))               |
| Move to the newest release                       | `t3 update`, or `t3 update <version>`                                   |
| Reclaim database space                           | `t3 doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove it again                                  | `t3 uninstall`                                                          |

Run `t3 help` or `t3 --help` for the full reference. To start in a new working
directory, use an explicit path such as `t3 ./my-project`. A bare directory name
is accepted only if it already exists.

If `t3` or `t3 start` reports an already running server, connect to that server
instead. Stop it before starting a replacement, or use a different `--base-dir`
for an independent server.

### Intel Macs

There is no `t3` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with `vp`, which provides the Node version it needs
([Install vp](https://github.com/jayleaton/t3code#install-vp)):

```bash
git clone https://github.com/jayleaton/t3code
cd t3code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`t3 update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

## Desktop app

Download a release from [GitHub Releases](https://github.com/jayleaton/t3code/releases):
a `.dmg` for macOS, an `.exe` for Windows, and an AppImage or `.deb` for Linux.
On Debian or Ubuntu, install the `.deb` with `sudo apt install ./T3-Agents-*.deb`.
Package managers such as winget, Homebrew, the AUR, and Nix install T3 Code,
not Ada.

### Linux

AppImage and `.deb` downloads are available for x86_64 and ARM64. Check your
architecture with `uname -m`: for `x86_64`, choose a file ending in
`x86_64.AppImage` or `amd64.deb`; for `aarch64`, choose `arm64.AppImage` or
`arm64.deb`.

To launch an AppImage, open a terminal in its download folder. Replace
`T3-Agents.AppImage` below with the exact filename you downloaded:

```bash
chmod +x ./T3-Agents.AppImage
./T3-Agents.AppImage
```

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

### The `t3` command

The desktop app includes the `t3` command-line tool. A new install sets it up
on first launch; after an update, or any time, choose **Install** next to
**t3 command** in **Settings → About**. On macOS and Linux it adds a `t3` link
in `~/.local/bin` (or `~/bin`); on Windows it adds the app's command folder to
your `PATH`. Open a new terminal afterwards. If the folder is not on your
`PATH`, **Add to PATH** on the Welcome page or in **Settings → About** adds one
line to your shell's startup file. **Remove** takes it off, and the app does not
add it again. If you already have another `t3`, it stays as it is.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Environments** to run agents and projects
there. Install the provider CLIs inside that distro. Ada installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

Ada's mobile app is not in the App Store or Google Play yet. The phone connects
to an Ada server on another machine. Follow [remote access](./remote-access.md) to
pair it with a pairing URL or QR code. Until it is listed, iPhone and iPad test
builds are available through TestFlight by invitation. There is no public Android
build yet.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from Ada's provider settings.                                                                                             |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If Ada cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

Ada warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when Ada cannot tell. Claude, Codex, and
OpenCode installs Ada cannot identify stay manual: update them through the
installer you used. Ada runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Cursor and Antigravity update with Ada. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Ada does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating Ada](./updating.md): update the app and connected servers.
- [Managed policy](./managed-policy.md): configure Ada for everyone on a machine.
