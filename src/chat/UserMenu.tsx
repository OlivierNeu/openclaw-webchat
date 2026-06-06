import { useMutation } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { ChevronDown, LogOut, Monitor, Moon, Sun, SlidersHorizontal } from "lucide-react";
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
import { api } from "./convexApi";
import { usePreferences } from "./PreferencesDialog";
import type { ThemeMode } from "@/lib/useTheme";

// Single top-right menu: identity header + theme mode (radio) + sign out.
// `mode` is the user's OWN preference (null = following the admin default).
// Writing it is an optimistic Convex mutation; Convex is the source of truth,
// the reactive getMe then re-applies the theme everywhere.
export function UserMenu({
  label,
  mode,
}: {
  label: string;
  mode: ThemeMode | null;
}) {
  const { signOut } = useAuthActions();
  const setThemeMode = useMutation(api.me.setThemeMode);
  const openPreferences = usePreferences();
  // Radio value: a concrete mode, or "default" when the user follows the admin.
  const value = mode ?? "default";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          {label}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Préférences</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) =>
            void setThemeMode({ mode: v === "default" ? null : (v as ThemeMode) })
          }
        >
          <DropdownMenuRadioItem value="light">
            <Sun /> Clair
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon /> Sombre
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor /> Système
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="default">
            Défaut de l’app
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {/* Detailed UI preferences (source/report/copy/delete/tools/voice…). The
            dialog is mounted app-level (PreferencesProvider), so the menu closing
            here does not unmount it. */}
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            openPreferences();
          }}
        >
          <SlidersHorizontal /> Préférences…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
