import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "evalkit — code-editing eval harness",
  description: "Model comparison on the codefix-v1 dataset. Free-tier providers only.",
};

export default async function Home() {
  const res = await fetch("http://localhost:3000/api/runs", { cache: "no-store" }).catch(
    () => null
  );
  const runs = res ? ((await res.json()).runs ?? []) : [];

  return (
    <main style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", padding: 32, maxWidth: 1000, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22 }}>evalkit</h1>
      <p style={{ color: "#666" }}>code-editing evals · codefix-v1 · free-tier providers</p>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 24 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
            <th style={th}>run</th>
            <th style={th}>state</th>
            <th style={th}>models</th>
            <th style={th}>units</th>
            <th style={th}>tokens in/out</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r: any) => (
            <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
              <td style={td}>
                <a href={`/runs/${r.id}`} style={{ color: "#06c" }}>
                  {r.id.slice(0, 8)}
                </a>
              </td>
              <td style={td}>{r.state}</td>
              <td style={td}>{r.models.join(", ")}</td>
              <td style={td}>
                {r.unitsDone}/{r.unitsTotal}
              </td>
              <td style={td}>
                {r.totalInputTokens}/{r.totalOutputTokens}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {runs.length === 0 && (
        <p style={{ marginTop: 24, color: "#666" }}>
          No runs yet. Create one with{" "}
          <code>npm run run-eval -- --models=qwen/qwen3.8-27b,gemini-2.5-flash --samples=0,1,2</code>
        </p>
      )}
    </main>
  );
}

const th: React.CSSProperties = { padding: "8px 12px", fontSize: 13, fontWeight: 600 };
const td: React.CSSProperties = { padding: "8px 12px", fontSize: 13 };