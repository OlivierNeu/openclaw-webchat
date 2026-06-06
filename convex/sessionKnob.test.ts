/// <reference types="vite/client" />
//
// UI-3 write-back: unit tests for `chats.setSessionKnob` (the Convex half).
//
// Pins the two properties the live browser run does NOT prove deterministically:
// (1) MERGE — changing one knob must never drop the other; (2) OWNERSHIP — a user
// cannot patch another user's chat. The scheduled `dispatchPatch` (which POSTs to
// the bridge) is NOT flushed here: convex-test does not auto-run scheduled
// functions, so these assert the mutation's DB effect + access gate in isolation.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

/** Seed an ACTIVE (role "user") account and return an identity-bound client. */
async function seedUser(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" });
    return userId;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

async function readSettings(
  t: ReturnType<typeof convexTest>,
  chatId: Id<"chats">,
) {
  return await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionSettings ?? null);
}

describe("chats.setSessionKnob", () => {
  test("changing one knob never drops the other (merge)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;

    await as.mutation(api.chats.setSessionKnob, { chatId, thinkingLevel: "low" });
    expect(await readSettings(t, chatId)).toEqual({ thinkingLevel: "low" });

    // Patching ONLY the model must preserve the previously-set reasoning level.
    await as.mutation(api.chats.setSessionKnob, { chatId, model: "gpt-5.5" });
    expect(await readSettings(t, chatId)).toEqual({
      thinkingLevel: "low",
      model: "gpt-5.5",
    });

    // Re-patching reasoning keeps the model.
    await as.mutation(api.chats.setSessionKnob, { chatId, thinkingLevel: "high" });
    expect(await readSettings(t, chatId)).toEqual({
      thinkingLevel: "high",
      model: "gpt-5.5",
    });
  });

  test("a user cannot patch another user's chat (ownership)", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t);
    const intruder = await seedUser(t);
    const chatId = (await owner.as.mutation(api.chats.createChat, {})) as Id<"chats">;

    await expect(
      intruder.as.mutation(api.chats.setSessionKnob, { chatId, thinkingLevel: "low" }),
    ).rejects.toThrow();

    // The owner's chat is untouched.
    expect(await readSettings(t, chatId)).toBeNull();
  });

  test("rejects an over-long knob value (defensive bound)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;

    await expect(
      as.mutation(api.chats.setSessionKnob, { chatId, thinkingLevel: "x".repeat(65) }),
    ).rejects.toThrow(/invalid/i);
  });
});
