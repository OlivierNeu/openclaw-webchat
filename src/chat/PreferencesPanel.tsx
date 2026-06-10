import { useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "./convexApi";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { m } from "@/paraglide/messages.js";
import { PREF_META, groupAndFilterPrefs } from "./prefsMeta";

// User UI-preferences form (the interface-config toggles). Extracted from the
// former PreferencesDialog so it can live inside the Settings > Preferences tab
// (the modal was removed when these prefs moved out of the account menu).
//
// Renders the toggles the SERVER returns (getMe.ui.effective keys), grouped by
// category with an accent-insensitive filter (prefsMeta.groupAndFilterPrefs); a
// key with no display metadata still appears (in the "other" group). The server
// is the real gate (setUiPref rejects a locked feature); here locked rows are
// greyed with a "locked" note.

type UiState = {
  effective: Record<string, boolean>;
  locked: Record<string, boolean>;
  userOverrides: Record<string, boolean | undefined>;
};

export function PreferencesPanel() {
  const [query, setQuery] = useState("");
  const me = useQuery(api.me.getMe, {});
  const ui = me?.ui as UiState | undefined;
  const setPref = useMutation(api.me.setUiPref);

  const groups = useMemo(
    () => (ui ? groupAndFilterPrefs(Object.keys(ui.effective), query) : []),
    [ui, query],
  );

  if (!ui) {
    return <div className="oc-prefs__empty">{m.common_loading()}</div>;
  }

  return (
    <>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={m.prefs_filter_placeholder()}
        aria-label={m.prefs_filter_placeholder()}
        className="mb-2"
      />
      {groups.length === 0 ? (
        <div className="oc-prefs__empty">{m.prefs_no_match()}</div>
      ) : (
        <div className="oc-prefs">
          {groups.map((group) => (
            <div key={group.id} className="oc-prefs__group">
              <h4 className="oc-prefs__cat">{group.label}</h4>
              {group.keys.map((key) => {
                const meta = PREF_META[key];
                const label = meta ? meta.label() : key;
                const help = meta?.help?.();
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
                        {label}
                        {locked ? (
                          <span className="oc-prefs__lock">
                            {m.prefs_badge_locked()}
                          </span>
                        ) : !overridden ? (
                          <span className="oc-prefs__def">
                            {m.prefs_badge_default()}
                          </span>
                        ) : null}
                      </span>
                      {help ? (
                        <span className="oc-prefs__help">{help}</span>
                      ) : null}
                    </div>
                    <div className="oc-prefs__ctl">
                      {!locked && overridden ? (
                        <button
                          type="button"
                          className="oc-prefs__reset"
                          onClick={() => void setPref({ key, value: null })}
                        >
                          {m.prefs_reset()}
                        </button>
                      ) : null}
                      <Checkbox
                        checked={checked}
                        disabled={locked}
                        onCheckedChange={(v) =>
                          void setPref({ key, value: v === true })
                        }
                        aria-label={label}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
