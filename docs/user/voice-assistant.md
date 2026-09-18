# Voice assistant

The T3 Code voice assistant lets you work in another application while agents continue, and hear
when a thread finishes or needs you. It is a distinct feature from composer dictation: dictation
edits a draft, while the voice assistant can ask about agents, delegate work, and answer pending
questions.

## Providers and keys

Voice credentials are stored per environment, in that environment's secret store — never in your
browser, chat settings, or transcripts.

Open **Settings → General → Voice assistant**. From there:

- **Conversation provider** selects the live speech provider. Gemini Live is available today.
  OpenAI voice is listed but cannot be selected until its adapter ships.
- **Credential owner** chooses which connected environment stores the keys. This is independent of
  the agent environment selected in chat, so you can keep voice keys on your own machine while
  driving a remote environment.
- **Gemini Live** and **Jev / TypeSafe** each have their own key row with **Add key** /
  **Replace key**, **Test connection**, and remove. A saved key shows only a short hint.

**Jev / TypeSafe is optional.** It helps route ambiguous requests to the right thread, environment,
or action. Without a Jev key, exact-target commands ("stop the mobile agent") and completion
announcements still work. Add a key only if you want the assistant to resolve ambiguous requests.

**Testing a connection** checks the provider without touching your agents. The TypeSafe test sends
one small Jev question, so it uses a little of your TypeSafe usage; the panel says so. A failed test
never deletes an existing working key, and a replacement key is validated before it is saved.

**Removing a key** disables the dependent provider connection and safely cancels pending voice
requests. Keys follow the environment: a key saved for one environment is not available to another.

## Modes and microphone

The assistant has three modes; the default is Off. In all modes, the microphone belongs to the
device you are speaking into — audio is never captured on the environment that runs your agents.

- **Off** releases the microphone and stops spoken updates.
- **Push-to-talk** keeps the microphone released between requests. Hold to speak; release ends the
  command window immediately. Push-to-talk also interrupts the assistant's speech.
- **Hey agent** keeps the microphone active locally for wake detection only. No ambient audio is
  uploaded; the assistant cannot detect a wake word with the microphone off. The app shows
  "waiting for Hey agent" separately from "microphone off".

When a command window is open, it finalizes after five seconds without accepted speech; you can
choose ten seconds in settings. Only your accepted speech extends the window — keyboard noise and
the assistant's own voice do not.

Open the voice control at the bottom of the left column to change these settings. **Push-to-talk
key** records a shortcut: click it and press the keys you want (for example `⌥⌘Space` on macOS,
`Ctrl+Alt+Space` elsewhere), or press a single function key such as `F8`. Press Escape while
recording to cancel, or Backspace to clear it. The dialog's "Test your shortcut" line lights up when
the recorded chord is pressed, so you can confirm it before relying on it.

## Current status

Provider credential setup, mode selection, and shortcut configuration are available. Live microphone
capture, the local "Hey agent" wake engine, and spoken response playback are the next milestone; until
they land, selecting a mode stores your preference but does not yet capture or speak audio.

## Capability notes

- Speaker verification ("only respond to my voice") is a separate, opt-in milestone. It is a
  convenience filter, not authentication, and cannot cleanly separate overlapping voices.
- Exact commands and announcements work without Jev. Ambiguous requests ask you to clarify rather
  than guessing a target.
- Voice is enabled per device; when the desktop voice host owns the microphone, other clients on the
  same device step back.
