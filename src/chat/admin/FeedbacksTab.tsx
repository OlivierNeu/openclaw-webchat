import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "./DataTableShell";

// Increment B — admin administration of recorded feedback (Settings › Feedbacks).
//
// SPLIT BY SENSITIVITY (Olivier's rule): the table shows METADATA only (no
// message content), so listing is unaudited like the audit/trace logs. Opening a
// row's DETAIL calls `readSnapshot` — a MUTATION that is gated by
// `traces.read.content` and AUDITS the cross-user content access — so every time
// an admin actually views another user's message content, it is traced.

type Row = {
  _id: string;
  at: number;
  category: string;
  hasComment: boolean;
  messageRole: string;
  displayedMatchesStored?: boolean;
  sourceWasOpen: boolean;
  impersonated: boolean;
  answered: boolean;
  reporterEmail: string | null;
  reporterName: string | null;
  realOperatorEmail: string | null;
  chatId: string;
  messageId: string;
};

type ThreadMsg = { authorRole: "admin" | "user"; text: string; at: number };

type Snapshot = {
  _id: string;
  category: string;
  comment: string | null;
  at: number;
  thread: ThreadMsg[];
  snapshot: {
    messageRole: string;
    messageText: string;
    runId?: string;
    isRegeneration?: boolean;
    promptText?: string;
    contextJson?: string;
    contextCount?: number;
    contextTruncated?: boolean;
    openclawModel?: string;
    openclawProvider?: string;
    openclawRuntime?: string;
    sessionSettings?: { thinkingLevel?: string; model?: string };
    outboxText?: string;
    outboxStatus?: string;
    outboxAvailable?: boolean;
    displayedText?: string;
    displayedMatchesStored?: boolean;
    clientInfo?: {
      userAgent?: string;
      language?: string;
      timezone?: string;
      theme?: string;
      sourceWasOpen?: boolean;
      plugins?: string[];
      extensionsDetected?: string[];
    };
  };
};

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

function FidelityBadge({
  matches,
  sourceWasOpen,
}: {
  matches?: boolean;
  sourceWasOpen: boolean;
}) {
  // Honest: the strong "display" claim only holds when the source view was open.
  if (!sourceWasOpen) return <span className="oc-fbadmin__pill">reçu = stocké</span>;
  if (matches === true)
    return <span className="oc-fbadmin__pill is-ok">affichage fidèle ✓</span>;
  if (matches === false)
    return <span className="oc-fbadmin__pill is-warn">écart ⚠</span>;
  return <span className="oc-fbadmin__pill">—</span>;
}

