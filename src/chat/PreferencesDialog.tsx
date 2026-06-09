import * as React from "react";
import { useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { m } from "@/paraglide/messages.js";
import { PREF_META, groupAndFilterPrefs } from "./prefsMeta";

// User UI-preferences panel (the interface-config module). Mounted ONCE at app
// root via <PreferencesProvider> — NOT inside the UserMenu dropdown, so the menu
// closing on "Préférences…" cannot unmount the dialog (the FeedbackDialog lesson).
//
// Renders the toggles the SERVER returns (getMe.ui.effective keys), grouped by
// category with an accent-insensitive filter (prefsMeta.groupAndFilterPrefs); a
// key with no display metadata still appears (in the "other" group). The server
// is the real gate (setUiPref rejects a locked feature); here locked rows are
// greyed with a "Non activé" note.

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
  const [query, setQuery] = useState("");
  // SKIP while closed: this provider is mounted ABOVE the router (so the menu
  // closing can't unmount the dialog), which means it also renders on the
  // signed-out screen. getMe calls requireUserId and would throw without an
  // identity — so only subscribe when the dialog is actually open (authenticated
  // by then; Convex dedupes with the chrome's existing getMe subscription).
  const me = useQuery(api.me.getMe, open ? {} : "skip");
  const ui = me?.ui as UiState | undefined;
  const setPref = useMutation(api.me.setUiPref);

  const groups = useMemo(
    () => (ui ? groupAndFilterPrefs(Object.keys(ui.effective), query) : []),
    [ui, query],
  );

  return (
    <PreferencesContext.Provider value={() => setOpen(true)}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{m.prefs_dialog_title()}</DialogTitle>
            <DialogDescription>{m.prefs_dialog_desc()}</DialogDescription>
          </DialogHeader>

          {ui ? (
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
                                  onClick={() =>
                                    void setPref({ key, value: null })
                                  }
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
          ) : (
            <div className="oc-prefs__empty">{m.common_loading()}</div>
          )}
        </DialogContent>
      </Dialog>
    </PreferencesContext.Provider>
  );
}
