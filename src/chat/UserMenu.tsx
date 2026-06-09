import { useMutation } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  ChevronDown,
  Languages,
  LogOut,
  Monitor,
  Moon,
  Sun,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { m } from "@/paraglide/messages.js";
import { type Locale } from "@/paraglide/runtime.js";
import { api } from "./convexApi";
import { usePreferences } from "./PreferencesDialog";
import type { ThemeMode } from "@/lib/useTheme";

// Single top-right menu: identity header + theme mode (radio) + language (radio)
// + sign out. `mode` is the user's OWN theme preference (null = following the
// admin default). Writing it is an optimistic Convex mutation; Convex is the
// source of truth, the reactive getMe then re-applies the theme everywhere.
//
// Language preference is written to Convex (the cross-device source of truth);
// getMe.resolvedLocale then drives `useApplyLocale`, which applies it through
// Paraglide (writing localStorage + reloading once on a real change). The radio
// mirrors the theme one: its value is the user's OWN pref (`localePref`, null =
// "default" -> follow the admin `defaultLocale`), NOT the applied locale -- so an
// "app default" choice exists to RE-INHERIT after a personal pick (Codex P2).
export function UserMenu({
  label,
  mode,
  localePref,
  minimal = false,
}: {
  label: string;
  mode: ThemeMode | null;
  // The user's OWN language preference (null = following the admin default).
  localePref: Locale | null;
  // Minimal surface for an UNAPPROVED (pending) account: ONLY sign out — no
  // theme controls, no UI preferences. A pending user has zero app permissions,
  // so it must not see any app config either.
  minimal?: boolean;
}) {
  const { signOut } = useAuthActions();
  const setThemeMode = useMutation(api.me.setThemeMode);
  const setLocalePref = useMutation(api.me.setLocale);
  const openPreferences = usePreferences();
  // Radio value: a concrete mode/locale, or "default" when the user follows the
  // admin default (so there's always a path back to inheriting it).
  const value = mode ?? "default";
  const localeValue = localePref ?? "default";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          {label}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {minimal ? (
          <DropdownMenuItem onClick={() => void signOut()}>
            <LogOut /> {m.usermenu_sign_out()}
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuLabel>{m.usermenu_preferences()}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={value}
              onValueChange={(v) =>
                void setThemeMode({
                  mode: v === "default" ? null : (v as ThemeMode),
                })
              }
            >
              <DropdownMenuRadioItem value="light">
                <Sun /> {m.usermenu_theme_light()}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon /> {m.usermenu_theme_dark()}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor /> {m.usermenu_theme_system()}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="default">
                {m.usermenu_theme_default()}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <Languages className="opacity-60" /> {m.usermenu_language()}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={localeValue}
              onValueChange={(v) =>
                void setLocalePref({
                  locale: v === "default" ? null : (v as Locale),
                })
              }
            >
              <DropdownMenuRadioItem value="fr">
                {m.language_fr()}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="en">
                {m.language_en()}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="default">
                {m.usermenu_theme_default()}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            {/* Detailed UI preferences (source/report/copy/delete/tools/voice…).
                The dialog is mounted app-level (PreferencesProvider), so the menu
                closing here does not unmount it. */}
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                openPreferences();
              }}
            >
              <SlidersHorizontal /> {m.usermenu_preferences_open()}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void signOut()}>
              <LogOut /> {m.usermenu_sign_out()}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
