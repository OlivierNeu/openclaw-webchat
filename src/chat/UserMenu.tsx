import { useMutation } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { ChevronDown, LogOut, Monitor, Moon, Sun } from "lucide-react";
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
import { api } from "./convexApi";
import type { ThemeMode } from "@/lib/useTheme";

// Single top-right account menu: identity header + theme mode (radio) + sign out.
// Deliberately minimal — the most usual shortcuts only. Language and the detailed
// UI preferences moved to Settings → Préférences (gated on chats.read, visible to
// all). `mode` is the user's OWN theme preference (null = following the admin
// default); writing it is an optimistic Convex mutation, the reactive getMe then
// re-applies the theme everywhere.
export function UserMenu({
  label,
  mode,
  minimal = false,
}: {
  label: string;
  mode: ThemeMode | null;
  // Minimal surface for an UNAPPROVED (pending) account: ONLY sign out — no theme
  // controls. A pending user has zero app permissions, so no app config either.
  minimal?: boolean;
}) {
  const { signOut } = useAuthActions();
  const setThemeMode = useMutation(api.me.setThemeMode);
  // Radio value: a concrete mode, or "default" when the user follows the admin
  // default (so there's always a path back to inheriting it).
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
        {minimal ? (
          <DropdownMenuItem onClick={() => void signOut()}>
            <LogOut /> {m.usermenu_sign_out()}
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuLabel>{m.usermenu_theme_label()}</DropdownMenuLabel>
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
            <DropdownMenuItem onClick={() => void signOut()}>
              <LogOut /> {m.usermenu_sign_out()}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
