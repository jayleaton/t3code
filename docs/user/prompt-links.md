# Prompt links

A prompt link opens Ada with a prompt ready to send. Use one to share a prompt on social
media, or to put a one-click fix in a pull request comment.

A link never runs anything. It opens a draft. You read the prompt, then press Send. A link cannot
change your permission mode, branch, or worktree. Your own defaults apply.

## Make a link

Write a link by hand:

```
t3code://new?prompt=Rate%20my%20swearing
t3code://new?prompt=Fix%20the%20build&repo=owner/name&provider=codex&model=gpt-5.5
t3code://new?pr=owner/name/123&prompt=Fix%20the%20failing%20check
```

These links open the desktop app. **Copy prompt link** in the command palette and on sent
messages appears only when your Ada web app is set up with a hosted address that links can point
to.

| Parameter  | Meaning                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| `prompt`   | The prompt. Required, except on pull request links. At most 8,000 characters. |
| `repo`     | A GitHub repository, as `owner/name` or its URL.                              |
| `provider` | A provider such as `codex` or `claude`.                                       |
| `model`    | A model of that provider, by its id or name.                                  |
| `pr`       | A GitHub pull request, as `owner/name/123` or its URL.                        |

Encode the prompt for a URL. In JavaScript, use `encodeURIComponent`.

## Open a link

- **No `repo`**: the draft opens without a project, on the machine you used last.
- **`repo`**: the draft opens in your most recently used project for that repository. A fork
  counts only for its own owner. When you do not have the repository, choose **Clone** or **Use
  without project**.
- **`provider` and `model`**: used when you have that provider set up. Otherwise your default
  model is used, and Ada tells you.
- **`pr`**: opens the thread linked to that pull request on any connected machine, with the prompt
  in its composer. When no thread is linked, the draft goes on the pull request branch in a new
  worktree. Ada checks the code out only after you confirm, because the checkout runs your
  setup script on it.

A thread link with a prompt, such as `t3code://threads/<environment>/<thread>?prompt=…`,
puts the prompt in that thread's composer. If you already typed a draft there, Ada asks
before it replaces it.

Ada removes characters you cannot see, such as zero-width and hidden tag characters, because
they can hide instructions for the agent. When a prompt had them, Ada warns you that it may be
malicious.

## Share a thread

**Copy thread** copies a Markdown link such as `[Title](t3-thread://v2/<environment>/<thread>)`.
Paste it into an Ada composer to attach the thread, or into a message, where it opens the thread
in the app. Only someone connected to the machine that runs the thread can see it.
