"use client";

import { useEffect, useState } from "react";
import type { RunDetail } from "@/lib/stats";

// No SSE, no websockets (hard rule): plain 3s polling.
const POLL_MS = 3000;

export default function RunPage({ params }: { params: { id: string } }) {
  const [data, setData] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/runs/${params.id}`, { cache: "no-store" });
        const j = await r.json();
        if (!alive) return;
        if (!r.ok) setError(j.error ?? `HTTP ${r.status}`);
        else {
          setData(j);
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    load();
    const t = setInterval(() => {
      setTick((n) => n + 1);
      load();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [params.id, tick]);

  const models = data?.models ?? [];

  return (
    <main style={S.page}>
      <a href="/" style={S.back}>← all runs</a>
      <h1 style={S.h1}>run {params.id.slice(0, 8)}</h1>
      {error && <p style={S.err}>error: {error}</p>}

      {data && (
        <>
          <p style={S.meta}>
            state <b>{data.state}</b>
            {" · "}
            tokens {data.totalInputTokens} in / {data.totalOutputTokens} out
            {" · "}
            units {data.units.map((u) => `${u.n} ${u.state}`).join(", ")}
          </p>

          <h2 style={S.h2}>pass rate (95% bootstrap CI)</h2>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>model_version</th>
                <th style={S.th}>passed</th>
                <th style={S.th}>rate</th>
                <th style={S.th}>CI95</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.model_version}>
                  <td style={S.td}>{m.model_version}</td>
                  <td style={S.td}>{m.passed}/{m.n}</td>
                  <td style={S.td}>{(m.passRate * 100).toFixed(1)}%</td>
                  <td style={S.td}>
                    {(m.ci95[0] * 100).toFixed(0)}% – {(m.ci95[1] * 100).toFixed(0)}%
                  </td>
                </tr>
              ))}
              {models.length === 0 && (
                <tr>
                  <td style={S.td} colSpan={4}>
                    no scores yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {models.length > 1 && (
            <>
              <h2 style={S.h2}>per task (all samples must pass)</h2>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>task</th>
                    {models.map((m) => (
                      <th key={m.model_version} style={S.th}>
                        {m.model_version}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.matrix.map((row) => (
                    <tr key={row.task_id}>
                      <td style={S.td}>{row.task_id}</td>
                      {models.map((m) => (
                        <td key={m.model_version} style={S.td}>
                          <span style={{ color: row.passed[m.model_version] ? "#0a0" : "#c00" }}>
                            {row.passed[m.model_version] ? "PASS" : "FAIL"}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      <p style={S.meta}>polling every {POLL_MS / 1000}s</p>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    padding: 32,
    maxWidth: 1000,
    margin: "0 auto",
  },
  back: { color: "#06c", fontSize: 13 },
  h1: { fontSize: 20, marginBottom: 4 },
  h2: { fontSize: 15, marginTop: 32, marginBottom: 8 },
  meta: { fontSize: 13, color: "#666" },
  err: { color: "#c00", fontSize: 13 },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "6px 10px", fontSize: 12, borderBottom: "1px solid #ccc" },
  td: { padding: "6px 10px", fontSize: 13, borderBottom: "1px solid #f0f0f0" },
};