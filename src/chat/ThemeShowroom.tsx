import { useState } from "react";
import { MoreVertical, Check } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { api } from "./convexApi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FilterBar } from "./admin/filters/FilterBar";
import { TimeRangePicker } from "./admin/filters/TimeRangePicker";
import { AdvancedFilter, type AdvancedField } from "./admin/filters/AdvancedFilter";
import type { TimeRange } from "./admin/filters/types";
import { m } from "@/paraglide/messages.js";
import type { Locale } from "@/lib/useLocale";
import type { ThemeMode } from "@/lib/useTheme";

// Living style guide: renders every component the app uses with the active
// design tokens, the way ui.shadcn.com does. Use it to verify the chart in both
// light and dark (toggle from the top-bar theme switcher).

// "Select all" sentinel (radix has no empty value), mirrors the admin tabs.
const SHOW_ALL = "__all__";
const SHOW_RANGE: TimeRange = { kind: "relative", from: "now-24h", to: "now" };
// Demo fields for the advanced-filter builder (no backend; preview only).
const SHOW_ADV_FIELDS: AdvancedField[] = [
  { value: "status", label: "Statut" },
  { value: "latencyMs", label: "Latence (ms)" },
  { value: "route", label: "Route" },
  { value: "roleKey", label: "Rôle" },
  { value: "correlationId", label: "Corrélation" },
];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="oc-show__section">
      <div className="oc-show__heading">
        <h2 className="oc-show__title">{title}</h2>
        {description ? (
          <p className="oc-show__desc">{description}</p>
        ) : null}
      </div>
      <div className="oc-show__demo">{children}</div>
    </section>
  );
}

function themeModeLabel(mode: ThemeMode): string {
  return mode === "light"
    ? m.usermenu_theme_light()
    : mode === "dark"
      ? m.usermenu_theme_dark()
      : m.usermenu_theme_system();
}

// Admin "Apparence" panel: the app-wide DEFAULTS applied to users who have not
// set their OWN preference (the per-user theme/language live in the account menu).
//   - Default theme  -> admin.setDefaultThemeMode (a class swap, no reload).
//   - Default language -> admin.setDefaultLocale. ASYMMETRY: an admin with NO
//     personal locale who changes this inherits it → useApplyLocale RELOADS their
//     own view (Paraglide). The note warns about it (advisor).
function AppearancePanel() {
  const me = useQuery(api.me.getMe) as
    | {
        defaultThemeMode: ThemeMode | null;
        defaultLocale: Locale | null;
      }
    | undefined;
  const setDefaultTheme = useMutation(api.admin.setDefaultThemeMode);
  const setDefaultLocale = useMutation(api.admin.setDefaultLocale);
  const theme = me?.defaultThemeMode ?? "system";
  // null (no admin default) resolves to the base locale "fr" → highlight it.
  const localeDefault: Locale = me?.defaultLocale ?? "fr";

  return (
    <div className="oc-appearance">
      <section className="oc-show__section">
        <div className="oc-show__heading">
          <h2 className="oc-show__title">
            {m.appearance_default_theme_title()}
          </h2>
          <p className="oc-show__desc">{m.appearance_default_theme_desc()}</p>
        </div>
        <div className="oc-show__row">
          {(["light", "dark", "system"] as const).map((mode) => (
            <Button
              key={mode}
              variant={theme === mode ? "default" : "outline"}
              size="sm"
              onClick={() => void setDefaultTheme({ mode })}
            >
              {themeModeLabel(mode)}
            </Button>
          ))}
        </div>
      </section>

      <section className="oc-show__section">
        <div className="oc-show__heading">
          <h2 className="oc-show__title">
            {m.appearance_default_language_title()}
          </h2>
          <p className="oc-show__desc">
            {m.appearance_default_language_desc()}
          </p>
        </div>
        <div className="oc-show__row">
          {(["fr", "en"] as const).map((loc) => (
            <Button
              key={loc}
              variant={localeDefault === loc ? "default" : "outline"}
              size="sm"
              onClick={() => void setDefaultLocale({ locale: loc })}
            >
              {loc === "fr" ? m.language_fr() : m.language_en()}
            </Button>
          ))}
        </div>
        <p className="oc-show__desc">{m.appearance_default_language_note()}</p>
      </section>
    </div>
  );
}

