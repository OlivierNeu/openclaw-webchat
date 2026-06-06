import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convexApi";
import { DataTableShell } from "./DataTableShell";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Settings › Intégrations. Configures NON-SECRET integration knobs (host /
// baseUrl / workspace / enabled + the tts/talk settings). API KEYS are NEVER
// edited here — they live in the deployment env; this UI only shows a per-vendor
// "configured" indicator derived server-side from env presence. Resolution
// precedence (server): Convex value -> env -> default, so an empty field falls
// back to env (never clobbers a deployment that sets the env var).
//
// Status honesty: Langfuse/Opik have a REAL consumer (the trace shipper) → live.
// TTS/Talk are consumed by the bridge worker (not built yet) → stored + labeled
// "appliqué par le bridge (à venir)".

type VendorKnobs = {
  host?: string;
  baseUrl?: string;
  workspace?: string;
  enabled?: boolean;
};
type VoiceKnobs = Record<string, string | number | boolean | undefined>;

type Status = {
  langfuse: { configured: boolean; enabled: boolean; effectiveHost: string };
  opik: {
    configured: boolean;
    enabled: boolean;
    effectiveBaseUrl: string;
    effectiveWorkspace: string;
  };
  config: {
    langfuse: VendorKnobs;
    opik: VendorKnobs;
    tts: VoiceKnobs;
    talk: VoiceKnobs;
  };
  secrets: { openai: boolean };
  cursors: Array<{
    vendor: string;
    lastAt: number;
    failureCount: number;
    lastError: string | null;
    lastErrorStatus: number | null;
  }>;
};

export function IntegrationsTab() {
  const status = useQuery(api.integrations.status.status, {}) as
    | Status
    | undefined;
  const setCfg = useMutation(api.admin.setIntegrationConfig);

  // Local editable draft, seeded once when the status first loads. The admin is
  // the only editor, so we don't fight reactive updates after seeding.
  const [draft, setDraft] = useState<Status["config"] | null>(null);
  useEffect(() => {
    if (status && draft === null) setDraft(status.config);
  }, [status, draft]);

  if (!status || !draft) {
    return <p className="oc-admin__hint">Chargement…</p>;
  }

  const d = draft;
  const setField = (
    section: keyof Status["config"],
    key: string,
    value: string | number | boolean | undefined,
  ) => setDraft({ ...d, [section]: { ...d[section], [key]: value } });

  // Commit one section to Convex (called on blur for text, immediately for
  // selects/checkboxes). Typed against the BACKEND validator (not the loose
  // frontend VoiceKnobs), so a field name that drifts from
  // convex/admin.setIntegrationConfig is a tsc error — not a silent runtime
  // validator rejection (the `as never` trap the reviewer flagged).
  type SetArgs = NonNullable<Parameters<typeof setCfg>[0]>;
  const commit = <K extends keyof SetArgs>(
    section: K,
    patch: NonNullable<SetArgs[K]>,
  ) => void setCfg({ [section]: patch } as SetArgs);

  return (
    <>
      <p className="oc-admin__hint">
        Configuration des intégrations. <strong>Aucune clé API ici</strong> —
        elles vivent dans l'environnement du déploiement ; un champ vide retombe
        sur la variable d'environnement puis le défaut. L'indicateur
        « configuré » reflète la présence de la clé côté serveur.
      </p>

      {/* ── Langfuse (trace shipping — LIVE) ─────────────────────────── */}
      <Section
        title="Langfuse"
        status={
          status.langfuse.configured ? (
            status.langfuse.enabled ? (
              <Badge variant="secondary">actif</Badge>
            ) : (
              <Badge variant="outline">en pause</Badge>
            )
          ) : (
            <Badge variant="outline">clé manquante (env)</Badge>
          )
        }
        note="Export des traces. Clés : LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY (env)."
      >
        <Field label="Host">
          <Input
            value={d.langfuse.host ?? ""}
            placeholder={status.langfuse.effectiveHost}
            onChange={(e) => setField("langfuse", "host", e.target.value)}
            onBlur={() => commit("langfuse", { host: d.langfuse.host ?? "" })}
          />
        </Field>
        <ToggleRow
          label="Activé (expédition des traces)"
          checked={d.langfuse.enabled ?? true}
          onChange={(v) => {
            setField("langfuse", "enabled", v);
            commit("langfuse", { enabled: v });
          }}
        />
      </Section>

      {/* ── Opik (trace shipping — LIVE) ─────────────────────────────── */}
      <Section
        title="Opik"
        status={
          status.opik.configured ? (
            status.opik.enabled ? (
              <Badge variant="secondary">actif</Badge>
            ) : (
              <Badge variant="outline">en pause</Badge>
            )
          ) : (
            <Badge variant="outline">clé manquante (env)</Badge>
          )
        }
        note="Export des traces. Clé : OPIK_API_KEY (env)."
      >
        <Field label="Base URL">
          <Input
            value={d.opik.baseUrl ?? ""}
            placeholder={status.opik.effectiveBaseUrl}
            onChange={(e) => setField("opik", "baseUrl", e.target.value)}
            onBlur={() => commit("opik", { baseUrl: d.opik.baseUrl ?? "" })}
          />
        </Field>
        <Field label="Workspace">
          <Input
            value={d.opik.workspace ?? ""}
            placeholder={status.opik.effectiveWorkspace || "(défaut serveur)"}
            onChange={(e) => setField("opik", "workspace", e.target.value)}
            onBlur={() =>
              commit("opik", { workspace: d.opik.workspace ?? "" })
            }
          />
        </Field>
        <ToggleRow
          label="Activé (expédition des traces)"
          checked={d.opik.enabled ?? true}
          onChange={(v) => {
            setField("opik", "enabled", v);
            commit("opik", { enabled: v });
          }}
        />
      </Section>

      {/* ── TTS (consumer = bridge, pending) ─────────────────────────── */}
      <Section
        title="Synthèse vocale (TTS)"
        status={<Badge variant="outline">appliqué par le bridge (à venir)</Badge>}
        note="Lecture audio des réponses. Clé du provider via env (ex. OPENAI_API_KEY, ELEVENLABS_API_KEY)."
      >
        <Field label="Mode auto">
          <SelectField
            value={(d.tts.auto as string) ?? "off"}
            options={[
              ["off", "Désactivé"],
              ["always", "Toujours"],
              ["inbound", "Après un message vocal"],
              ["tagged", "Sur directive [[tts:…]]"],
            ]}
            onChange={(v) => {
              setField("tts", "auto", v);
              commit("tts", { auto: v });
            }}
          />
        </Field>
        <Field label="Provider">
          <SelectField
            value={(d.tts.provider as string) ?? "openai"}
            options={[
              ["openai", "OpenAI"],
              ["elevenlabs", "ElevenLabs"],
              ["microsoft", "Microsoft (sans clé)"],
              ["azure", "Azure Speech"],
              ["google", "Google Gemini"],
            ]}
            onChange={(v) => {
              setField("tts", "provider", v);
              commit("tts", { provider: v });
            }}
          />
        </Field>
        <Field label="Modèle">
          <Input
            value={(d.tts.model as string) ?? ""}
            placeholder="eleven_multilingual_v2"
            onChange={(e) => setField("tts", "model", e.target.value)}
            onBlur={() => commit("tts", { model: (d.tts.model as string) ?? "" })}
          />
        </Field>
        <Field label="Voix">
          <Input
            value={(d.tts.voice as string) ?? ""}
            placeholder="speakerVoiceId / nom de voix"
            onChange={(e) => setField("tts", "voice", e.target.value)}
            onBlur={() => commit("tts", { voice: (d.tts.voice as string) ?? "" })}
          />
        </Field>
      </Section>

      {/* ── Talk / STS (consumer = bridge, pending) ──────────────────── */}
      <Section
        title="Mode conversation (Talk / STS)"
        status={<Badge variant="outline">appliqué par le bridge (à venir)</Badge>}
        note={
          status.secrets.openai
            ? "OpenAI realtime : OPENAI_API_KEY présent (env). Le navigateur recevra un jeton éphémère minté côté serveur — jamais la clé brute."
            : "OpenAI realtime : OPENAI_API_KEY ABSENT (env). À définir côté déploiement pour activer gpt-realtime."
        }
      >
        <ToggleRow
          label="Activer le mode conversation"
          checked={(d.talk.enabled as boolean) ?? false}
          onChange={(v) => {
            setField("talk", "enabled", v);
            commit("talk", { enabled: v });
          }}
        />
        <Field label="Provider realtime">
          <SelectField
            value={(d.talk.realtimeProvider as string) ?? "openai"}
            options={[
              ["openai", "OpenAI (gpt-realtime)"],
              ["google", "Google"],
            ]}
            onChange={(v) => {
              setField("talk", "realtimeProvider", v);
              commit("talk", { realtimeProvider: v });
            }}
          />
        </Field>
        <Field label="Modèle realtime">
          <Input
            value={(d.talk.realtimeModel as string) ?? ""}
            placeholder="gpt-realtime-2"
            onChange={(e) => setField("talk", "realtimeModel", e.target.value)}
            onBlur={() =>
              commit("talk", { realtimeModel: (d.talk.realtimeModel as string) ?? "" })
            }
          />
        </Field>
        <Field label="Voix">
          <Input
            value={(d.talk.voice as string) ?? ""}
            placeholder="cedar / marin"
            onChange={(e) => setField("talk", "voice", e.target.value)}
            onBlur={() => commit("talk", { voice: (d.talk.voice as string) ?? "" })}
          />
        </Field>
        <Field label="Transport">
          <SelectField
            value={(d.talk.transport as string) ?? "webrtc"}
            options={[
              ["webrtc", "WebRTC (navigateur)"],
              ["provider-websocket", "Provider WebSocket"],
              ["gateway-relay", "Gateway relay"],
            ]}
            onChange={(v) => {
              setField("talk", "transport", v);
              commit("talk", { transport: v });
            }}
          />
        </Field>
        <Field label="Locale">
          <Input
            value={(d.talk.speechLocale as string) ?? ""}
            placeholder="fr-CA"
            onChange={(e) => setField("talk", "speechLocale", e.target.value)}
            onBlur={() =>
              commit("talk", { speechLocale: (d.talk.speechLocale as string) ?? "" })
            }
          />
        </Field>
        <ToggleRow
          label="Interrompre la lecture quand l'utilisateur parle"
          checked={(d.talk.interruptOnSpeech as boolean) ?? true}
          onChange={(v) => {
            setField("talk", "interruptOnSpeech", v);
            commit("talk", { interruptOnSpeech: v });
          }}
        />
      </Section>

      {/* ── Voice wake (feasibility note — not buildable in browser) ──── */}
      <section className="oc-int__section">
        <div className="oc-int__section-head">
          <h3 className="oc-uipa__h">Voice wake (mot d'activation)</h3>
          <Badge variant="outline">non câblable dans le navigateur</Badge>
        </div>
        <p className="oc-uipa__note">
          OpenClaw gère le voice-wake côté Gateway avec détection native
          macOS/iOS (Android = micro manuel) ; le navigateur n'est pas une
          plateforme supportée. Le câbler dans ce webchat nécessiterait un moteur
          wake-word côté client (type Porcupine) que nous bâtirions — hors de
          OpenClaw. Configuration des déclencheurs : RPC gateway
          <code> voicewake.get/set</code>.
        </p>
      </section>

      <DataTableShell
        title="Curseurs d'expédition"
        rows={status.cursors.map((c) => ({ ...c, _id: c.vendor }))}
        emptyHint="Aucun curseur — aucune trace n'a encore été expédiée."
        columns={[
          { header: "Vendeur", cell: (c) => <Badge variant="secondary">{c.vendor}</Badge> },
          {
            header: "Dernier envoi",
            cell: (c) =>
              c.lastAt > 0 ? new Date(c.lastAt).toLocaleString("fr-FR") : "—",
          },
          { header: "Échecs consécutifs", cell: (c) => String(c.failureCount) },
          { header: "Dernier statut HTTP", cell: (c) => c.lastErrorStatus ?? "—" },
          { header: "Dernière erreur", cell: (c) => c.lastError ?? "—" },
        ]}
      />
    </>
  );
}

function Section({
  title,
  status,
  note,
  children,
}: {
  title: string;
  status: React.ReactNode;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="oc-int__section">
      <div className="oc-int__section-head">
        <h3 className="oc-uipa__h">{title}</h3>
        {status}
      </div>
      {note ? <p className="oc-uipa__note">{note}</p> : null}
      <div className="oc-int__fields">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="oc-int__field">
      <span className="oc-int__field-label">{label}</span>
      {children}
    </label>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="oc-int__toggle">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <span>{label}</span>
    </label>
  );
}

function SelectField({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, label]) => (
          <SelectItem key={v} value={v}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
