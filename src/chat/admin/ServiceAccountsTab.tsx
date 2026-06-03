import { useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { DataTableShell } from "./DataTableShell";
import { EntitySheet } from "./EntitySheet";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// "Comptes de service" tab — service accounts + their API keys.
//
// D3/D4 reminders this UI honors:
//  - Mint is an ACTION (api.apiKeys.mintApiKey). It returns the plaintext exactly
//    ONCE; we stash it in local state to feed a centered Dialog with a copy
//    button and a "you won't see this again" warning. The reactive listKeys query
//    never carries the plaintext (only prefix/lastFour).
//  - There is no enable/disable mutation for service accounts (only mint/revoke
//    keys), so `disabled` is rendered as a status badge — no toggle action.

type ServiceAccountRow = {
  _id: Id<"serviceAccounts">;
  name: string;
  roleKey: string;
  disabled: boolean;
  description: string | null;
  createdByUserId: Id<"users">;
  createdAt: number;
};

type ApiKeyRow = {
  _id: Id<"apiKeys">;
  serviceAccountId: Id<"serviceAccounts">;
  prefix: string;
  lastFour: string;
  disabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
};

type MintedKey = {
  accountName: string;
  plaintext: string;
  prefix: string;
  lastFour: string;
};

// Expiry presets for the mint trigger. mintApiKey only accepts an optional
// `expiresAt` (no key name field exists on the apiKeys doc), so the pre-mint
// affordance is expiry-only.
const EXPIRY_OPTIONS = [
  { value: "never", label: "Jamais", days: null },
  { value: "30", label: "30 jours", days: 30 },
  { value: "90", label: "90 jours", days: 90 },
] as const;
type ExpiryValue = (typeof EXPIRY_OPTIONS)[number]["value"];

const STALE_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days

type AccountForm = { name: string; roleKey: string; description: string };
const EMPTY_ACCOUNT: AccountForm = { name: "", roleKey: "", description: "" };

export function ServiceAccountsTab() {
  const accounts = useQuery(api.apiKeys.listServiceAccounts, {}) as
    | ServiceAccountRow[]
    | undefined;
  const allKeys = useQuery(api.apiKeys.listKeys, {}) as
    | ApiKeyRow[]
    | undefined;
  const roles = useQuery(api.apiKeys.listRoles, {});

  const createServiceAccount = useMutation(api.apiKeys.createServiceAccount);
  const mintApiKey = useAction(api.apiKeys.mintApiKey);
  const revokeApiKey = useMutation(api.apiKeys.revokeApiKey);
  const confirm = useConfirm();
  const toast = useToast();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<AccountForm>(EMPTY_ACCOUNT);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [minting, setMinting] = useState<Id<"serviceAccounts"> | null>(null);
  // L5: synchronous guard against a double-click minting two keys. React state
  // (`minting`) only updates on the next render, so two near-simultaneous clicks
  // can both pass a state check; a ref flips synchronously before the await.
  const mintingRef = useRef(false);
  // L7: keyIds with an in-flight revoke — the per-key "Révoquer" button is
  // disabled while its mutation runs (mirrors the mint guard).
  const [revoking, setRevoking] = useState<Set<string>>(new Set());
  const [expiryByAccount, setExpiryByAccount] = useState<
    Record<string, ExpiryValue>
  >({});
  const [minted, setMinted] = useState<MintedKey | null>(null);

  // Group keys under their owning account once (no per-row useQuery — that would
  // be a conditional/looped hook).
  const keysByAccount = useMemo(() => {
    const map = new Map<string, ApiKeyRow[]>();
    for (const k of allKeys ?? []) {
      const list = map.get(k.serviceAccountId) ?? [];
      list.push(k);
      map.set(k.serviceAccountId, list);
    }
    return map;
  }, [allKeys]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function submitAccount() {
    try {
      await createServiceAccount({
        name: form.name,
        roleKey: form.roleKey,
        description: form.description || undefined,
      });
      setForm(EMPTY_ACCOUNT);
      setSheetOpen(false);
    } catch (err) {
      // M5: surface duplicate-key / validation rejection instead of swallowing.
      toast.error("Échec de la création du compte", err);
    }
  }

  async function mint(account: ServiceAccountRow) {
    // L5: synchronous double-click guard. The ref flips BEFORE the await, so a
    // second click during the in-flight mint is rejected immediately — it can
    // never mint an orphan key whose plaintext is discarded.
    if (mintingRef.current) return;
    mintingRef.current = true;
    const choice = expiryByAccount[account._id] ?? "never";
    const days = EXPIRY_OPTIONS.find((o) => o.value === choice)?.days ?? null;
    const expiresAt = days ? Date.now() + days * 24 * 60 * 60 * 1000 : undefined;
    setMinting(account._id);
    try {
      const res = await mintApiKey({
        serviceAccountId: account._id,
        expiresAt,
      });
      // The ONLY moment the plaintext exists client-side. Stash it in local
      // state (NOT the query) so the show-once Dialog can surface it.
      setMinted({
        accountName: account.name,
        plaintext: res.plaintext,
        prefix: res.prefix,
        lastFour: res.lastFour,
      });
    } catch (err) {
      // M5: surface mint failures (the plaintext is lost on error anyway).
      toast.error("Échec de la génération de la clé", err);
    } finally {
      mintingRef.current = false;
      setMinting(null);
    }
  }

  async function revoke(key: ApiKeyRow) {
    const ok = await confirm({
      title: "Révoquer cette clé API ?",
      description: (
        <>
          La clé{" "}
          <span className="font-mono">
            {key.prefix}…{key.lastFour}
          </span>{" "}
          sera désactivée immédiatement et ne pourra plus authentifier de
          requêtes. Cette action est irréversible.
        </>
      ),
      confirmLabel: "Révoquer",
      destructive: true,
    });
    if (!ok) return;
    // L7: track in-flight revoke so the button is disabled while it runs.
    if (revoking.has(key._id)) return;
    setRevoking((prev) => new Set(prev).add(key._id));
    try {
      await revokeApiKey({ keyId: key._id });
    } catch (err) {
      // M5: surface revoke failures.
      toast.error("Échec de la révocation", err);
    } finally {
      setRevoking((prev) => {
        const next = new Set(prev);
        next.delete(key._id);
        return next;
      });
    }
  }

  return (
    <>
      <p className="oc-admin__hint">
        Comptes de service pour les agents OpenClaw (auth par clé API). Le texte
        en clair d’une clé n’est affiché qu’une seule fois à sa création — il
        n’est jamais stocké ni récupérable ensuite.
      </p>

      <DataTableShell
        title="Comptes de service"
        rows={accounts}
        addLabel="Ajouter un compte"
        onAdd={() => {
          setForm(EMPTY_ACCOUNT);
          setSheetOpen(true);
        }}
        emptyHint="Aucun compte de service."
        rowActions={(a) => [
          {
            label: "Générer une clé API",
            onSelect: () => void mint(a),
          },
          {
            label: expanded.has(a._id)
              ? "Masquer les clés"
              : "Afficher les clés",
            onSelect: () => toggleExpanded(a._id),
          },
        ]}
        columns={[
          {
            header: "",
            className: "w-8",
            cell: (a) => (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={expanded.has(a._id) ? "Replier" : "Déplier"}
                onClick={() => toggleExpanded(a._id)}
              >
                {expanded.has(a._id) ? <ChevronDown /> : <ChevronRight />}
              </Button>
            ),
          },
          { header: "Nom", cell: (a) => a.name },
          {
            header: "Rôle",
            cell: (a) => <Badge variant="secondary">{a.roleKey}</Badge>,
          },
          {
            header: "Statut",
            cell: (a) =>
              a.disabled ? (
                <Badge variant="destructive">désactivé</Badge>
              ) : (
                <Badge variant="outline">actif</Badge>
              ),
          },
          {
            header: "Expiration de la prochaine clé",
            cell: (a) => (
              <Select
                value={expiryByAccount[a._id] ?? "never"}
                onValueChange={(v) =>
                  setExpiryByAccount((prev) => ({
                    ...prev,
                    [a._id]: v as ExpiryValue,
                  }))
                }
              >
                <SelectTrigger size="sm" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ),
          },
          {
            header: "Clés",
            cell: (a) => {
              const keys = keysByAccount.get(a._id) ?? [];
              const active = keys.filter((k) => !k.disabled).length;
              return (
                <span className="oc-sa__keycount">
                  {minting === a._id ? "génération…" : `${active} active(s)`}
                </span>
              );
            },
          },
        ]}
      />

      {/* Expanded per-account key lists. Rendered below the table so each picks
          up the same grouped keysByAccount data without nested hooks. */}
      {(accounts ?? [])
        .filter((a) => expanded.has(a._id))
        .map((a) => (
          <AccountKeys
            key={a._id}
            account={a}
            keys={keysByAccount.get(a._id) ?? []}
            onRevoke={revoke}
            revoking={revoking}
          />
        ))}

      <EntitySheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title="Nouveau compte de service"
        description="Principal authentifié par clé API (jamais un humain)."
        canSubmit={Boolean(form.name && form.roleKey)}
        onSubmit={submitAccount}
        submitLabel="Ajouter"
      >
        <div className="oc-form">
          <label className="oc-field">
            <span className="oc-field__label">Nom</span>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="oc-field">
            <span className="oc-field__label">Rôle</span>
            <Select
              value={form.roleKey || undefined}
              onValueChange={(v) => setForm({ ...form, roleKey: v })}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choisir un rôle" />
              </SelectTrigger>
              <SelectContent>
                {(roles ?? []).map((r) => (
                  <SelectItem key={r._id} value={r.key}>
                    {r.name} ({r.key})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="oc-field">
            <span className="oc-field__label">Description (optionnel)</span>
            <Input
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </label>
        </div>
      </EntitySheet>

      <MintedKeyDialog minted={minted} onClose={() => setMinted(null)} />
    </>
  );
}

// Per-account expanded key list. Plain table (not DataTableShell — no bulk
// select needed here, and we want it visually nested under the account).
function AccountKeys({
  account,
  keys,
  onRevoke,
  revoking,
}: {
  account: ServiceAccountRow;
  keys: ApiKeyRow[];
  onRevoke: (key: ApiKeyRow) => void;
  revoking: Set<string>;
}) {
  return (
    <div className="oc-sa__keys">
      <div className="oc-sa__keys-head">
        Clés de <span className="font-medium">{account.name}</span>
      </div>
      {keys.length === 0 ? (
        <p className="oc-admin__hint">Aucune clé pour ce compte.</p>
      ) : (
        <table className="oc-sa__keytable">
          <thead>
            <tr>
              <th>Clé</th>
              <th>Rôle</th>
              <th>Créée</th>
              <th>Dernier usage</th>
              <th>Expiration</th>
              <th>Statut</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k._id}>
                <td>
                  <code className="oc-sa__keyid">
                    {k.prefix}…{k.lastFour}
                  </code>
                </td>
                <td>
                  <Badge variant="secondary">{account.roleKey}</Badge>
                </td>
                <td>{formatDate(k.createdAt)}</td>
                <td className={isStale(k.lastUsedAt) ? "oc-sa__stale" : ""}>
                  {formatLastUsed(k.lastUsedAt)}
                </td>
                <td>{formatExpiry(k.expiresAt)}</td>
                <td>{statusBadge(k)}</td>
                <td className="text-right">
                  {!k.disabled ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={revoking.has(k._id)}
                      onClick={() => onRevoke(k)}
                    >
                      {revoking.has(k._id) ? "Révocation…" : "Révoquer"}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Centered show-once Dialog (D3): plaintext appears here exactly once with a
// copy button + an unmistakable warning. On close, only prefix/lastFour remain
// (in the reactive listKeys query); the plaintext local state is cleared.
function MintedKeyDialog({
  minted,
  onClose,
}: {
  minted: MintedKey | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.plaintext);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context); the read-only box still
      // lets the admin select + copy manually.
    }
  }

  return (
    <Dialog
      open={minted !== null}
      onOpenChange={(o) => {
        if (!o) {
          setCopied(false);
          onClose();
        }
      }}
    >
      {minted ? (
        <DialogContent
          className="max-w-lg"
          // Irreversible secret shown exactly once: block accidental dismissal
          // (overlay click / Escape / X). The ONLY close path is the explicit
          // "J'ai copié la clé" button — research §"Mint modal" item 5.
          showCloseButton={false}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Clé API créée</DialogTitle>
            <DialogDescription>
              Pour le compte « {minted.accountName} ». Copiez-la maintenant.
            </DialogDescription>
          </DialogHeader>

          <div className="oc-sa__minted-warning">
            Stockez cette clé en lieu sûr. Vous ne la reverrez plus jamais. Pour
            la remplacer, il faudra la révoquer et en générer une nouvelle.
          </div>

          <div className="oc-sa__minted-box">
            <code className="oc-sa__minted-plain">{minted.plaintext}</code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copy()}
              aria-label="Copier la clé"
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copié" : "Copier"}
            </Button>
          </div>

          <DialogFooter>
            <Button
              onClick={() => {
                setCopied(false);
                onClose();
              }}
            >
              J’ai copié la clé
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("fr-FR");
}

function isStale(lastUsedAt: number | null): boolean {
  if (lastUsedAt === null) return false;
  return Date.now() - lastUsedAt > STALE_MS;
}

function formatLastUsed(lastUsedAt: number | null): string {
  if (lastUsedAt === null) return "Jamais";
  return new Date(lastUsedAt).toLocaleString("fr-FR");
}

function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return "—";
  return new Date(expiresAt).toLocaleDateString("fr-FR");
}

function statusBadge(k: ApiKeyRow) {
  if (k.disabled) return <Badge variant="destructive">révoquée</Badge>;
  if (k.expiresAt !== null && k.expiresAt < Date.now())
    return <Badge variant="outline">expirée</Badge>;
  return <Badge variant="outline">active</Badge>;
}
