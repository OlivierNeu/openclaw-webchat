import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Link } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { api } from "./convexApi";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Per-user notification zone (UI-9 increment C). Surfaces the user's OWN
// feedback reports and the admin's responses (a feedback-derived inbox — no
// separate notifications table). The badge is a reactive Convex query, so it
// updates live the instant an admin responds; opening the panel marks all read
// (a NO-OP server-side under impersonation, so an admin peeking AS the user
// never clears that user's badge).

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

function NotifItem({ item }: { item: FeedbackItem }) {
  return (
    <div className={`oc-notif__item${item.unread ? " is-unread" : ""}`}>
      <div className="oc-notif__item-head">
        <span className="oc-notif__cat">{cat(item.category)}</span>
        <span
          className={`oc-notif__status${item.answered ? " is-answered" : ""}`}
        >
          {item.answered ? "Répondu" : "En attente"}
        </span>
      </div>
      <div className="oc-notif__when">
        {new Date(item.at).toLocaleString("fr-FR")} ·{" "}
        {item.messageRole === "user" ? "votre message" : "réponse IA"}
      </div>
      {item.comment ? (
        <p className="oc-notif__comment">« {item.comment} »</p>
      ) : null}
      {item.thread.length > 0 ? (
        <div className="oc-notif__thread">
          {item.thread.map((m, i) => (
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
        params={{ chatId: item.chatId }}
        className="oc-notif__link"
      >
        Voir la conversation
      </Link>
    </div>
  );
}

export function NotificationBell() {
  const unread = useQuery(api.feedback.myUnreadFeedbackCount) ?? 0;
  const items = useQuery(api.feedback.myFeedback) as FeedbackItem[] | undefined;
  const markRead = useMutation(api.feedback.markAllMyFeedbackRead);
  const [open, setOpen] = useState(false);

  function onOpenChange(next: boolean) {
    setOpen(next);
    // Opening clears the badge (server NO-OPs under impersonation).
    if (next && unread > 0) void markRead({});
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="oc-bell"
          aria-label={
            unread > 0
              ? `Notifications (${unread} non lus)`
              : "Notifications"
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
        <div className="oc-notif__head">Mes signalements</div>
        {items === undefined ? (
          <div className="oc-notif__empty">Chargement…</div>
        ) : items.length === 0 ? (
          <div className="oc-notif__empty">
            Aucun signalement envoyé. Utilisez le drapeau sous un message pour en
            créer un.
          </div>
        ) : (
          <div className="oc-notif__list">
            {items.map((it) => (
              <NotifItem key={it._id} item={it} />
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
