import * as React from "react";
import { useState } from "react";
import { useMessage } from "@assistant-ui/react";
import { useMutation, useQuery } from "convex/react";
import { Flag } from "lucide-react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";

// OpenRouter-style "Report Feedback". Flagging a message FREEZES a forensic
// snapshot server-side (convex/feedback.ts) so a later delete/regenerate cannot
// erase the disputed evidence, and surfaces the server's browser-fidelity verdict.
//
// ARCHITECTURE: the dialog is rendered ONCE at app root via <FeedbackProvider>,
// NOT inside the per-message action bar. The action bar uses assistant-ui
// `autohide` which UNMOUNTS its children on mouse-leave — a dialog nested in it
// dies the instant the cursor leaves the bubble (which is exactly what a user
// does to reach the dialog). So `FeedbackButton` only CAPTURES the target +
// rendered text at click time and hands it to the root dialog, whose lifecycle
// is independent of the hover/autohide state. Mirrors the useConfirm pattern.

const COMMENT_MAX = 1000;

type MsgRole = "user" | "assistant" | "system";

// Category id -> French label, PER ROLE. The ids MUST exist in
// convex/feedback.ts FEEDBACK_CATEGORIES (server is the single source of truth).
// An AI report and a user report are different acts: the assistant-response set
// is about generation quality; the user-message set is about "what I typed was
// changed on the way out" (the headline dispute).
const AI_CATEGORIES: { id: string; label: string }[] = [
  { id: "incorrect", label: "Réponse incorrecte" },
  { id: "incoherence", label: "Incohérence" },
  { id: "altered_words", label: "Mots / orthographe erronés" },
  { id: "formatting", label: "Formatage" },
  { id: "latency", label: "Latence" },
  { id: "api_error", label: "Erreur API" },
  { id: "other", label: "Autre" },
];
const USER_CATEGORIES: { id: string; label: string }[] = [
  { id: "altered_words", label: "Mots modifiés à l'envoi" },
  { id: "formatting", label: "Caractères / mise en forme altérés" },
  { id: "other", label: "Autre" },
];

function categoriesFor(role: MsgRole) {
  return role === "user" ? USER_CATEGORIES : AI_CATEGORIES;
}

type FeedbackTarget = {
  chatId: string;
  messageId: string;
  role: MsgRole;
  // Client declarations captured AT CLICK TIME, in the message context:
  displayedText: string;
  sourceWasOpen: boolean;
};

type FeedbackApi = (target: FeedbackTarget) => void;

const FeedbackContext = React.createContext<FeedbackApi | null>(null);

export function useFeedback(): FeedbackApi {
  const ctx = React.useContext(FeedbackContext);
  if (!ctx) {
    throw new Error("useFeedback must be used within <FeedbackProvider>");
  }
  return ctx;
}

