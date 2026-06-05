# Chat UX & feature design — research, decisions, plan (2026-06-05)

Goal (user): a webchat interface that is *extremely* well-built, functional and
pleasant — "a solution nobody has made but everyone would want". Expose the chat
options OpenClaw offers natively (reasoning level, model, voice, …) as
**features, not ergonomics**, designed so we never block new OpenClaw features.
Build on our existing stack (React + TanStack Router + Convex + assistant-ui +
shadcn/"radix-nova" theme + light/dark/system), don't restart it.

---

## Part 1 — Research foundation (what the eye and the mind actually do)

### 1.1 Where users look / how they scan (eye-tracking science)
- **F-pattern** (NN/g, 232 users, re-confirmed 11 yrs later, holds on mobile):
  users scan two horizontal sweeps + a left vertical sweep; they **frontload
  attention top-left** and miss unformatted middle/right content. Sources:
  [NN/g F-pattern](https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content/),
  [NN/g original](https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content-discovered/).
- **Other patterns** (NN/g): **layer-cake** (scan headings, skip body — so give
  strong heading/role hierarchy), **spotted** (hunt for numbers/links — make
  targets visually distinct), **commitment** (engaged users read all).
- **Design implications we adopt:**
  - Frontload meaning; first 2 words of any label/heading must carry the gist.
  - Left edge carries meaning; never bury critical controls in a right gutter.
  - Strong visual hierarchy (role headers, weight, spacing) → ride the layer-cake.
  - Distinct formatting for "spotted" targets: token/context meter, model name,
    timestamps, file chips.

### 1.2 Conversational design (turns, not pages)
- NN/g analysed **425 interactions** with ChatGPT/Bard/Bing → **6 conversation
  types** from vague to precise; different needs → varied affordances. Give
  **suggested prompts + structured quick actions** for vague-prompt users, and a
  clean open composer for precise users.
