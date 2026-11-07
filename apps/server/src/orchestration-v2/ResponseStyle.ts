// Asks agents to write their prose in Simplified Technical English (ASD-STE100), about 80% of the
// way, after Andrej Karpathy's tip that controlled English makes model output easier to follow.
// The bytes never change, so sending it every turn keeps the provider's prompt cache warm.
const SIMPLIFIED_TECHNICAL_ENGLISH = `<response_style>
Write your prose for the user in Simplified Technical English (ASD-STE100), about 80% of the way. Stay natural, not robotic.
- Keep most sentences under 20 words.
- Put one idea in each sentence.
- Use common words, and give each word one meaning only.
- Use the active voice. Say who or what does the action.
- Write procedures as numbered steps, one action in each step.
- Do not stack nouns into long chains.
Keep code, commands, paths, names, and quoted text exactly as they are.
</response_style>`;

/** Slash commands and compactions are matched by their exact text, so they stay untouched. */
export function withResponseStyle(text: string, enabled: boolean): string {
  if (!enabled || text.trimStart().startsWith("/")) return text;
  return `${SIMPLIFIED_TECHNICAL_ENGLISH}\n\n${text}`;
}
