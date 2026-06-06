import { useQuery, useMutation } from "convex/react";
import { api } from "../convexApi";
import { PREF_LABELS } from "../PreferencesDialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Admin side of the UI-preferences module (Settings › Préférences UI):
//   - System feature enablement: until a gated feature is enabled here, users
//     cannot turn it on (it stays greyed in their Préférences panel + the server
//     rejects it).
//   - Default values: the value a user inherits when they have no override.
//     "Hérité" = fall back to the built-in code default.
//
// Reads the current state from getMe.ui (defaults + featuresEnabled are global,
// resolved server-side); the effective keys drive the rendered list (no drift).

// Display config for the system-gated features (the registry lives server-side
// in UI_PREF_SYSTEM_GATE; this is labels only).
const GATED_FEATURES: { key: string; label: string; help: string }[] = [
  {
    key: "voiceInput",
    label: "Saisie vocale (micro)",
    help: "Active le pipeline vocal. Tant que c'est désactivé, l'option reste grisée et non activable par les utilisateurs.",
  },
];

type UiState = {
  effective: Record<string, boolean>;
  defaults: Record<string, boolean | undefined>;
  featuresEnabled: Record<string, boolean | undefined>;
};

export function UiPrefsTab() {
  const me = useQuery(api.me.getMe);
  const ui = me?.ui as UiState | undefined;
  const setDefault = useMutation(api.admin.setUiPrefDefault);
  const setFeature = useMutation(api.admin.setFeatureEnabled);

  if (!ui) return <p className="oc-admin__hint">Chargement…</p>;

  return (
    <>
      <p className="oc-admin__hint">
        Configurez l'interface : activez les fonctionnalités système et définissez
        les valeurs par défaut héritées par les utilisateurs (chacun peut ensuite
        les redéfinir dans ses propres préférences).
      </p>

      <section className="oc-uipa__section">
        <h3 className="oc-uipa__h">Activation des fonctionnalités système</h3>
        <p className="oc-uipa__note">
          Une fonctionnalité non activée ici ne peut pas être activée par les
          utilisateurs (option grisée).
        </p>
        {GATED_FEATURES.map((f) => (
          <div key={f.key} className="oc-prefs__row">
            <div className="oc-prefs__info">
              <span className="oc-prefs__label">{f.label}</span>
              <span className="oc-prefs__help">{f.help}</span>
            </div>
            <div className="oc-prefs__ctl">
              <Checkbox
                checked={ui.featuresEnabled[f.key] === true}
                onCheckedChange={(v) =>
                  void setFeature({ key: f.key, enabled: v === true })
                }
                aria-label={`Activer ${f.label}`}
              />
            </div>
          </div>
        ))}
      </section>

      <section className="oc-uipa__section">
        <h3 className="oc-uipa__h">Valeurs par défaut des préférences</h3>
        <p className="oc-uipa__note">
          « Hérité » = la valeur intégrée par défaut de l'application.
        </p>
        {Object.keys(ui.effective).map((key) => {
          const meta = PREF_LABELS[key];
          if (!meta) return null;
          const def = ui.defaults[key];
          const value = def === true ? "on" : def === false ? "off" : "inherit";
          return (
            <div key={key} className="oc-prefs__row">
              <div className="oc-prefs__info">
                <span className="oc-prefs__label">{meta.label}</span>
                {meta.help ? (
                  <span className="oc-prefs__help">{meta.help}</span>
                ) : null}
              </div>
              <div className="oc-prefs__ctl">
                <Select
                  value={value}
                  onValueChange={(v) =>
                    void setDefault({
                      key,
                      value: v === "on" ? true : v === "off" ? false : null,
                    })
                  }
                >
                  <SelectTrigger size="sm" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="on">Activé</SelectItem>
                    <SelectItem value="off">Désactivé</SelectItem>
                    <SelectItem value="inherit">Hérité</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          );
        })}
      </section>
    </>
  );
}
