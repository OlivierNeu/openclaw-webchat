// Bridge version/compat helpers (pure, ctx-free).
//
// The bridge's unauthenticated GET /capabilities gained ADDITIVE fields
// (protocolVersion 2): `bridgeVersion`, `protocolVersion`, a CompatManifest
// (per-provider supportedRange / validatedVersions / capability->minVersion)
// and per-live-session capability `targets`. These helpers defensively
// normalize that NETWORK body (every field validated; an OLD bridge without
// the new fields normalizes to compat:null — the frontend has a legacy policy
// for that) and derive the /api/v1/compat summary. Pure + ctx-free so the
// poller, the queries, the HTTP route and the unit tests share one
// implementation (same idiom as bridgeHealth.normalizeTarget).

/** One stored capability target (per instance, deduped from the bridge's
 *  per-session entries). Non-secret: names, versions, capability booleans. */
export type CompatTarget = {
  instanceName: string;
  provider: string; // "openclaw" | "hermes" | future — free string (fwd-compat)
  gatewayVersion: string | null;
  capabilities: Record<string, boolean>;
  versionBeyondValidated: boolean;
};

/** The normalized, storable projection of a /capabilities response body. */
export type NormalizedCapabilities = {
  bridgeVersion: string | null;
  protocolVersion: number | null;
  /** CompatManifest verbatim (bounded), or null = legacy bridge / bad shape. */
  compat: unknown;
  targets: CompatTarget[];
};

/** A provider's support window as read from the CompatManifest. */
export type ProviderSupport = {
  range: { min: string; maxValidated: string } | null;
  validatedVersions: string[];
};

/** The /api/v1/compat response payload (minus the `ok` envelope). */
export type CompatSummary = {
  bridge: {
    version: string | null;
    protocolVersion: number | null;
    supported: { openclaw: ProviderSupport };
  };
  // Snapshot freshness/health — so a key-authed reader (the observer API) can
  // tell a FRESH poll from a stale last-good one, and a successful poll from a
  // preserved-on-failure one, WITHOUT UI access. `reachable:false` keeps the
  // last-good `instances`; `fetchedAt` is the timestamp of the LAST poll attempt
  // (success or failure). Null only when no poll has ever run.
  reachable: boolean | null;
  lastError: string | null;
  fetchedAt: number | null;
  instances: Array<{
    instanceName: string;
    provider: string;
    gatewayVersion: string | null;
    withinSupport: boolean;
    versionBeyondValidated: boolean;
  }>;
};

const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

// The manifest is stored verbatim under v.any(); bound it so a drifted/bloated
// bridge response can never balloon the singleton doc toward the 1MB doc limit.
const COMPAT_MANIFEST_MAX_CHARS = 64 * 1024;

/** STRICT parse of a gateway version ("2026.6.5"): EXACTLY three dot-separated
 *  non-negative integers, no surrounding whitespace; null otherwise. Mirrors
 *  the bridge's parseVersion (src/compat.ts) so the BridgeTab support badge can
 *  never contradict the capabilities the bridge actually resolved — both sides
 *  fail CLOSED on the same inputs. */
export function parseVersion(version: string): number[] | null {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  return version.split(".").map((p) => Number.parseInt(p, 10));
}

/** Numeric three-part comparison. Returns a negative/zero/positive number, or
 *  null when either side is unparseable (fail closed). */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/** Is `gatewayVersion` within the provider's support window? Fail CLOSED: an
 *  unknown version, an unparseable version, or a provider with no published
 *  range (e.g. hermes today) is NOT "within support". Versions ABOVE
 *  maxValidated are still within support (supported-but-unvalidated — that
 *  nuance rides on the separate `versionBeyondValidated` flag). */
export function withinSupport(
  range: { min: string; maxValidated: string } | null,
  gatewayVersion: string | null,
): boolean {
  if (range === null || gatewayVersion === null) return false;
  const cmp = compareVersions(gatewayVersion, range.min);
  return cmp !== null && cmp >= 0;
}

/** A storable capability-record key (Convex record keys must be non-empty
 *  ASCII not starting with "$" or "_"). */
function storableKey(key: string): boolean {
  if (key.length === 0) return false;
  if (key.startsWith("$") || key.startsWith("_")) return false;
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]+$/.test(key);
}

/** Flatten ONE target from the bridge /capabilities JSON. Defensive: the body
 *  came over the network, so validate every field; null on a bad shape. Drops
 *  the per-session fields (key/agentId) we do not store. */
export function normalizeCompatTarget(raw: unknown): CompatTarget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const instanceName = str(o.instanceName);
  const provider = str(o.provider);
  if (instanceName === null || provider === null) return null;
  const capabilities: Record<string, boolean> = {};
  if (typeof o.capabilities === "object" && o.capabilities !== null) {
    for (const [k, val] of Object.entries(
      o.capabilities as Record<string, unknown>,
    )) {
      if (typeof val === "boolean" && storableKey(k)) capabilities[k] = val;
    }
  }
  return {
    instanceName,
    provider,
    gatewayVersion: str(o.gatewayVersion),
    capabilities,
    versionBeyondValidated: o.versionBeyondValidated === true,
  };
}

/** Dedupe per-session targets down to ONE per instance. The bridge emits one
 *  entry per live session (deduped by canonical), but gatewayVersion +
 *  capabilities are per-INSTANCE facts: keep the first entry, upgrading to a
 *  later one only when it carries a gatewayVersion the kept one lacks. */
