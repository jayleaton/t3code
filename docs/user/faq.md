# FAQ

## Is Ada a harness?

No. A harness is what turns an LLM into an agent: it gives the model tools, a way to call them, runs them, and hands the results back. Claude Code is kind of a harness. It is an interface (the TUI, the Code tab in the desktop app) plus a harness underneath (the Anthropic Agent SDK). Codex is the same split: the app plus the Codex App Server. Ada uses those harnesses. It is not a harness, and it does not work without one.

Chef = LLM. Kitchen = harness. Ada = the restaurant that lets you bring whatever kitchen you want. Our MCP is a cookbook we hand the kitchen, but the chef won't open it unless you tell them to :)

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Pi, or Muse Code. [Provider setup](./install.md#providers)

## Why use Ada instead of Claude Code or the Codex app?

We were inspired by the Codex desktop app, Conductor, Claude Desktop, and Cursor Glass, but none met our bar. What you get:

- Bring your own sub. Claude, Codex, and whatever else you already have installed.
- Best in class remote. Run `ada up` on any box and drive it from anywhere.
- Best in class mobile app.
- Truly 100% open source. If we go the wrong direction, fork it.

Every harness feels nearly identical in here, so you can stop worrying about harnesses and focus on building :) [Install](./install.md)

## Can I use Ada with my Claude Code subscription?

Yes.

## How much does Ada cost?

Nothing. There's no way to pay us to use Ada. You bring your own sub. It is free and open source (MIT). You still pay your provider like you already do. [Install](./install.md)

## Why is my Claude 5-hour limit draining so fast?

Ada drives Claude through Anthropic's Agent SDK. This is a known bug on Anthropic's side: all Agent SDK usage drains your 5h limits faster than using Claude Code directly. It does not affect weekly limits. It has been reported to Anthropic.

## How do I use Ada remotely?

Your agents run wherever Ada runs: your desktop, a server, a VPS. You connect to it from anywhere. Run `ada up` on that machine, then pair over your LAN or Tailscale. [Remote access](./remote-access.md)

## How do I use Ada on my phone?

Ada's mobile app is not in the App Store or Google Play yet. With a test build, connect it to your computer with a pairing link over your LAN or Tailscale. The phone is a remote. Your computer does the work and needs to stay on. [Mobile setup](./install.md#mobile-app) · [Remote access](./remote-access.md)

## Will I get banned for using my subscription?

Ada runs each provider through its own official CLI, SDK, or ACP binding, the same way you would use it directly. Your provider's terms still apply, so check them if you are unsure.

## Can I add a bunch of accounts for one provider?

Ada is not the right place to manage a pile of accounts. An auto-switcher would risk TOS bans for its users.

A separate work account is fine. Setup for two: [Codex](./providers-codex.md#use-multiple-accounts) · [Claude](./providers-claude.md#separate-accounts-or-configurations). For a bigger pool, manage them outside Ada with a self-hosted proxy like [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). Pooling accounts can break your provider's terms, so you take that risk yourself. After you set up a hub, Ada can show its pooled limits under Usage. [Connect a hub](./usage.md#connect-a-cliproxyapi-hub)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and give it its own keys and endpoint. Claude has a full OpenRouter recipe. Your subscription setup stays untouched. [OpenRouter](./providers-claude.md#openrouter) · [Provider instances](./install.md#providers)

## Does Ada support local models?

No. Ada is a serious developer tool. Locally runnable models are not capable of meaningful engineering work.

## Does my code go to Ada servers?

No. Your code and prompts go from your machine to your provider (Anthropic, OpenAI, etc.), not to us. Your devices connect straight to your machine over your LAN or Tailscale. Ada doesn't collect usage data. [Usage data and diagnostics](./telemetry.md)

## Worktrees are eating my disk. How do I clean them up?

Open **Settings → Worktrees → Cleanup** and turn on automatic worktree cleanup. You can also run it now from there. Worktrees add up fast. [Storage cleanup](./project-settings.md#storage-cleanup)

## Is there voice input?

Yes. On iPhone and Android, dictation uses on-device speech by default; you can opt in to a paired environment instead. Web and desktop require you to choose an environment first. The transcript goes into your draft for review. See [Voice input](./voice-input.md).

## Does it work on Windows, Mac, and Linux?

Yes, all three. Desktop app, CLI, the works. One catch: there is no `ada` binary for Intel Macs, so use the desktop app there. Windows folks can also run agents inside WSL. [Install](./install.md)

## Why is my provider not showing up?

Almost always, the CLI is not installed or not on the `PATH` of the machine that runs the server. (Not your phone. The computer.) Log in on that machine first, like `codex login` or `claude auth login`. Still missing? Point **Binary path** at it in provider settings. Version managers love to cause this one. [Provider setup](./install.md#providers)