// App-root dialog. Holds the form state + the active target; immune to the
// per-message action bar's autohide unmount.
export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const submit = useMutation(api.feedback.submitFeedback);

  const [target, setTarget] = useState<FeedbackTarget | null>(null);
  const [category, setCategory] = useState("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [verdict, setVerdict] = useState<boolean | null | undefined>(null);

  const open: FeedbackApi = React.useCallback((t) => {
    setCategory("");
    setComment("");
    setSubmitting(false);
    setVerdict(null);
    setTarget(t);
  }, []);

  function onOpenChange(next: boolean) {
    if (!next) setTarget(null);
  }

  async function onSubmit() {
    if (!target || !category || submitting) return;
    setSubmitting(true);
    try {
      const res = await submit({
        chatId: target.chatId as Id<"chats">,
        messageId: target.messageId as Id<"messages">,
        category,
        comment: comment.trim() || undefined,
        client: {
          displayedText: target.displayedText,
          sourceWasOpen: target.sourceWasOpen,
          userAgent: navigator.userAgent,
          language: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          theme: document.documentElement.classList.contains("dark")
            ? "dark"
            : "light",
        },
      });
      setVerdict(res.displayedMatchesStored);
    } catch {
      setSubmitting(false);
    }
  }

  const submitted = verdict !== null;
  const isUser = target?.role === "user";

  return (
    <FeedbackContext.Provider value={open}>
      {children}

      <Dialog open={target !== null} onOpenChange={onOpenChange}>
        {target ? (
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Signaler un problème</DialogTitle>
              <DialogDescription>
                {submitted
                  ? "Merci. Un instantané complet de ce message a été figé pour analyse."
                  : isUser
                    ? "Signalez un problème avec votre message tel qu'il a été envoyé. Un instantané forensique exact est enregistré."
                    : "Signalez un problème avec cette réponse. Un instantané forensique exact est enregistré au moment de l'envoi."}
              </DialogDescription>
            </DialogHeader>

            {submitted ? (
              <div className="oc-feedback__result" role="status">
                {/* HONEST verdict: the strong display-fidelity claim is made ONLY
                    when the source view was open (we read the actual rendered
                    `.oc-msg__source-pre` textContent). With it closed,
                    displayedText fell back to the received `rawText` — a match
                    proves transport consistency, NOT faithful rendering. */}
                {target.sourceWasOpen ? (
                  verdict === true ? (
                    <p className="oc-feedback__fidelity is-ok">
                      ✓ Le texte affiché (vue source) correspond exactement,
                      caractère pour caractère, au texte stocké côté serveur. La
                      comparaison est figée comme preuve.
                    </p>
                  ) : (
                    <p className="oc-feedback__fidelity is-warn">
                      ⚠ Écart détecté entre le texte affiché (vue source) et le
                      texte stocké. L'instantané a figé les deux versions.
                    </p>
                  )
                ) : (
                  <p className="oc-feedback__fidelity">
                    Instantané enregistré. Pour vérifier que l'affichage n'altère
                    aucun caractère, ouvrez la vue source (&lt;/&gt;) sur ce
                    message puis signalez à nouveau : la comparaison portera alors
                    sur le texte réellement affiché par le navigateur.
                  </p>
                )}
              </div>
            ) : (
              <div className="oc-feedback__form">
                <label className="oc-feedback__label">Catégorie</label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choisir une catégorie" />
                  </SelectTrigger>
                  <SelectContent>
                    {categoriesFor(target.role).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <label
                  className="oc-feedback__label"
                  htmlFor="oc-feedback-comment"
                >
                  Commentaire
                </label>
                <textarea
                  id="oc-feedback-comment"
                  className="oc-feedback__textarea"
                  placeholder="Décrivez le problème…"
                  value={comment}
                  maxLength={COMMENT_MAX}
                  onChange={(e) =>
                    setComment(e.target.value.slice(0, COMMENT_MAX))
                  }
                  rows={4}
                />
                <div className="oc-feedback__count">
                  {comment.length}/{COMMENT_MAX}
                </div>
              </div>
            )}

            <DialogFooter>
              {submitted ? (
                <Button onClick={() => onOpenChange(false)}>Fermer</Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    Annuler
                  </Button>
                  <Button
                    onClick={() => void onSubmit()}
                    disabled={!category || submitting}
                  >
                    {submitting ? "Envoi…" : "Envoyer"}
                  </Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </FeedbackContext.Provider>
  );
}

// Read what the BROWSER actually rendered for this message, byte-exact. Prefer
// the open source view (`.oc-msg__source-pre`, ligatures disabled) over the
// markdown body (which transforms text by design → false mismatches). Falls back
// to the client's received copy (`rawText`) when the source view is closed.
function captureDisplayed(
  btn: HTMLElement,
  rawText: string,
): { displayedText: string; sourceWasOpen: boolean } {
  const root = btn.closest(".oc-msg");
  const pre = root?.querySelector<HTMLElement>(".oc-msg__source-pre");
  const t = pre?.textContent;
  if (pre && t != null && t !== "(aucun texte)") {
    return { displayedText: t, sourceWasOpen: true };
  }
  return { displayedText: rawText, sourceWasOpen: false };
}

// The per-message flag. Lives inside the (autohiding) action bar, but only
// captures + delegates to the root dialog — so the dialog survives the bar's
// unmount on mouse-leave.
export function FeedbackButton() {
  const openFeedback = useFeedback();
  const messageId = useMessage(
    (m) => (m.metadata?.custom as { messageId?: string } | undefined)?.messageId,
  );
  const chatId = useMessage(
    (m) => (m.metadata?.custom as { chatId?: string } | undefined)?.chatId,
  );
  const role = useMessage((m) => m.role) as MsgRole;
  const rawText = useMessage(
    (m) => (m.metadata?.custom as { rawText?: string } | undefined)?.rawText ?? "",
  );

  const reported = useQuery(
    api.feedback.myReportedMessageIds,
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  );

  if (!messageId || !chatId) return null;
  const alreadyReported = (reported ?? []).includes(messageId);

  function onFlag(e: React.MouseEvent<HTMLButtonElement>) {
    const cap = captureDisplayed(e.currentTarget, rawText);
    openFeedback({
      chatId: chatId as string,
      messageId: messageId as string,
      role,
      ...cap,
    });
  }

  return (
    <button
      type="button"
      className={`oc-iconbtn${alreadyReported ? " is-on" : ""}`}
      title={alreadyReported ? "Problème signalé" : "Signaler un problème"}
      aria-label="Signaler un problème avec ce message"
      onClick={onFlag}
    >
      <Flag size={15} aria-hidden />
    </button>
  );
}
