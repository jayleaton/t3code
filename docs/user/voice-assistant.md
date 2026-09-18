# Voice assistant

Speak a request and hear a short summary when it finishes. Gemini handles speech; your selected
agent executes tasks on the device where you start voice. Viewing another project or remote
T3 environment does not move that agent to another machine.

## Set up

1. Open voice in the T3 desktop app or a browser. For a remotely hosted page, use
   **Connect this device** to pair with an updated T3 instance running locally. Paste its
   localhost pairing URL and allow local network access if the browser asks.
2. Add a Gemini API key through **Provider settings**, then choose a **Voice agent**.
3. Select **Push-to-talk**. Hold **Hold to talk**, or record a **Push-to-talk key**, and speak.
   Release to send. Pausing mid-sentence does not stop recording.

There is no execution project. Voice has a separate conversation rooted at your home directory.
It receives T3 workspace MCP tools for projects and threads on this device. A configured desktop
MCP Gateway can additionally expose connected remote environments according to its grants.
Your agent's machine tools and operating-system permissions determine which applications it can
control; choosing an agent does not install computer tools or grant Accessibility permission.

Voice conversations also work over remote HTTPS addresses, including Tailscale, using the
connected environment's Gemini key. A remote web address does not identify the browser's device.
Device execution uses the desktop host or a paired, direct localhost connection that supports
voice execution. Pair separately in each device's browser; a connection on your laptop does not
pair your desktop. Older T3 versions must be updated before they can execute voice tasks. If
more than one compatible local instance is paired, remove the extra connection in Settings →
Connections. Mobile voice controls are not implemented yet.

The microphone is released between requests. **Test mic** measures input locally without sending
it to Gemini. **Off** closes the microphone, playback, and speech connection; an already delegated
task can continue. Ask to stop the task to stop its agent. **Start a new voice conversation** closes
the old execution session and resets the speech context.

Browser shortcuts work while the browser is focused. On macOS, desktop voice shortcuts can work
from other apps; the voice panel reports whether Accessibility permission is needed. Other desktop
platforms use the in-app shortcut. Wake-word mode is not available.

## Working with an agent

Try “List my T3 projects,” “Create a thread to investigate the failing tests,” or a machine task
supported by your agent. You can also ask it to inspect local listening ports and configured
MCP servers. A running MCP can still require authentication or configuration before its tools
can be used. Ask how the task is going to hear its actual status. The assistant can
speak completion, approval, and input requests. Answer a pending question or approval by voice.
The transcript shows recognized speech, replies, and tool outcomes.

Pressing push-to-talk interrupts spoken playback. Escape cancels the voice request and playback;
it does not undo work already sent to the execution agent.

## Providers

Gemini Live is the supported speech provider. Its key is stored in the connected environment's T3 secret store.
The paired client receives it in memory to connect to Gemini; it is not stored in client settings
or transcripts. OpenAI voice and Jev routing are not part of the working voice path.
