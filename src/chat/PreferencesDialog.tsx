import * as React from "react";
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "./convexApi";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";

// User UI-preferences panel (the interface-config module). Mounted ONCE at app
// root via <PreferencesProvider> — NOT inside the UserMenu dropdown, so the menu
// closing on "Préférences…" cannot unmount the dialog (the FeedbackDialog lesson).
//
// Renders the toggles the SERVER returns (getMe.ui.effective keys) so a key the
// backend doesn't know can't appear; PREF_LABELS is display-only. The server is
// the real gate (setUiPref rejects a locked feature); here locked rows are just
// greyed with a "Non activé" note.

// Display metadata ONLY (labels/help). Keys must exist server-side to render.
// Exported so the admin "Préférences UI" tab reuses the same labels.
export const PREF_LABELS: Record<string, { label: string; help?: string }> = {
  showSource: {
    label: "Vue source des messages",
    help: "Le bouton </> qui montre le texte brut exact d'un message.",
  },
  showReport: {
    label: "Signaler un problème",
    help: "Le drapeau qui envoie un signalement (feedback) sur un message.",
  },
  copyAssistant: { label: "Copier les réponses de l'IA" },
  copyUser: { label: "Copier vos messages" },
  showDelete: { label: "Supprimer un message" },
  showTools: {
    label: "Cartes d'outils",
    help: "Afficher les exécutions d'outils de l'agent dans le fil.",
  },
  voiceInput: {
    label: "Saisie vocale (micro)",
    help: "Le bouton micro dans le composeur.",
  },
  showChatAge: {
    label: "Âge des conversations",
    help: "Afficher l'ancienneté de chaque conversation (ex. « 3j », « 2sem ») dans la liste à gauche.",
  },
  showChatProvider: {
    label: "Bridge des conversations",
    help: "Marquer le bridge (OpenClaw / Hermes) de chaque conversation dans la liste à gauche. Apparaît uniquement si vos conversations utilisent plusieurs bridges.",
  },
};

type UiState = {
  effective: Record<string, boolean>;
  locked: Record<string, boolean>;
  userOverrides: Record<string, boolean | undefined>;
};

const PreferencesContext = React.createContext<(() => void) | null>(null);

export function usePreferences(): () => void {
  const open = React.useContext(PreferencesContext);
  if (!open) {
    throw new Error("usePreferences must be used within <PreferencesProvider>");
  }
  return open;
}

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  // SKIP while closed: this provider is mounted ABOVE the router (so the menu
  // closing can't unmount the dialog), which means it also renders on the
  // signed-out screen. getMe calls requireUserId and would throw without an
  // identity — so only subscribe when the dialog is actually open (authenticated
  // by then; Convex dedupes with the chrome's existing getMe subscription).
  const me = useQuery(api.me.getMe, open ? {} : "skip");
  const ui = me?.ui as UiState | undefined;
  const setPref = useMutation(api.me.setUiPref);

  return (
    <PreferencesContext.Provider value={() => setOpen(true)}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Préférences d'interface</DialogTitle>
            <DialogDescription>
              Affichez ou masquez les éléments de l'interface. Certaines options
              dépendent d'une fonctionnalité système non encore activée.
            </DialogDescription>
          </DialogHeader>

          {ui ? (
            <div className="oc-prefs">
              {Object.keys(ui.effective).map((key) => {
                const meta = PREF_LABELS[key];
                if (!meta) return null; // server key with no display metadata
                const locked = ui.locked[key];
                const checked = ui.effective[key];
                const overridden = ui.userOverrides[key] !== undefined;
                return (
                  <div
                    key={key}
                    className={`oc-prefs__row${locked ? " is-locked" : ""}`}
                  >
                    <div className="oc-prefs__info">
                      <span className="oc-prefs__label">
                        {meta.label}
                        {locked ? (
                          <span className="oc-prefs__lock">Non activé</span>
                        ) : !overridden ? (
                          <span className="oc-prefs__def">défaut</span>
                        ) : null}
                      </span>
                      {meta.help ? (
                        <span className="oc-prefs__help">{meta.help}</span>
                      ) : null}
                    </div>
                    <div className="oc-prefs__ctl">
                      {!locked && overridden ? (
                        <button
                          type="button"
                          className="oc-prefs__reset"
                          onClick={() => void setPref({ key, value: null })}
                        >
                          Réinitialiser
                        </button>
                      ) : null}
                      <Checkbox
                        checked={checked}
                        disabled={locked}
                        onCheckedChange={(v) =>
                          void setPref({ key, value: v === true })
                        }
                        aria-label={meta.label}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="oc-prefs__empty">Chargement…</div>
          )}
        </DialogContent>
      </Dialog>
    </PreferencesContext.Provider>
  );
}
