import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  listAnomalies,
  listTraces,
  queryOpenClaw,
  queryOpenClawInput,
  reportAnomaly,
  reportAnomalyInput,
} from "../src/tools.js";
import { type Config } from "../src/config.js";

const CONFIG: Config = {
  base: "http://127.0.0.1:3213",
  apiKey: "oc_live_TESTKEY1234",
};

/** Fake `fetch` that records inputs and returns a canned JSON 200. */
function fakeFetch() {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Parse the JSON body of a recorded request. */
function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("queryOpenClaw wire format (H1)", () => {
  it("POSTs { question, payload } — never prompt/chatId/runId/params", async () => {
    const { impl, calls } = fakeFetch();
    await queryOpenClaw(
      CONFIG,
      { question: "why is latency high?", payload: { window: "1h" } },
      { fetchImpl: impl },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3213/api/v1/openclaw/query");
    expect(calls[0]!.init!.method).toBe("POST");

    const body = bodyOf(calls[0]!.init);
    expect(body).toEqual({
      question: "why is latency high?",
      payload: { window: "1h" },
    });
    expect(body).not.toHaveProperty("prompt");
    expect(body).not.toHaveProperty("chatId");
    expect(body).not.toHaveProperty("runId");
    expect(body).not.toHaveProperty("params");
  });
});

describe("reportAnomaly wire format (M6)", () => {
  it("POSTs `evidence` (not `details`)", async () => {
    const { impl, calls } = fakeFetch();
    await reportAnomaly(
      CONFIG,
      {
        kind: "api.error_ratio",
        severity: "critical",
        message: "error ratio exceeded threshold",
        evidence: { ratio: 0.42 },
      },
      { fetchImpl: impl },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3213/api/v1/anomalies");
    expect(calls[0]!.init!.method).toBe("POST");

    const body = bodyOf(calls[0]!.init);
    expect(body.evidence).toEqual({ ratio: 0.42 });
    expect(body).not.toHaveProperty("details");
    expect(body.severity).toBe("critical");
    expect(body.message).toBe("error ratio exceeded threshold");
  });
});

describe("reportAnomaly input schema (M6)", () => {
  const schema = z.object(reportAnomalyInput);

  it("requires severity in {info,warn,critical} — rejects 'error'", () => {
    const r = schema.safeParse({
      kind: "k",
      severity: "error",
      message: "m",
    });
    expect(r.success).toBe(false);
  });

  it("requires message (rejects when missing)", () => {
    const r = schema.safeParse({ kind: "k", severity: "warn" });
    expect(r.success).toBe(false);
  });

  it("requires severity (rejects when missing)", () => {
    const r = schema.safeParse({ kind: "k", message: "m" });
    expect(r.success).toBe(false);
  });

  it("accepts a valid info|warn|critical anomaly with evidence", () => {
    for (const severity of ["info", "warn", "critical"] as const) {
      const r = schema.safeParse({
        kind: "k",
        severity,
        message: "m",
        evidence: { x: 1 },
      });
      expect(r.success).toBe(true);
    }
  });

  it("exposes `evidence`, not `details`", () => {
    expect(reportAnomalyInput).toHaveProperty("evidence");
    expect(reportAnomalyInput).not.toHaveProperty("details");
  });
});

describe("queryOpenClaw input schema (H1)", () => {
  const schema = z.object(queryOpenClawInput);

  it("exposes question + payload only (no prompt/chatId/runId/params)", () => {
    expect(queryOpenClawInput).toHaveProperty("question");
    expect(queryOpenClawInput).toHaveProperty("payload");
    expect(queryOpenClawInput).not.toHaveProperty("prompt");
    expect(queryOpenClawInput).not.toHaveProperty("chatId");
    expect(queryOpenClawInput).not.toHaveProperty("runId");
    expect(queryOpenClawInput).not.toHaveProperty("params");
  });

  it("accepts both fields optional", () => {
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ question: "q" }).success).toBe(true);
    expect(schema.safeParse({ payload: { a: 1 } }).success).toBe(true);
  });
});

describe("listTraces correlationId filter (M7)", () => {
  it("sends ?correlationId=", async () => {
    const { impl, calls } = fakeFetch();
    await listTraces(
      CONFIG,
      { correlationId: "chat123:run456", limit: 20 },
      { fetchImpl: impl },
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("correlationId")).toBe("chat123:run456");
    expect(url.searchParams.get("limit")).toBe("20");
  });
});

describe("listAnomalies since filter (L8)", () => {
  it("sends ?since=", async () => {
    const { impl, calls } = fakeFetch();
    await listAnomalies(
      CONFIG,
      { since: "2026-06-01T00:00:00Z", status: "open" },
      { fetchImpl: impl },
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("since")).toBe("2026-06-01T00:00:00Z");
    expect(url.searchParams.get("status")).toBe("open");
  });
});
