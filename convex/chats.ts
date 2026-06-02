// Chat lifecycle (public, per-user scoped).
//
// `createChat` provisions the app user on first sight (ensureProfile) and
// creates a chat owned by that user. This is what the frontend calls before
// sending the first message; `send.sendMessage` then requires an owned chat.

import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { ensureProfile, requireOwnedChat } from "./lib/access";

export const createChat = mutation({
  args: {
    title: v.optional(v.string()),
    // Optional OpenClaw-side chat id if the caller already knows it. Non-secret.
    openclawChatId: v.optional(v.string()),
  },
  handler: async (ctx, { title, openclawChatId }) => {
    const userId = await ensureProfile(ctx);
    const now = Date.now();
    const chatId = await ctx.db.insert("chats", {
      userId,
      title,
      openclawChatId,
      archived: false,
      updatedAt: now,
    });
    return chatId;
  },
});

export const renameChat = mutation({
  args: { chatId: v.id("chats"), title: v.string() },
  handler: async (ctx, { chatId, title }) => {
    const userId = await ensureProfile(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    await ctx.db.patch(chatId, { title, updatedAt: Date.now() });
  },
});

export const archiveChat = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const userId = await ensureProfile(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    await ctx.db.patch(chatId, { archived: true, updatedAt: Date.now() });
  },
});

// Generate a short-lived upload URL for an attachment. Scoped to an
// authenticated user so anonymous callers cannot upload blobs.
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await ensureProfile(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});
