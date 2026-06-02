import { useState } from "react";
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useMutation,
  useQuery,
} from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "./convexApi";
import type { ConvexId } from "./convexTypes";
import { ConvexChat } from "./ConvexChat";

// New top-level app shell for the Convex + assistant-ui chat. This is a NEW
// entry point and does NOT modify the existing frontend/src/App.tsx. Mount it
// from main.tsx inside <ConvexAuthProvider> (see README note in this folder).
//
// Auth boundary uses Convex Auth's <Authenticated>/<Unauthenticated>/
// <AuthLoading>. All chat queries/mutations are scoped server-side to the
// authenticated user (ctx.auth.getUserIdentity), so a user only ever sees their
// own chats and messages — there is no chatId a user can pass to read someone
// else's data; listByChat must verify ownership on the server.

export function ConvexChatApp() {
  return (
    <>
      <AuthLoading>
        <div className="oc-boot">Loading…</div>
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <ChatWorkspace />
      </Authenticated>
    </>
  );
}

function SignIn() {
  const { signIn } = useAuthActions();
  // Google is the production method. "anonymous" is a DEV-ONLY provider (enabled
  // on the deployment via OPENCLAW_ENABLE_ANON_AUTH=1) so the chat can be
  // exercised locally without OAuth credentials.
  return (
    <div className="oc-signin">
      <h1 className="oc-signin__title">OpenClaw webchat</h1>
      <button
        type="button"
        className="oc-signin__btn"
        onClick={() => void signIn("google")}
      >
        Sign in with Google
      </button>
      <button
        type="button"
        className="oc-signin__btn oc-signin__btn--dev"
        onClick={() => void signIn("anonymous")}
      >
        Continue (dev, no account)
      </button>
    </div>
  );
}

function ChatWorkspace() {
  const chats = useQuery(api.messages.listChats, {}) as
    | Array<{ _id: ConvexId<"chats">; title: string }>
    | undefined;
  const createChat = useMutation(api.chats.createChat);
  const [activeChatId, setActiveChatId] = useState<ConvexId<"chats"> | null>(
    null,
  );

  const effectiveChatId =
    activeChatId ?? (chats && chats.length > 0 ? chats[0]._id : null);

  return (
    <div className="oc-workspace">
      <aside className="oc-sidebar">
        <button
          type="button"
          className="oc-sidebar__new"
          onClick={async () => {
            const id = (await createChat({ title: "New chat" })) as ConvexId<"chats">;
            setActiveChatId(id);
          }}
        >
          New chat
        </button>
        <nav className="oc-sidebar__list">
          {(chats ?? []).map((c) => (
            <button
              type="button"
              key={c._id}
              className={
                "oc-sidebar__item" +
                (c._id === effectiveChatId ? " oc-sidebar__item--active" : "")
              }
              onClick={() => setActiveChatId(c._id)}
            >
              {c.title || "Untitled"}
            </button>
          ))}
        </nav>
      </aside>
      <main className="oc-main">
        <ConvexChat chatId={effectiveChatId} />
      </main>
    </div>
  );
}
