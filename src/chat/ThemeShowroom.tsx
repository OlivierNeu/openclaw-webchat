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

// Living style guide: renders every component the app uses with the active
// design tokens, the way ui.shadcn.com does. Use it to verify the chart in both
// light and dark (toggle from the top-bar theme switcher).

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

// Admin control: the app-wide DEFAULT theme mode (applied to users who have not
// set their own preference). Backed by admin.setDefaultThemeMode -> appMeta.
function DefaultThemeControl() {
  const me = useQuery(api.me.getMe) as
    | { defaultThemeMode: "light" | "dark" | "system" | null }
    | undefined;
  const setDefault = useMutation(api.admin.setDefaultThemeMode);
  const current = me?.defaultThemeMode ?? "system";
  return (
    <section className="oc-show__section">
      <div className="oc-show__heading">
        <h2 className="oc-show__title">Default theme</h2>
        <p className="oc-show__desc">
          Appliqué aux utilisateurs sans préférence personnelle.
        </p>
      </div>
      <div className="oc-show__row">
        {(["light", "dark", "system"] as const).map((m) => (
          <Button
            key={m}
            variant={current === m ? "default" : "outline"}
            size="sm"
            onClick={() => void setDefault({ mode: m })}
          >
            {m}
          </Button>
        ))}
      </div>
    </section>
  );
}

export function ThemeShowroom() {
  const [checked, setChecked] = useState(true);
  const [sel, setSel] = useState("per-user");

  return (
    <div className="oc-show">
      <DefaultThemeControl />
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
    </div>
  );
}
