/** Minimal Claude Messages API client. Needs ANTHROPIC_API_KEY in the environment. */
export const hasApiKey = () => !!process.env.ANTHROPIC_API_KEY;

export async function askClaude(opts: { model: string; maxTokens: number; system: string; user: string }) {
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
}

/** Pulls the first JSON object out of a model reply (tolerates ```json fences and prose around it). */
export function extractJson<T = any>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No JSON object in model reply");
  return JSON.parse(body.slice(start, end + 1));
}
