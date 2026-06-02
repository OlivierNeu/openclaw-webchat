import { useMemo } from "react";
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreAdapter,
} from "@assistant-ui/react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import type { ConvexId, ConvexMessageView } from "./convexTypes";
import { convertConvexMessage } from "./convertMessage";
import {
  attachmentParts,
  createConvexAttachmentAdapter,
} from "./attachmentAdapter";

// The single source of truth for the chat UI runtime.
//
// We deliberately use useExternalStoreRuntime backed by a *reactive* Convex
// query — NOT the AI SDK useChat default HTTP transport (POST + SSE per turn).
// That transport opens a request-scoped stream per turn and closes it when the
// turn "ends", which loses post-turn OpenClaw events (extra tool calls, late
// media, status corrections) — exactly the Open WebUI failure mode this project
// exists to kill. Here, the bridge worker holds the persistent OpenClaw socket
// and writes every normalized event into Convex; useQuery(listByChat) makes the
// browser reactive to the DB, so streaming and post-turn events all land the
// same way: a doc patch -> query re-run -> re-render.

export interface UseConvexChatRuntimeArgs {
  chatId: ConvexId<"chats"> | null;
}

export function useConvexChatRuntime({ chatId }: UseConvexChatRuntimeArgs) {
  const convex = useConvex();
  const sendMessage = useMutation(api.send.sendMessage);

  // Reactive message feed. Returns messages joined with ordered parts and
  // resolved storage URLs (see convexTypes). `skip` while no chat is selected.
  const messages = useQuery(
    api.messages.listByChat,
    // ConvexId<"chats"> is our structural string-id type; the generated arg
    // validator brands it Id<"chats">. Same runtime value; cast at the boundary.
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  ) as ConvexMessageView[] | undefined;

  const attachmentAdapter = useMemo(
    () => createConvexAttachmentAdapter(convex),
    [convex],
  );

  const adapter = useMemo<ExternalStoreAdapter<ConvexMessageView>>(() => {
    const list = messages ?? [];
    // isRunning: any message in this chat is mid-flight. Drives the composer's
    // "stop"/spinner affordance. Mirrors run.status === streaming from the
    // normalizer, materialised as message.status on the doc.
    const isRunning = list.some((m) => m.status === "streaming");

    return {
      messages: list,
      isRunning,
      convertMessage: convertConvexMessage,

      // New user turn: persist to Convex; the bridge picks it up from the
      // outbox and forwards it to OpenClaw. No HTTP streaming round-trip here —
      // the assistant reply arrives via the reactive query.
      onNew: async (message: AppendMessage) => {
        if (!chatId) throw new Error("No chat selected");
        const text = message.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");

        // Build the {storageId, filename, mimeType}[] shape that
        // api.send.sendMessage validates (NOT a bare storage-id string[]). The
        // storage ids are opaque strings client-side; the generated mutation
        // validator brands them as Id<"_storage">, so we assert that type here.
        const attachments = attachmentParts(message.attachments).map((a) => ({
          storageId: a.storageId as Id<"_storage">,
          filename: a.filename,
          mimeType: a.mimeType,
        }));

        // clientMessageId is REQUIRED and is the server-side idempotency key:
        // the Convex client may transparently retry a mutation on a transient
        // failure, and `sendMessage` dedupes on it so a retry never
        // double-inserts the user message or double-dispatches to the bridge.
        await sendMessage({
          chatId: chatId as Id<"chats">,
          text,
          clientMessageId: crypto.randomUUID(),
          attachments,
        });
      },

      adapters: {
        attachments: attachmentAdapter,
      },
    };
  }, [messages, chatId, sendMessage, attachmentAdapter]);

  return useExternalStoreRuntime(adapter);
}