- 2026 trust properties (Parallel/Fuselab): **capability transparency, recovery
  patterns, confidence display, accessibility**. Sources:
  [Fuselab 2026](https://fuselabcreative.com/chatbot-interface-design-guide/),
  [Parallel UX trust](https://www.parallelhq.com/blog/ux-ai-chatbots).

### 1.3 Streaming & feedback (the agent is slow — make waiting legible)
- Stream **token-by-token** (typewriter), never a 10s+ spinner (we have A2
  streaming). Always offer **Stop generating**. Show a processing marker the
  instant the prompt is taken over (never a frozen UI). Source:
  ui-ux-pro-max `ux` "AI Interaction/Streaming".
- For long agent work (tools, compaction): a **layer-cake of legible states**
  (taken over → thinking → tool running → compacting → done), each with a calm
  micro-animation; respect `prefers-reduced-motion`.

### 1.4 Composer (the single most important control)
- Multi-line edit; **Enter sends, Shift+Enter newline**; attachments; the input
  is a focal anchor (place primary actions there — Fitts). Source:
  [UXPin chat UI](https://www.uxpin.com/studio/blog/chat-user-interface-design/).
- **Progressive disclosure** of advanced knobs (Hick's law: fewer visible
  choices = faster decisions). OpenClaw itself hides voice/model/sensitivity
  behind an "Advanced ▾" (image #27) — we keep the *feature*, improve the reveal.

### 1.5 Cognitive-load & interaction laws
- **Hick** (limit visible options → progressive disclosure for the settings),
  **Fitts** (big, close targets: composer send, 44×44 min), **Miller** (chunk
  groups of ~5), **Gestalt proximity** (group related controls). 
- **Accessibility (non-negotiable):** WCAG AA ≥4.5:1, full keyboard nav, 44px
  targets, **ARIA live region** for streaming text, visible focus,
  `prefers-reduced-motion`.

### 1.6 Errors & recovery
- Per-message failure marker + inline **retry** (don't make the user retype).

---

## Part 2 — OpenClaw chat features to expose (features, not ergonomics)

Inventory from images #24/#25/#27/#28 + the live 189-method gateway list.

| OpenClaw feature | Evidence | Gateway surface | Our plan |
|---|---|---|---|
| **Reasoning level** (RÉFLEXION: Inherited/High/Med/Low) | #24/#25 "Inherited: High" | session config / `sessions.patch`, `config.schema` | per-chat knob, shows inheritance from agent default |
| **Fast** (RAPIDE), **Verbose** (DÉTAILLÉ), **Reasoning** (RAISONNEMENT) | #24 columns | session config knobs | same generic knob panel |
| **Model selection** (`gpt-5.5 · openai-codex`) | #25 | `models.list` | per-chat model picker (Command palette) |
| **Context usage** (`23% used 62.2k/272k`, `Utilisation 99%`) | #25/#27 | session token counts (`chat.history`/`sessions.describe`) | always-visible context meter (spotted-pattern target) |
| **Voice / Start Talk / Sensitivity** | #27 | `talk.*`, `tts.personas`, `tts.providers` | composer "Advanced" voice section (later phase) |
| **New session** | #25/#27 | new chat | already have New chat |
| **Export** | #27 "Exporter" | client-side | export transcript (md/json) |
| **Attach file** | #27 | `chat.send.attachments` | done |
| **Tools toggle** | (ours) | — | done |
| **Session history / archived** | #24 "sessions archivées" | `sessions.list`, `chat.history`, `sessions.compaction.restore` | history + archived recovery (matrix task) |
| **Compaction state** | #24 "COMPACTAGE" | lifecycle/compaction events | status chip |

### 2.1 The load-bearing architectural decision — REVISED after a READ-ONLY probe (2026-06-05)
The user's hard constraint: *our UI must never block new OpenClaw features.* My
first instinct was a fully-generic renderer over `config.schema`. **A read-only
probe of the live gateway proved that wrong** (the same "probe the real shape
first" lesson as the `/api/media` SPA false-positive). Real shapes:

- **`sessions.describe({ key })`** (NOTE: param is `key`, not `sessionKey`) returns
  a SELF-DESCRIBING per-session meta object — the right source for chat knobs:
  ```
  thinkingLevels:[{id:"off",label:"off"}…{id:"xhigh"}], thinkingOptions:[off..xhigh],
  thinkingDefault:"high", verboseLevel:"full",
  model:"gpt-5.5", modelProvider:"openai-codex", agentRuntime:{id:"codex"},
  totalTokens:62226, contextTokens:272000, estimatedCostUsd:1.78,
  status:"done", runtimeMs, startedAt, endedAt
  ```
  → the **context meter** is `totalTokens / contextTokens` = 62226/272000 = **22.9% ≈ 23%**
  — EXACT match to image #27 ("23% context used 62.2k/272k"). Model + reasoning
  (thinking) + verbose are here too, with their enums.
- **`sessions.list`** carries the same per-session block + a `defaults` block
  (model, contextTokens, thinkingDefault) — the inheritance source.
- **`models.list`** → `[{id,name,provider,alias?}]` (gpt-5.5, gpt-5.4-mini, …).
- **`config.schema.lookup({path})`** → the **FULL gateway config TREE**
  (agents.defaults, agents.list, hints/tags) — NOT a per-session knob descriptor.
  So a generic config.schema renderer is the WRONG abstraction for chat knobs
  (too broad, and dangerous to expose as chat settings).

**Revised decision (honest, fact-based):**
- Drive the knobs from the **self-describing `sessions.describe` enums**
  (`thinkingLevels`/`thinkingOptions` for RÉFLEXION, `verboseLevel` for DÉTAILLÉ)
  + **`models.list`** for the model picker. This IS forward-compatible for those:
  the enums are READ from the gateway, so a new thinking level / model appears
  without a frontend change.
- **NOT YET FOUND in sessions.describe:** RAPIDE + RAISONNEMENT (image #24 columns).
  They may be per-model flags or live on another surface → needs a follow-up
  read-only probe (off-hours). Until then they are out of scope, NOT hardcoded.
- **Write path (per-chat override) = `sessions.patch`** — its exact params are
  UNVERIFIED (we deliberately did NOT call a write during active user hours).
  Increment 1 is therefore **read-only** (chips + meter); the write-back is a
  later increment gated on an off-hours `sessions.patch`-param probe.
- This extends the bridge's normalized-vocabulary boundary to a **session-meta
  descriptor** (read) + a **knob-set write** (later); Hermes implements the same.

---

## Part 3 — Design direction (build on our theme, elevate the interaction)

Keep our shadcn/radix-nova tokens + light/dark/system (already shipped). The
ui-ux-pro-max run flagged: OLED-dark friendliness, **Lexend/Source Sans 3** for
readable/accessible type, calm minimal effects, no-emoji SVG icons (Lucide),
cursor-pointer + 150–300ms hover, WCAG. We adopt the *principles*, not a palette
churn.

Layout (fighting the F-pattern, riding the layer-cake):
- **Top bar = "spotted" strip**: model name · reasoning chip · context meter ·
  session/history/settings icons (image #25 features, our ergonomics). Left-aligned
  meaning first (chat title), right cluster for status/actions.
- **Transcript = layer-cake**: clear role headers/avatars, generous spacing,
  markdown + tool cards + media parts; autoscroll with a **scroll-to-bottom**
  pill when the user scrolls up; per-message actions (copy, retry on error) on hover.
- **Composer = focal anchor (bottom, full-width, elevated)**: multiline,
  Enter/Shift+Enter, attach, tools toggle, **Stop generating** while streaming,
  and an **"Advanced ▾"** popover holding the schema-driven knobs (reasoning,
  model, fast/verbose, voice). Suggested-prompt chips on empty state.
- **Empty state**: capability transparency — what this agent can do + 3–4
  suggested prompts (helps the "vague prompt" conversation type).
- **Streaming/processing**: ARIA-live, typewriter, calm state chips
  (taken over / thinking / tool / compacting), Stop generating.

---

## Part 4 — Implementation plan (incremental, each chrome-devtools-verified)

1. **Context meter + reasoning/model chips** in the top bar (read-only first):
   surface session token usage + current model + reasoning level. (Backend: bridge
   reports session meta → Convex; Frontend: top-bar strip.)
2. **Schema-driven session-settings descriptor**: bridge reads `config.schema` +
   `models.list`; Convex stores a per-chat `sessionSettings` (optional) + the
   descriptor; write-back via `sessions.patch`. Generic settings panel
   ("Advanced ▾" popover) renders it.
3. **Composer polish**: Stop generating, scroll-to-bottom pill, empty-state
   suggested prompts, per-message copy/retry, keyboard model.
4. **Export** transcript (md/json). **Voice/Talk** (talk.*) as a later phase.
5. **Accessibility & motion pass**: ARIA live, focus, reduced-motion, contrast,
   44px targets — verified.

Each step ships behind the existing optional-schema discipline (new Convex fields
OPTIONAL), tests where logic exists, and a live chrome-devtools check.

> Forward-compat guarantee: knobs come from `config.schema`, models from
> `models.list`, voices from `talk.catalog` — so a new OpenClaw release surfaces
> in our UI without code changes.
