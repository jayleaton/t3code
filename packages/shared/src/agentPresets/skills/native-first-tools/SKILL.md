---
name: native-first-tools
description: Prefer native computer-use and image tools, honor explicit tool choices, and use configured fallbacks only when eligible.
---

# Native-first tool routing

Apply before computer/browser use or image generation/editing. Discover the current thread's callable tools; a model/provider label alone does not establish capabilities.

- Honor the user's explicit tool/provider/browser choice. If that choice is unavailable, report the concrete limitation; do not silently substitute.
- For images, use the provider's built-in image generation/editing tool and its native instructions when available. Deliver native output directly or save it in the project.
- For browser work, prefer T3 collaborative preview tools when exposed, following their status/open, ownership and retry rules. An explicit request for an open browser takes precedence: use the provider's native computer-use interface for that browser. For desktop apps use native computer-use tools.
- Native computer use depends on the current machine and exposed tools. If you have a separate computer-use machine, launch the capable agent there through an authorized handoff and verify the destination. Otherwise report the missing capability with a concrete next step.
- If you have a fallback computer-use or image tool, automatic fallback is allowed only for DeepSeek or locally hosted models whose relevant native capability is absent after supported discovery. Discover the configured fallback's instructions and prerequisites before using it. Explicit user selection of a fallback remains allowed for other models.
- For other models lacking native capability, report the limitation or use an authorized handoff to a capable agent, such as Pastry for computer use. A failed native call, cost preference or a local tool merely being present does not establish fallback eligibility.
- If you have file/artifact storage, clipboard or device-transfer tools, use them when the task needs them. Their availability does not grant eligibility for computer-use or image-generation fallback. Do not transfer every generated image by default.

Keep unrelated tools, model settings and permissions intact. Do not request accessibility permissions for an unselected fallback backend.