export function dedupeTargetsByInstance(
  targets: CompatTarget[],
): CompatTarget[] {
  const byInstance = new Map<string, CompatTarget>();
  for (const t of targets) {
    const cur = byInstance.get(t.instanceName);
    if (cur === undefined || (cur.gatewayVersion === null && t.gatewayVersion !== null)) {
      byInstance.set(t.instanceName, t);
    }
  }
  return [...byInstance.values()];
}

/** Bound the CompatManifest for storage: must be a plain JSON object and small
 *  enough that the singleton doc stays far from the 1MB limit; null otherwise.
 *  The JSON round-trip also strips non-Convex values (undefined/functions). */
export function boundCompatManifest(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  try {
    const json = JSON.stringify(raw);
    if (typeof json !== "string" || json.length > COMPAT_MANIFEST_MAX_CHARS) {
      return null;
    }
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/** Normalize a whole /capabilities response body. BACKWARD SKEW: an old bridge
 *  (no bridgeVersion/protocolVersion/compat/targets) normalizes to nulls + an
 *  empty target list — the reader treats compat:null as "legacy bridge". */
export function normalizeCapabilitiesBody(raw: unknown): NormalizedCapabilities {
  const o = (
    typeof raw === "object" && raw !== null ? raw : {}
  ) as Record<string, unknown>;
  const targetsRaw = Array.isArray(o.targets) ? o.targets : [];
  const targets = dedupeTargetsByInstance(
    targetsRaw
      .map(normalizeCompatTarget)
      .filter((t): t is CompatTarget => t !== null),
  );
  return {
    bridgeVersion: str(o.bridgeVersion),
    protocolVersion:
      typeof o.protocolVersion === "number" ? o.protocolVersion : null,
    compat: boundCompatManifest(o.compat),
    targets,
  };
}

/** Read one provider's support window out of a stored CompatManifest.
 *  Defensive (the manifest is stored verbatim as v.any()): any missing/odd
 *  shape degrades to { range: null, validatedVersions: [] }. */
export function providerSupport(
  compat: unknown,
  provider: string,
): ProviderSupport {
  const none: ProviderSupport = { range: null, validatedVersions: [] };
  if (typeof compat !== "object" || compat === null) return none;
  const providers = (compat as Record<string, unknown>).providers;
  if (typeof providers !== "object" || providers === null) return none;
  const entry = (providers as Record<string, unknown>)[provider];
  if (typeof entry !== "object" || entry === null) return none;
  const e = entry as Record<string, unknown>;
  let range: ProviderSupport["range"] = null;
  if (typeof e.supportedRange === "object" && e.supportedRange !== null) {
    const r = e.supportedRange as Record<string, unknown>;
    const min = str(r.min);
    const maxValidated = str(r.maxValidated);
    if (min !== null && maxValidated !== null) range = { min, maxValidated };
  }
  const validatedVersions = Array.isArray(e.validatedVersions)
    ? e.validatedVersions.filter((x): x is string => typeof x === "string")
    : [];
  return { range, validatedVersions };
}

/** Build the /api/v1/compat summary from the stored snapshot (or null when no
 *  poll has landed yet): "what does the bridge support, what are my instances
 *  running". Pure so the answer is unit-testable without auth/HTTP. */
export function summarizeCompat(
  doc: {
    bridgeVersion: string | null;
    protocolVersion: number | null;
    compat: unknown;
    targets: CompatTarget[];
    reachable?: boolean;
    lastError?: string | null;
    fetchedAt?: number;
  } | null,
): CompatSummary {
  if (doc === null) {
    return {
      bridge: {
        version: null,
        protocolVersion: null,
        supported: { openclaw: { range: null, validatedVersions: [] } },
      },
      reachable: null,
      lastError: null,
      fetchedAt: null,
      instances: [],
    };
  }
  return {
    bridge: {
      version: doc.bridgeVersion,
      protocolVersion: doc.protocolVersion,
      supported: { openclaw: providerSupport(doc.compat, "openclaw") },
    },
    reachable: doc.reachable ?? null,
    lastError: doc.lastError ?? null,
    fetchedAt: doc.fetchedAt ?? null,
    instances: doc.targets.map((t) => ({
      instanceName: t.instanceName,
      provider: t.provider,
      gatewayVersion: t.gatewayVersion,
      withinSupport: withinSupport(
        providerSupport(doc.compat, t.provider).range,
        t.gatewayVersion,
      ),
      versionBeyondValidated: t.versionBeyondValidated,
    })),
  };
}

/** Per-instance capability projection ({ provider, gatewayVersion,
 *  capabilities }) or null when the instance is unknown to the compat snapshot
 *  (legacy bridge / never polled) — the frontend's legacy policy handles null. */
export function capabilitiesForInstance(
  targets: CompatTarget[],
  instanceName: string,
): {
  provider: string;
  gatewayVersion: string | null;
  capabilities: Record<string, boolean> | null;
  versionBeyondValidated: boolean;
} | null {
  const t = targets.find((x) => x.instanceName === instanceName);
  if (t === undefined) return null;
  return {
    provider: t.provider,
    gatewayVersion: t.gatewayVersion,
    capabilities: t.capabilities,
    versionBeyondValidated: t.versionBeyondValidated,
  };
}
