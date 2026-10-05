/**
 * OFFLINE PROOF ONLY. Stubs global fetch so the real GroqAdapter runs its full
 * code path (URL, headers, body, OpenAI response parsing) with no network and
 * no key. Never import this outside step1 --offline.
 */
const CORRECT_T01 = `\`\`\`python
def get(d, k):
    return d.get(k)
\`\`\``;

let calls = 0;

export function registerStub() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (!url.includes("groq.com")) return real(input, init);
    calls++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    console.log(`[stub] intercepted groq call #${calls} model=${body.model} seed=${body.seed}`);
    return new Response(
      JSON.stringify({
        id: "stub",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: CORRECT_T01 } }],
        usage: { prompt_tokens: 111, completion_tokens: 22 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
  // "" is not nullish, so use ||= (dotenv leaves empty keys as empty strings).
  process.env.GROQ_API_KEY ||= "offline-stub-key";
}

export function stubCalls(): number {
  return calls;
}