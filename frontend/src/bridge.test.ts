import { describe, expect, it } from "vitest";
import {
  applyStreamEvent,
  safeHref,
  statusLabel,
  textFromContent,
  type Streaming
} from "./bridge";

const ORIGIN = "https://app.example";

describe("applyStreamEvent", () => {
  it("accumulates message.delta and preserves spaces", () => {
    let s: Streaming | null = null;
    s = applyStreamEvent(s, { type: "message.delta", text: "Voici l'image" }).streaming;
    s = applyStreamEvent(s, { type: "message.delta", text: " générée !" }).streaming;
    expect(s).toEqual({ text: "Voici l'image générée !", media: [] });
  });

  it("replaces text on message.snapshot", () => {
    const start: Streaming = { text: "Bon", media: [] };
    const update = applyStreamEvent(start, { type: "message.snapshot", text: "Bonjour !" });
    expect(update.streaming).toEqual({ text: "Bonjour !", media: [] });
  });

  it("appends media items", () => {
    const start: Streaming = { text: "done", media: [] };
    const update = applyStreamEvent(start, {
      type: "media",
      items: [{ filename: "a.pdf", url: "https://m/a.pdf" }]
    });
    expect(update.streaming?.media).toEqual([{ filename: "a.pdf", url: "https://m/a.pdf" }]);
  });

  it("resets the partial reply on run.status=compacting", () => {
    const start: Streaming = { text: "part1", media: [{ filename: "x" }] };
    const update = applyStreamEvent(start, { type: "run.status", status: "compacting" });
    expect(update.streaming).toEqual({ text: "", media: [] });
  });

  it("leaves streaming untouched on a non-compacting run.status", () => {
    const start: Streaming = { text: "part1", media: [] };
    const update = applyStreamEvent(start, { type: "run.status", status: "working" });
    expect(update.streaming).toBe(start);
  });

  it("finalizes and clears streaming on message.final, carrying media", () => {
    const start: Streaming = { text: "draft", media: [{ filename: "a.pdf" }] };
    const update = applyStreamEvent(start, { type: "message.final", text: "final answer" });
    expect(update.streaming).toBeNull();
    expect(update.final).toEqual({
      text: "final answer",
      error: false,
      media: [{ filename: "a.pdf" }]
    });
  });

  it("marks an error final", () => {
    const update = applyStreamEvent(null, {
      type: "message.final",
      text: "moitié",
      error: "Context overflow"
    });
    expect(update.final?.error).toBe(true);
    expect(update.final?.text).toBe("moitié");
  });
});

describe("safeHref", () => {
  it("allows http(s)", () => {
    expect(safeHref("https://x/y", ORIGIN)).toBe("https://x/y");
    expect(safeHref("http://x/y", ORIGIN)).toBe("http://x/y");
  });

  it("rejects dangerous schemes", () => {
    expect(safeHref("javascript:alert(1)", ORIGIN)).toBeNull();
    expect(safeHref("data:text/html;base64,xx", ORIGIN)).toBeNull();
  });
});

describe("statusLabel", () => {
  it("maps known run statuses", () => {
    expect(statusLabel("running")).toContain("cours");
    expect(statusLabel("compacting")).toContain("Compaction");
    expect(statusLabel("error")).toContain("erreur");
    expect(statusLabel("unknown")).toBe("");
  });
});

describe("textFromContent", () => {
  it("reads a plain string", () => {
    expect(textFromContent("hello")).toBe("hello");
  });

  it("reads a list of text parts", () => {
    expect(textFromContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe(
      "a\nb"
    );
  });

  it("returns empty for unsupported shapes", () => {
    expect(textFromContent(42)).toBe("");
  });
});
