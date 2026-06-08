import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Bell,
  Check,
  X,
  TriangleAlert,
  CircleCheck,
  MessageSquare,
} from "lucide-react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Per-user notification zone (the bell) — the SINGLE source of truth for the
// unread badge (convex/notifications). Surfaces ANOMALIES (admin) + feedback
// replies as non-PHI pointers, with per-item mark-read / clear + bulk actions.
// A SECONDARY "Mes signalements" section keeps the feedback exchange threads
// readable (the reply TEXT lives there, never in a notification). All writes
// NO-OP under impersonation server-side.

const CATEGORY_LABELS: Record<string, string> = {
  altered_words: "Mots modifiés / altérés",
  incorrect: "Réponse incorrecte",
  incoherence: "Incohérence",
  formatting: "Formatage",
  latency: "Latence",
  api_error: "Erreur API",
  other: "Autre",
};
const cat = (id: string) => CATEGORY_LABELS[id] ?? id;

type NotifKind = "anomaly_open" | "anomaly_resolved" | "feedback_reply";
type Notif = {
  _id: Id<"notifications">;
  kind: NotifKind;
  title: string;
  body: string;
  href: string | null;
  createdAt: number;
  unread: boolean;
};

const KIND_ICON: Record<NotifKind, typeof Bell> = {
  anomaly_open: TriangleAlert,
  anomaly_resolved: CircleCheck,
  feedback_reply: MessageSquare,
};

type ThreadMsg = { authorRole: "admin" | "user"; text: string; at: number };
type FeedbackItem = {
  _id: string;
  at: number;
  category: string;
  comment: string | null;
  messageRole: string;
  chatId: string;
  thread: ThreadMsg[];
  answered: boolean;
  unread: boolean;
};

export function NotificationBell() {
  const unread = useQuery(api.notifications.myUnreadCount) ?? 0;
  const items = useQuery(api.notifications.myNotifications) as
    | Notif[]
    | undefined;
  const feedback = useQuery(api.feedback.myFeedback) as
    | FeedbackItem[]
    | undefined;
  const markRead = useMutation(api.notifications.markRead);
  const markAllRead = useMutation(api.notifications.markAllRead);
  const clearOne = useMutation(api.notifications.clearOne);
  const clearAll = useMutation(api.notifications.clearAll);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const openItem = (n: Notif) => {
    if (n.unread) void markRead({ notificationId: n._id });
    if (!n.href) return;
    setOpen(false);
    // hrefs are produced server-side (controlled set). Two shapes:
    //   /chat/<chatId>                       → a reported conversation (feedback)
    //   /settings/anomalies[?status=resolved] → a filtered anomalies view
    if (n.href.startsWith("/chat/")) {
      void navigate({
        to: "/chat/$chatId",
        params: { chatId: n.href.slice("/chat/".length) },
      });
      return;
    }
    // Split the optional query so the deep-link lands on the right FILTERED view
    // (the tab defaults to open, which would hide a resolved anomaly). zod
    // re-validates the search on navigation.
    const [path, query] = n.href.split("?");
    void navigate({
      to: path as "/settings/anomalies",
      search: Object.fromEntries(new URLSearchParams(query ?? "")) as {
        status?: "open" | "acknowledged" | "resolved" | "all";
      },
    });
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="oc-bell"
          aria-label={
            unread > 0 ? `Notifications (${unread} non lues)` : "Notifications"
          }
        >
          <Bell size={18} aria-hidden />
          {unread > 0 ? (
            <span className="oc-bell__badge" aria-hidden>
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="oc-notif">
        <div className="oc-notif__head">
          <span>Notifications</span>
          {items && items.length > 0 ? (
            <span className="oc-notif__bulk">
              <button
                type="button"
                className="oc-notif__act"
                disabled={unread === 0}
                onClick={() => void markAllRead({})}
              >
                Tout lu
              </button>
              <button
                type="button"
                className="oc-notif__act"
                onClick={() => void clearAll({})}
              >
                Tout effacer
              </button>
            </span>
          ) : null}
        </div>

        {items === undefined ? (
          <div className="oc-notif__empty">Chargement…</div>
        ) : items.length === 0 ? (
          <div className="oc-notif__empty">Aucune notification.</div>
        ) : (
          <div className="oc-notif__list">
            {items.map((n) => {
              const Icon = KIND_ICON[n.kind] ?? Bell;
              return (
                <div
                  key={n._id}
                  className={`oc-notif__item${n.unread ? " is-unread" : ""}${
                    n.href ? " is-link" : ""
                  }`}
                  role={n.href ? "button" : undefined}
                  tabIndex={n.href ? 0 : undefined}
                  onClick={n.href ? () => openItem(n) : undefined}
                >
                  <div className="oc-notif__item-head">
                    <Icon
                      size={14}
                      className={`oc-notif__kind oc-notif__kind--${n.kind}`}
                      aria-hidden
                    />
                    <span className="oc-notif__title">{n.title}</span>
                    <span className="oc-notif__row-actions">
                      {n.unread ? (
                        <button
                          type="button"
                          title="Marquer comme lue"
                          aria-label="Marquer comme lue"
                          onClick={(e) => {
                            e.stopPropagation();
                            void markRead({ notificationId: n._id });
                          }}
                        >
                          <Check size={13} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        title="Effacer"
                        aria-label="Effacer la notification"
                        onClick={(e) => {
                          e.stopPropagation();
                          void clearOne({ notificationId: n._id });
                        }}
                      >
                        <X size={13} />
                      </button>
                    </span>
                  </div>
                  <p className="oc-notif__body">{n.body}</p>
                  <div className="oc-notif__when">
                    {new Date(n.createdAt).toLocaleString("fr-FR")}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Secondary: feedback exchange threads (read the admin's reply text). */}
        {feedback && feedback.length > 0 ? (
          <>
            <div className="oc-notif__head oc-notif__head--sub">
              Mes signalements
            </div>
            <div className="oc-notif__list">
              {feedback.map((it) => (
                <div key={it._id} className="oc-notif__item">
                  <div className="oc-notif__item-head">
                    <span className="oc-notif__title">{cat(it.category)}</span>
                    <span
                      className={`oc-notif__status${
                        it.answered ? " is-answered" : ""
                      }`}
                    >
                      {it.answered ? "Répondu" : "En attente"}
                    </span>
                  </div>
                  {it.thread.length > 0 ? (
                    <div className="oc-notif__thread">
                      {it.thread.map((m, i) => (
                        <div
                          key={i}
                          className={`oc-notif__msg oc-notif__msg--${m.authorRole}`}
                        >
                          <span className="oc-notif__msg-who">
                            {m.authorRole === "admin" ? "Administrateur" : "Vous"}
                          </span>
                          <span className="oc-notif__msg-text">{m.text}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <Link
                    to="/chat/$chatId"
                    params={{ chatId: it.chatId }}
                    className="oc-notif__link"
                    onClick={() => setOpen(false)}
                  >
                    Voir la conversation
                  </Link>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