export function ThemeShowroom() {
  const [checked, setChecked] = useState(true);
  const [sel, setSel] = useState("per-user");

  // Local state for the Filters showcase (no backend — preview of the tokens).
  const [fq, setFq] = useState("");
  const [fdir, setFdir] = useState(SHOW_ALL);
  const [fsev, setFsev] = useState(SHOW_ALL);
  const [frange, setFrange] = useState<TimeRange>(SHOW_RANGE);
  const filtersActive = fq !== "" || fdir !== SHOW_ALL || fsev !== SHOW_ALL;
  function resetShowFilters() {
    setFq("");
    setFdir(SHOW_ALL);
    setFsev(SHOW_ALL);
    setFrange(SHOW_RANGE);
  }

  return (
    <div className="oc-show">
      <AppearancePanel />
      {/* The component showroom (design reference) is collapsed below — it's dev
          tooling, intentionally NOT internationalized. #23 will relocate it to a
          /showroom route; remove this copy then. */}
      <details className="oc-show__ref">
        <summary className="oc-show__title">
          {m.appearance_design_reference()}
        </summary>
      <Section title="Buttons" description="Variants">
        <div className="oc-show__row">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
        </div>
        <div className="oc-show__row">
          <Button size="sm">Small</Button>
          <Button>Default</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" aria-label="more">
            <MoreVertical />
          </Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Badges">
        <div className="oc-show__row">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
        </div>
      </Section>

      <Section title="Inputs & selection">
        <div className="oc-show__row oc-show__row--col">
          <Input placeholder="Text input…" />
          <div className="oc-show__row">
            <Select value={sel} onValueChange={setSel}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per-user">per-user (chacun son agent)</SelectItem>
                <SelectItem value="shared">shared (agent commun)</SelectItem>
              </SelectContent>
            </Select>
            <label className="oc-show__check">
              <Checkbox
                checked={checked}
                onCheckedChange={(v) => setChecked(Boolean(v))}
              />
              Checkbox
            </label>
          </div>
        </div>
      </Section>

      <Section
        title="Filtres & plage temporelle"
        description="Barre réutilisable (recherche debouncée + selects rapides à largeur auto + plage façon Grafana) et constructeur de filtre avancé. Câblée dans Users, Groups, Comptes de service, Traces, Anomalies, Audit et KPI."
      >
        <div className="oc-show__row oc-show__row--col">
          <FilterBar
            q={fq}
            onQChange={setFq}
            searchPlaceholder="Rechercher (kind, principal, rôle, route…)"
            timeRange={frange}
            onTimeRangeChange={setFrange}
            onReset={resetShowFilters}
            canReset={filtersActive}
          >
            <Select value={fdir} onValueChange={setFdir}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SHOW_ALL}>Toutes directions</SelectItem>
                <SelectItem value="inbound">inbound</SelectItem>
                <SelectItem value="outbound">outbound</SelectItem>
                <SelectItem value="internal">internal</SelectItem>
              </SelectContent>
            </Select>
            <Select value={fsev} onValueChange={setFsev}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SHOW_ALL}>Toutes sévérités</SelectItem>
                <SelectItem value="info">info</SelectItem>
                <SelectItem value="warn">warn</SelectItem>
                <SelectItem value="critical">critical</SelectItem>
              </SelectContent>
            </Select>
          </FilterBar>

          <AdvancedFilter fields={SHOW_ADV_FIELDS} onChange={() => {}} />

          <div className="oc-show__row">
            <span className="oc-show__desc">Sélecteur de plage seul :</span>
            <TimeRangePicker value={frange} onChange={setFrange} />
          </div>
        </div>
      </Section>

      <Section title="Dropdown menu" description="Row actions / kebab">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Open menu">
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Edit</DropdownMenuItem>
            <DropdownMenuItem>Duplicate</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      <Section title="Card">
        <Card className="w-80">
          <CardHeader>
            <CardTitle>Instance</CardTitle>
            <CardDescription>Non-secret metadata only.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            ws://192.168.1.49:18789
          </CardContent>
          <CardFooter className="gap-2">
            <Button size="sm">Save</Button>
            <Button size="sm" variant="ghost">
              Cancel
            </Button>
          </CardFooter>
        </Card>
      </Section>

      <Section title="Table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox aria-label="select all" />
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead className="text-right">Status</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {[
              { n: "admins", m: "per-user", s: "active" },
              { n: "family", m: "shared", s: "active" },
            ].map((r) => (
              <TableRow key={r.n}>
                <TableCell>
                  <Checkbox aria-label={`select ${r.n}`} />
                </TableCell>
                <TableCell className="font-medium">{r.n}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{r.m}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Check className="size-3.5" /> {r.s}
                  </span>
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" aria-label="row actions">
                    <MoreVertical />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title="App fragments" description="Chat-specific components">
        <div className="oc-show__row oc-show__row--col">
          <div className="oc-msg oc-msg--assistant">
            <div className="oc-msg__body">Assistant message bubble.</div>
          </div>
          <div className="oc-tool oc-tool--completed">
            <div className="oc-tool__header">
              <span className="oc-tool__icon">✓</span>
              <span className="oc-tool__name">write-file</span>
              <span className="oc-tool__phase">completed</span>
            </div>
          </div>
          <div className="oc-run-status oc-run-status--streaming">
            <span className="oc-run-status__dot" />
            <span className="oc-run-status__label">Running</span>
          </div>
        </div>
      </Section>
      </details>
    </div>
  );
}
