// Chat lifecycle (public, ACTIVE-user scoped).
//
// All chat mutations require an ACTIVE role (user|admin): a merely-authenticated
// "pending" user is rejected by requireActive. Profile creation happens at login
// via me.bootstrap (the only thing a pending user may call), not here.

import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireActive, requireOwnedChat } from "./lib/access";
import { auditImpersonated } from "./lib/audit";

async function requireOwnedProject(
  ctx: MutationCtx,
  userId: Id<"users">,
  projectId: Id<"projects">,
) {
  const project = await ctx.db.get(projectId);
  if (project === null) throw new Error("Not found: project");
  if (project.userId !== userId) throw new Error("Forbidden: project not owned");
  return project;
}

// Smallest sortKey among the user's chats in a given project (null = no project),
// so a new/moved chat can be placed above all of them (minKey - 1).
async function minChatSortKey(
  ctx: MutationCtx,
  userId: Id<"users">,
  projectId: Id<"projects"> | null,
): Promise<number> {
  const chats = await ctx.db
    .query("chats")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const keys = chats
    .filter((c) => (c.projectId ?? null) === projectId && !c.archived)
    .map((c) => c.sortKey ?? 0);
  return keys.length ? Math.min(...keys) : 0;
}

// Allowed chat color tokens (preset, NOT freeform hex — preserves theme
// coherence). Mirrored client-side in the color picker. "" / undefined = none.
const CHAT_COLORS = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;
const chatColorValidator = v.union(
  ...CHAT_COLORS.map((c) => v.literal(c)),
  v.null(),
);

export const createChat = mutation({
  args: {
    title: v.optional(v.string()),
    openclawChatId: v.optional(v.string()),
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, { title, openclawChatId, projectId }) => {
    const { userId, actor } = await requireActive(ctx);
    if (projectId) await requireOwnedProject(ctx, userId, projectId);
    const now = Date.now();
    // New chats go to the TOP: a key below the current minimum sortKey.
    const minKey = await minChatSortKey(ctx, userId, projectId ?? null);
    const chatId = await ctx.db.insert("chats", {
      userId,
      title,
      openclawChatId,
      projectId,
      archived: false,
      sortKey: minKey - 1,
      updatedAt: now,
    });
    await auditImpersonated(ctx, actor, "chat.create", {
      resource: "chat",
      resourceId: chatId,
    });
    return chatId;
  },
});

export const renameChat = mutation({
  args: { chatId: v.id("chats"), title: v.string() },
  handler: async (ctx, { chatId, title }) => {
    const { userId, actor } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    await ctx.db.patch(chatId, { title, updatedAt: Date.now() });
    await auditImpersonated(ctx, actor, "chat.rename", {
      resource: "chat",
      resourceId: chatId,
    });
  },
});

// Shared bounded cascade: delete a chat AND its dependent rows (messages,
// their parts, pending outbox). Convex has no cascade, so we do it explicitly.
// Bounded `.take()` keeps each pass within mutation limits; very large chats
// would need a self-scheduled continuation (noted; typical chats fit in one).
// Reused by deleteChat and by projects.deleteProject (cascade-on-delete).
export async function cascadeDeleteChat(
  ctx: MutationCtx,
  chatId: Id<"chats">,
): Promise<void> {
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .take(500);
  for (const m of messages) {
    const parts = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", m._id))
      .take(500);
    for (const p of parts) await ctx.db.delete(p._id);
    await ctx.db.delete(m._id);
  }
  const outbox = await ctx.db
    .query("outbox")
    .withIndex("by_status", (q) => q.eq("status", "pending"))
    .collect();
  for (const o of outbox) {
    if (o.chatId === chatId) await ctx.db.delete(o._id);
  }
  await ctx.db.delete(chatId);
}

export const deleteChat = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId, actor } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    await cascadeDeleteChat(ctx, chatId);
    await auditImpersonated(ctx, actor, "chat.delete", {
      resource: "chat",
      resourceId: chatId,
    });
  },
});

export const pinChat = mutation({
  args: { chatId: v.id("chats"), pinned: v.boolean() },
  handler: async (ctx, { chatId, pinned }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    await ctx.db.patch(chatId, { pinned });
  },
});

export const setChatColor = mutation({
  args: { chatId: v.id("chats"), color: chatColorValidator },
  handler: async (ctx, { chatId, color }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    await ctx.db.patch(chatId, { color: color ?? undefined });
  },
});

export const moveChatToProject = mutation({
  args: { chatId: v.id("chats"), projectId: v.union(v.id("projects"), v.null()) },
  handler: async (ctx, { chatId, projectId }) => {
    const { userId, actor } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    if (projectId) await requireOwnedProject(ctx, userId, projectId);
    const minKey = await minChatSortKey(ctx, userId, projectId);
    await ctx.db.patch(chatId, {
      projectId: projectId ?? undefined,
      sortKey: minKey - 1, // drop at the top of the destination list
    });
    await auditImpersonated(ctx, actor, "chat.move", {
      resource: "chat",
      resourceId: chatId,
    });
  },
});

// Reorder: place `chatId` between two neighbours via a fractional key. The
// client passes the sortKeys of the chats now above/below the drop slot
// (either may be null at a list edge). ONE row write — no N-row renumbering.
export const reorderChat = mutation({
  args: {
    chatId: v.id("chats"),
    prevKey: v.union(v.number(), v.null()),
    nextKey: v.union(v.number(), v.null()),
  },
  handler: async (ctx, { chatId, prevKey, nextKey }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    let key: number;
    if (prevKey === null && nextKey === null) key = 0;
    else if (prevKey === null) key = nextKey! - 1;
    else if (nextKey === null) key = prevKey + 1;
    else key = (prevKey + nextKey) / 2;
    await ctx.db.patch(chatId, { sortKey: key });
  },
});

// Generate a short-lived upload URL for an attachment. Scoped to an
// authenticated user so anonymous callers cannot upload blobs.
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireActive(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});