function Detail({ data }: { data: Snapshot }) {
  const s = data.snapshot;
  const respond = useMutation(api.feedback.respondToFeedback);
  // Local thread (optimistic): the admin just authored the reply, so append it
  // without re-reading (readSnapshot is one-shot + audited).
  const [thread, setThread] = useState<ThreadMsg[]>(data.thread);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await respond({ feedbackId: data._id as Id<"feedback">, text });
      setThread((t) => [...t, { authorRole: "admin", text, at: Date.now() }]);
      setReply("");
    } finally {
      setSending(false);
    }
  }

  let context: { role: string; text: string }[] = [];
  try {
    context = s.contextJson ? JSON.parse(s.contextJson) : [];
  } catch {
    context = [];
  }
  return (
    <div className="oc-fbadmin__detail">
      <div className="oc-fbadmin__row">
        <FidelityBadge
          matches={s.displayedMatchesStored}
          sourceWasOpen={s.clientInfo?.sourceWasOpen ?? false}
        />
        <span className="oc-fbadmin__meta">
          {cat(data.category)} · {s.messageRole}
          {s.isRegeneration ? " · régénération" : ""}
          {s.openclawModel ? ` · ${s.openclawModel}` : ""}
          {s.openclawRuntime ? ` (${s.openclawRuntime})` : ""}
        </span>
      </div>

      {data.comment ? (
        <section>
          <h4 className="oc-fbadmin__h">Commentaire du rapporteur</h4>
          <p className="oc-fbadmin__comment">{data.comment}</p>
        </section>
      ) : null}

      <section>
        <h4 className="oc-fbadmin__h">Échange avec l'utilisateur</h4>
        {thread.length > 0 ? (
          <div className="oc-fbadmin__thread">
            {thread.map((m, i) => (
              <div
                key={i}
                className={`oc-notif__msg oc-notif__msg--${m.authorRole}`}
              >
                <span className="oc-notif__msg-who">
                  {m.authorRole === "admin" ? "Administrateur" : "Utilisateur"}
                </span>
                <span className="oc-notif__msg-text">{m.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="oc-fbadmin__meta">Aucune réponse envoyée.</p>
        )}
        <textarea
          className="oc-feedback__textarea"
          placeholder="Répondre à l'utilisateur (visible dans sa zone de notification)…"
          value={reply}
          maxLength={2000}
          rows={3}
          onChange={(e) => setReply(e.target.value.slice(0, 2000))}
        />
        <div className="oc-fbadmin__row" style={{ justifyContent: "flex-end" }}>
          <Button
            size="sm"
            onClick={() => void send()}
            disabled={!reply.trim() || sending}
          >
            {sending ? "Envoi…" : "Répondre"}
          </Button>
        </div>
      </section>

      <section>
        <h4 className="oc-fbadmin__h">Texte stocké (serveur, autoritatif)</h4>
        <pre className="oc-msg__source-pre">{s.messageText || "(vide)"}</pre>
      </section>

      {s.clientInfo?.sourceWasOpen && s.displayedText !== undefined ? (
        <section>
          <h4 className="oc-fbadmin__h">
            Texte affiché (navigateur, au signalement)
          </h4>
          <pre className="oc-msg__source-pre">{s.displayedText || "(vide)"}</pre>
        </section>
      ) : null}

      {s.promptText ? (
        <section>
          <h4 className="oc-fbadmin__h">Prompt générateur</h4>
          <pre className="oc-msg__source-pre">{s.promptText}</pre>
        </section>
      ) : null}

      {context.length > 0 ? (
        <section>
          <h4 className="oc-fbadmin__h">
            Contexte figé ({s.contextCount ?? context.length} tours
            {s.contextTruncated ? ", tronqué" : ""})
          </h4>
          <div className="oc-fbadmin__ctx">
            {context.map((m, i) => (
              <div key={i} className="oc-fbadmin__ctx-turn">
                <span className="oc-fbadmin__ctx-role">{m.role}</span>
                <span className="oc-fbadmin__ctx-text">{m.text}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {s.outboxAvailable ? (
        <section>
          <h4 className="oc-fbadmin__h">Payload dispatché (outbox)</h4>
          <pre className="oc-msg__source-pre">
            {s.outboxText ?? ""}
            {s.outboxStatus ? `\n[status: ${s.outboxStatus}]` : ""}
          </pre>
        </section>
      ) : null}

      {s.clientInfo?.extensionsDetected &&
      s.clientInfo.extensionsDetected.length > 0 ? (
        <section>
          <h4 className="oc-fbadmin__h">
            Extensions de correction détectées (peuvent altérer le texte)
          </h4>
          <div className="oc-fbadmin__row">
            {s.clientInfo.extensionsDetected.map((e) => (
              <span key={e} className="oc-fbadmin__pill is-warn">
                {e}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h4 className="oc-fbadmin__h">Environnement client</h4>
        <p className="oc-fbadmin__env">
          {[
            s.clientInfo?.language,
            s.clientInfo?.timezone,
            s.clientInfo?.theme ? `thème ${s.clientInfo.theme}` : null,
            s.runId ? `run ${s.runId.slice(0, 12)}…` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "—"}
          {s.clientInfo?.plugins && s.clientInfo.plugins.length > 0 ? (
            <span className="oc-fbadmin__plugins">
              Plugins : {s.clientInfo.plugins.join(", ")}
              <span className="oc-fbadmin__note">
                {" "}
                (navigator.plugins — neutralisé/partiel dans les navigateurs
                modernes)
              </span>
            </span>
          ) : null}
          {s.clientInfo?.userAgent ? (
            <span className="oc-fbadmin__ua">{s.clientInfo.userAgent}</span>
          ) : null}
        </p>
      </section>
    </div>
  );
}

export function FeedbacksTab() {
  const rows = useQuery(api.feedback.listForAdmin, {}) as Row[] | undefined;
  const readSnapshot = useMutation(api.feedback.readSnapshot);
  const remove = useMutation(api.feedback.deleteFeedback);
  const confirm = useConfirm();

  const [openId, setOpenId] = useState<string | null>(null);
  const [byId, setById] = useState<Record<string, Snapshot>>({});

  async function toggle(row: Row) {
    if (openId === row._id) {
      setOpenId(null);
      return;
    }
    if (!byId[row._id]) {
      // AUDITED content read (gated traces.read.content).
      const data = (await readSnapshot({
        feedbackId: row._id as Id<"feedback">,
      })) as Snapshot;
      setById((m) => ({ ...m, [row._id]: data }));
    }
    setOpenId(row._id);
  }

  async function onDelete(row: Row) {
    const ok = await confirm({
      title: "Supprimer ce signalement ?",
      description:
        "L'instantané forensique figé sera définitivement supprimé. Cette action est irréversible.",
      confirmLabel: "Supprimer",
      destructive: true,
    });
    if (!ok) return;
    await remove({ feedbackId: row._id as Id<"feedback"> });
    if (openId === row._id) setOpenId(null);
  }

  return (
    <>
      <p className="oc-admin__hint">
        Signalements « Report Feedback » enregistrés. La liste est en
        métadonnées ; ouvrir le détail lit le contenu figé et{" "}
        <strong>trace cet accès dans l'Audit</strong> (lecture de contenu d'un
        autre utilisateur). Fenêtre récente bornée.
      </p>
      <DataTableShell<Row>
        title="Signalements"
        rows={rows}
        emptyHint="Aucun signalement pour l'instant."
        isExpanded={(r) => openId === r._id && !!byId[r._id]}
        renderExpanded={(r) =>
          byId[r._id] ? <Detail data={byId[r._id]} /> : null
        }
        columns={[
          { header: "Quand", cell: (r) => new Date(r.at).toLocaleString("fr-FR") },
          { header: "Catégorie", cell: (r) => cat(r.category) },
          { header: "Type", cell: (r) => (r.messageRole === "user" ? "user" : "AI") },
          {
            header: "Rapporteur",
            cell: (r) =>
              (r.reporterEmail || r.reporterName || "—") +
              (r.impersonated && r.realOperatorEmail
                ? ` (via ${r.realOperatorEmail})`
                : ""),
          },
          {
            header: "Fidélité",
            cell: (r) => (
              <FidelityBadge
                matches={r.displayedMatchesStored}
                sourceWasOpen={r.sourceWasOpen}
              />
            ),
          },
          { header: "Note", cell: (r) => (r.hasComment ? "✎" : "—") },
          {
            header: "Statut",
            cell: (r) =>
              r.answered ? (
                <span className="oc-fbadmin__pill is-ok">Répondu</span>
              ) : (
                <span className="oc-fbadmin__pill">En attente</span>
              ),
          },
        ]}
        rowActions={(r) => [
          {
            label: openId === r._id ? "Masquer" : "Voir le détail",
            onSelect: () => void toggle(r),
          },
          {
            label: "Supprimer",
            onSelect: () => void onDelete(r),
            variant: "destructive",
          },
        ]}
      />
    </>
  );
}
