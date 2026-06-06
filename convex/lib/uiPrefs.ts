// UI preferences — the single source of truth for which interface toggles exist,
// their code defaults, and which are gated behind a system-level feature flag.
//
// Resolution model (mirrors the theme system: user override -> admin default ->
// code default), PLUS a system gate: a feature whose underlying system is not yet
// enabled by an admin resolves to `false` AND is `locked` (the user cannot turn
// it on — the server rejects it; the UI greys it). CRITICAL: the gate is applied
// at READ time, so disabling a feature hides it WITHOUT deleting the user's stored
// override — re-enabling restores the user's choice.

export const UI_PREF_KEYS = [
  "showSource",
  "showReport",
  "copyAssistant",
  "copyUser",
  "showDelete",
  "showTools",
  "voiceInput",
] as const;

export type UiPrefKey = (typeof UI_PREF_KEYS)[number];
export type UiPrefsObject = Partial<Record<UiPrefKey, boolean>>;
export type FeaturesEnabled = Partial<Record<string, boolean>>;

// Default when neither the user nor the admin has set a value.
export const UI_PREF_CODE_DEFAULTS: Record<UiPrefKey, boolean> = {
  showSource: true,
  showReport: true,
  copyAssistant: true,
  copyUser: true,
  showDelete: true,
  showTools: true,
  voiceInput: false, // the voice pipeline is not wired yet
};

// Pref key -> the `featuresEnabled` key that must be true before a user may turn
// it on. Absent => always available.
export const UI_PREF_SYSTEM_GATE: Partial<Record<UiPrefKey, string>> = {
  voiceInput: "voiceInput",
};

export function isUiPrefKey(s: string): s is UiPrefKey {
  return (UI_PREF_KEYS as readonly string[]).includes(s);
}

export function prefGateKey(key: UiPrefKey): string | undefined {
  return UI_PREF_SYSTEM_GATE[key];
}

export type ResolvedUiPrefs = {
  effective: Record<UiPrefKey, boolean>;
  locked: Record<UiPrefKey, boolean>;
  userOverrides: UiPrefsObject;
  defaults: UiPrefsObject;
  featuresEnabled: FeaturesEnabled;
};

/**
 * Resolve the effective UI prefs for a user. `legacy` carries the pre-module
 * top-level profile fields (showTools/voiceInput) so existing users keep their
 * choice during the transition (read fallback; never written anymore).
 */
export function resolveUiPrefs(
  userOverrides: UiPrefsObject | undefined,
  adminDefaults: UiPrefsObject | undefined,
  featuresEnabled: FeaturesEnabled | undefined,
  legacy?: { showTools?: boolean; voiceInput?: boolean },
): ResolvedUiPrefs {
  const effective = {} as Record<UiPrefKey, boolean>;
  const locked = {} as Record<UiPrefKey, boolean>;
  for (const key of UI_PREF_KEYS) {
    const gate = UI_PREF_SYSTEM_GATE[key];
    const enabled = gate ? featuresEnabled?.[gate] === true : true;
    locked[key] = !enabled;
    if (!enabled) {
      effective[key] = false; // gated off — but the override below is NOT deleted
      continue;
    }
    const legacyVal =
      key === "showTools"
        ? legacy?.showTools
        : key === "voiceInput"
          ? legacy?.voiceInput
          : undefined;
    effective[key] =
      userOverrides?.[key] ??
      legacyVal ??
      adminDefaults?.[key] ??
      UI_PREF_CODE_DEFAULTS[key];
  }
  return {
    effective,
    locked,
    userOverrides: userOverrides ?? {},
    defaults: adminDefaults ?? {},
    featuresEnabled: featuresEnabled ?? {},
  };
}
