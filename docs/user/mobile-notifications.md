# Mobile notifications

On iPhone, Ada can tell you when an agent needs you or finishes, even while the app is closed. Each of your servers sends the notification itself through Expo's push service, so it works however the phone connects: on your network, over Tailscale, or through SSH.

## Turn it on

1. Pair the phone with your servers as usual.
2. Open **Settings → Notifications** and allow notifications.
3. Each server has its own switch. Servers are on by default. Turn one off to stop notifications from that server only.

A server needs a recent Ada version to send notifications. Older servers show as needing an update.

## What you are notified about

Only top-level threads notify you: when one **Needs your input**, **Needs approval**, **Finished** or **Failed**.

Child chats and subagents never notify you on their own. When one asks for something, the notification names its top-level thread, and tapping it opens that thread. Tasks delegated from another machine don't notify from this one.

A snoozed thread doesn't notify you when it finishes, but it still does when it fails or asks for something. Settled threads don't notify you. If you're already looking at a thread, no notification is shown for it.

Tap a notification to open its thread.

## Privacy

A notification contains the thread title, the project name, and the kind of event, never message content. It goes from your server to Expo and Apple on its way to your phone.

## Stopping notifications

- Turn the server's switch off in **Settings → Notifications**.
- Remove the server from the phone. The phone asks the server to forget it first. If the server can't be reached, it keeps the registration until that session expires or is revoked.
- Revoke the phone from the server's **Connections** settings. The server stops at once.

## Not available yet

- Android notifications.
- Live Activities and the **Agent Activity** widget.
- Grouping several servers' events into one notification. Each server notifies on its own.
