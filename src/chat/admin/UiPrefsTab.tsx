import { useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convexApi";
import { PREF_META, groupAndFilterPrefs } from "../prefsMeta";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/paraglide/messages.js";

// Admin side of the UI-preferences module (Settings › Préférences UI):
//   - System feature enablement: until a gated feature is enabled here, users
//     cannot turn it on (it stays greyed in their Préférences panel + the server
//     rejects it).
//   - Default values: the value a user inherits when they have no override.
//     "Hérité" = fall back to the built-in code default. Grouped by category with
//     a filter (the filter is scoped to THIS section only — the gates above are a
//     short fixed list).
//
// Reads the current state from getMe.ui (defaults + featuresEnabled are global,
// resolved server-side); the effective keys drive the rendered list (no drift).

// System-gated features (the registry lives server-side in UI_PREF_SYSTEM_GATE).
// The label REUSES the pref's i18n key (no duplicate); only the gate-specific help
// differs from the per-user help.
const GATED_FEATURES: { key: string; label: () => string; help: () => string }[] =
  [
    {
      key: "voiceInput",
      label: () => m.pref_voiceInput_label(),
      help: () => m.uiprefs_gate_voiceInput_help(),
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
  const [query, setQuery] = useState("");

  const groups = useMemo(
    () => (ui ? groupAndFilterPrefs(Object.keys(ui.effective), query) : []),
    [ui, query],
  );

  if (!ui) return <p className="oc-admin__hint">{m.common_loading()}</p>;

  return (
    <>
      <p className="oc-admin__hint">{m.uiprefs_intro()}</p>

      <section className="oc-uipa__section">
        <h3 className="oc-uipa__h">{m.uiprefs_gates_title()}</h3>
        <p className="oc-uipa__note">{m.uiprefs_gates_note()}</p>
        {GATED_FEATURES.map((f) => {
          const label = f.label();
          return (
            <div key={f.key} className="oc-prefs__row">
              <div className="oc-prefs__info">
                <span className="oc-prefs__label">{label}</span>
                <span className="oc-prefs__help">{f.help()}</span>
              </div>
              <div className="oc-prefs__ctl">
                <Checkbox
                  checked={ui.featuresEnabled[f.key] === true}
                  onCheckedChange={(v) =>
                    void setFeature({ key: f.key, enabled: v === true })
                  }
                  aria-label={label}
                />
              </div>
            </div>
          );
        })}
      </section>

      <section className="oc-uipa__section">
        <h3 className="oc-uipa__h">{m.uiprefs_defaults_title()}</h3>
        <p className="oc-uipa__note">{m.uiprefs_defaults_note()}</p>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={m.prefs_filter_placeholder()}
          aria-label={m.prefs_filter_placeholder()}
          className="mb-2 max-w-sm"
        />
        {groups.length === 0 ? (
          <p className="oc-admin__hint">{m.prefs_no_match()}</p>
        ) : (
          groups.map((group) => (
            <div key={group.id} className="oc-prefs__group">
              <h4 className="oc-prefs__cat">{group.label}</h4>
              {group.keys.map((key) => {
                const meta = PREF_META[key];
                const label = meta ? meta.label() : key;
                const help = meta?.help?.();
                const def = ui.defaults[key];
                const value =
                  def === true ? "on" : def === false ? "off" : "inherit";
                return (
                  <div key={key} className="oc-prefs__row">
                    <div className="oc-prefs__info">
                      <span className="oc-prefs__label">{label}</span>
                      {help ? (
                        <span className="oc-prefs__help">{help}</span>
                      ) : null}
                    </div>
                    <div className="oc-prefs__ctl">
                      <Select
                        value={value}
                        onValueChange={(v) =>
                          void setDefault({
                            key,
                            value:
                              v === "on" ? true : v === "off" ? false : null,
                          })
                        }
                      >
                        <SelectTrigger size="sm" className="w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="on">
                            {m.uiprefs_value_on()}
                          </SelectItem>
                          <SelectItem value="off">
                            {m.uiprefs_value_off()}
                          </SelectItem>
                          <SelectItem value="inherit">
                            {m.uiprefs_value_inherit()}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </section>
    </>
  );
}
