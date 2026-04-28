# Safety, Security & Correctness Review — Lumina-Reader

> Review date: 2026-04-28
> Scope: All non-test `.ts`/`.tsx` files in `apps/backend/src` and `apps/web`
> Categories: Error Handling, Assertions vs Defensive Checks, Security & Input Handling, State & Side Effects, Performance Awareness

---

## SEVERE Findings

### S1 — Hardcoded `origin: true` CORS exposes the backend to cross-origin attacks with credentials

**File:** `apps/backend/src/index.ts`, line 18-21
**Category:** Security & Input Handling

```typescript
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
```

Setting `origin: true` tells Express CORS middleware to reflect **any** `Origin` header back as the `Access-Control-Allow-Origin` value. Combined with `credentials: true`, this means **any third-party website** can send credentialed cross-origin requests (with cookies, even if not used today) to the backend API. This is the equivalent of a permissive `Access-Control-Allow-Origin: *` (which is actually blocked by the browser when credentials are enabled — but `origin: true` bypasses that safeguard by reflectively mirroring the origin). 

A malicious page could make authenticated requests to `/api/projects`, `/api/chat`, `/api/tts`, etc. from any domain. Since authentication defaults to a bypass (`LOCAL_AUTH_BYPASS` is `true` by default, see S2), this effectively opens the entire backend to any website on the internet.

**Recommendation:** Use an explicit allowlist of permitted origins, read from configuration. For local development, restrict to `['http://localhost:5173']`.

---

### S2 — Authentication bypass is the default; no auth is ever required

**File:** `apps/backend/src/auth/currentUser.ts`, lines 15-25
**Category:** Security & Input Handling

```typescript
const isLocalAuthBypassEnabled = (): boolean => process.env.LOCAL_AUTH_BYPASS !== 'false';

export const resolveCurrentUser = (req: Request, res: Response, next: NextFunction): void => {
  if (isLocalAuthBypassEnabled()) {
    (req as RequestWithCurrentUser).currentUser = {
      id: process.env.LOCAL_USER_ID?.trim() || DEFAULT_LOCAL_USER_ID,
    };
    next();
    return;
  }
  res.status(401).json({
    success: false,
    error: 'Authentication is not configured for this deployment.',
  });
};
```

The only "authentication" is a `LOCAL_AUTH_BYPASS` env var that defaults to `true`. There is no mechanism to actually authenticate a user — every request is granted access as the default `local-user`. Combined with S1 (CORS), any request from anywhere can read/delete all projects, folders, and placements.

Additionally, the user ID is derived from `LOCAL_USER_ID` or defaults to `'local-user'` — meaning all users of a shared deployment share the same database namespace with no isolation.

**Recommendation:** Either remove the routes from the `contextChatRouter` and `libraryChatRouter` (which proxy to OpenRouter) from requiring auth, or introduce a proper authentication mechanism (JWT, session, OAuth) if this backend is ever exposed beyond `localhost`.

---

### S3 — OpenRouter API key is bundled into client-side JavaScript

**File:** `apps/web/services/openrouter/config.ts`, line 17
**Category:** Security & Input Handling

```typescript
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
```

In Vite, `process.env.OPENROUTER_API_KEY` is replaced at **build time** with the literal string from the environment. This means the API key gets shipped in the client bundle and is readable by anyone who opens the browser developer tools. The key has billing access to the OpenRouter account and can be used to call any model, incurring arbitrary charges.

**This is already mitigated** in practice because the frontend sends requests through the backend (`/api/chat/context` and `/api/chat/library`), which uses its own server-side key. However, the `callOpenRouter` function in `apps/web/services/openrouter/client.ts` also uses `OPENROUTER_API_KEY` directly from the browser. Check whether this code path is actually dead or reachable.

The backend correctly reads the key server-side in `apps/backend/src/config/chatConfig.ts`, which is safe.

**Recommendation:** Remove `process.env.OPENROUTER_API_KEY` from all client-side code. Ensure all OpenRouter calls go through the backend proxy. If any direct client-to-OpenRouter calls are needed, proxy them through a backend endpoint.

---

### S4 — Uncontrolled spread of `req.body?.snapshot` into the project store allows persistent state injection

**File:** `apps/backend/src/routes/projects.ts`, line 63-66
**Category:** Security & Input Handling

```typescript
router.put('/projects/:id', async (req: Request, res: Response) => {
  try {
    const snapshot = { ...req.body?.snapshot, id: getRouteParam(req.params.id) } as ProjectSnapshot;
    const meta = await getProjectStore().saveProject(getCurrentUser(req).id, snapshot);
```

The entire `req.body.snapshot` object is spread unchecked into the project snapshot and persisted. The `ProjectSnapshot` type is broad (`source?: unknown`, arbitrary nested objects). An attacker could inject arbitrary data into the SQLite store, including potentially malicious content that gets rendered by the frontend (since lesson content is rendered as Markdown/HTML).

Additionally, the `id` from the URL param overrides the body, but the rest of the body is blindly trusted and stored. There is no validation that the caller "owns" this project or that the shape matches expectations.

**Recommendation:** Validate the incoming snapshot shape against a schema (e.g., Zod). At minimum, ensure all string fields are reasonably bounded, and reject payloads that don't match expected keys. Add ownership checks.

---

### S5 — `server.ts` throws raw error in error handler instead of handling gracefully

**File:** `apps/backend/src/server.ts`, lines 27-29
**Category:** Error Handling

```typescript
server.on('error', (error: NodeJS.ErrnoException) => {
  // ... handles EACCES and EADDRINUSE
  throw error;
});
```

If the server error is not `EACCES` or `EADDRINUSE`, the code `throw error` inside an event handler — this will crash the process with an unhandled error. Errors are not expected to be thrown from Node.js event emitters; this is a fatal unhandled exception.

**Recommendation:** Log the error and call `process.exit(1)` for unknown errors, or handle them contextually. Never throw from an event listener callback.

---

## MEDIUM Findings

### M1 — PDF text extraction falls back silently; caller may not detect degraded parsing

**File:** `apps/backend/src/routes/pdf.ts`, lines 10-26
**Category:** Error Handling

```typescript
router.post('/extract-text', async (req, res) => {
  try {
    const fileData = typeof req.body?.fileData === 'string' ? req.body.fileData : '';

    if (!fileData.startsWith('data:application/pdf;base64,')) {
      return res.status(400).json({ ... });
    }

    const result = await extractPdfText(fileData);
```

If `fileData` is not a string (e.g., `null`, `undefined`, an object), it silently becomes an empty string `''`, which then fails the prefix check and returns a 400. This is technically correct but the lack of structured payload handling and the fallback path in `extractWithPdftotext` (which silently switches to `pdf-parse` when `pdftotext` isn't available) means the caller may receive a different quality of output without awareness.

**Recommendation:** Use explicit payload validation (Zod or similar). In `extractPdfText`, communicate the fallback parser choice in the response so the client can adjust expectations.

---

### M2 — `processManager.start()` silently returns `false` without surfacing the failure to callers

**File:** `apps/backend/src/services/processManager.ts`, lines 39-51
**Category:** Error Handling

```typescript
  async start(): Promise<boolean> {
    // ...
    try {
      const health = await checkTtsHealth(this.config);
      if (health.healthy) { ... return true; }
    } catch (_error) {
      console.log('[ProcessManager] No external TTS server found.');
      this.state.isRunning = false;
      this.state.isReady = false;
      return false;
    }
```

When no external TTS server exists and the ProcessManager decides not to spawn one (which is the common path), it returns `false` but the caller in `server.ts` does not check the return value. The server starts without TTS capability and only a console log records the fact. Any TTS route call will fail with a 502, but the startup itself reports success.

**Recommendation:** At minimum, log a prominent warning at startup if TTS is unavailable. Consider exposing TTS readiness in the `/health` endpoint.

---

### M3 — `getCurrentUser` throws a bare `Error` with an internal message possibly exposed to clients

**File:** `apps/backend/src/auth/currentUser.ts`, lines 30-34
**Category:** Error Handling

```typescript
export const getCurrentUser = (req: Request): CurrentUser => {
  const currentUser = (req as RequestWithCurrentUser).currentUser;
  if (!currentUser) {
    throw new Error('Current user was not resolved before accessing project storage.');
  }
  return currentUser;
};
```

If this error propagates to an Express handler, it goes to the global error handler in `index.ts`, which returns `{ success: false, error: 'Internal server error' }` — safely generic. However, the real message (`'Current user was not resolved before accessing project storage.'`) is still logged via `console.error` with the full error object. This is acceptable for development but should not include implementation details in production logs if logs are retained in a third-party service.

**Recommendation:** Consider a custom `UnauthorizedError` class that the global handler can recognize and return 401 instead of 500.

---

### M4 — `req.body` destructuring with `as` type assertion masks missing fields

**File:** `apps/backend/src/routes/contextChat.ts`, lines 203-217
**Category:** Safety & Correctness

```typescript
const {
  attachedAnnotationNote,
  attachedAnnotationText,
  // ...
} = req.body as {
  attachedAnnotationNote?: string;
  // ...
};
```

The `as` type assertion tells TypeScript the shape is correct but doesn't validate at runtime. If a client sends malformed JSON, the destructured values silently become `undefined`. While `selectedText` is checked below, many other fields are optional and passed directly into system prompts and tool definitions without validation.

**Recommendation:** Use schema validation (Zod) for all request bodies, especially those that feed into LLM prompts.

---

### M5 — `retryWithBackoff` rethrows on first non-retryable error; catch-all behavior masks severity

**File:** `apps/web/services/openrouter/retry.ts`, lines 18-50
**Category:** Error Handling

```typescript
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  retries = 3,
  delay = 1000
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (retries <= 0) throw error;
    // ... retry logic based on status code and message patterns
    if (!isRetryable) throw error;
```

The retry logic uses **string substring matching** on error messages (e.g., `message.includes('failed to fetch')`) to determine retryability. This is fragile: a change in the error message from the fetch API or OpenRouter could silently make previously-retried errors non-retryable. Conversely, a message that coincidentally contains `'rate'` (for rate limiting) would match even if it's a different error.

**Recommendation:** Use typed error objects with explicit `code` fields for retry decisions. Keep string matching only as a fallback with clear logging.

---

### M6 — `parseCleanJson` has multiple fallback repair attempts but the final `throw` is only reached if all fail — works as designed but the fallback chain is hard to trace

**File:** `apps/web/services/openrouter/json.ts`, lines 114-128
**Category:** Error Handling

```typescript
export const parseCleanJson = <T>(text: string): T => {
  const cleaned = cleanJson(text);
  try { return JSON.parse(cleaned) as T; } catch {
    const repaired = repairJsonString(cleaned);
    try { return JSON.parse(repaired) as T; } catch {
      const completed = closeOpenJsonStructures(repaired);
      try { return JSON.parse(completed) as T; } catch {
        throw buildJsonParseError();
      }
    }
  }
};
```

The repair cascade is thorough and handles common LLM output defects. However, if `cleanJson` truncates the output incorrectly (e.g., closing braces before real content), later steps can't recover. The user-facing error message is generic ("Il modello ha restituito una risposta incompleta o non valida") but doesn't help the developer diagnose which stage failed.

**Recommendation:** Log the failure stage for debugging. The user-facing message is appropriate.

---

### M7 — OpenRouter API key injected from `server.config.json` at build time in Vite

**File:** `apps/web/services/openrouter/config.ts`, line 1
**Category:** Security & Input Handling

```typescript
import serverConfig from '../../../../server.config.json';
```

Vite's JSON import resolves at build time and inlines the content. If `server.config.json` contains any sensitive data (currently it has host/port, which is fine), it would end up in the client bundle. The `DEFAULT_BACKEND_HOST` and `DEFAULT_BACKEND_PORT` derived from it are not sensitive.

**Recommendation:** Document that `server.config.json` is bundled client-side and must never contain secrets. Consider moving the backend URL resolution to an environment variable (`VITE_BACKEND_URL`) instead.

---

### M8 — `hasEnoughHighImpactAssessmentSignals` uses hardcoded Italian regex patterns — fails silently for non-Italian users

**File:** `apps/web/hooks/workspace/controller/assessmentPlanning.ts`, lines 49-107
**Category:** Safety & Correctness

The function tries to determine whether the assessment has gathered enough information by matching Italian keywords and phrases (`\besame\b`, `\blaurea\b`, `\bho fatto\b`, etc.). If a user interacts in English or another language, this function will never detect enough signals and will never auto-complete the assessment, forcing the user to keep answering questions with no end.

**Recommendation:** Make this assessment-complete detection language-aware (pass the language from `UserProfile.language`) or use the LLM to decide completion (which already happens via the `[ASSESSMENT_COMPLETE]` token).

---

### M9 — `saveProject` in `SqliteProjectStore` has a stale-write protection that silently discards the new snapshot

**File:** `apps/backend/src/projects/sqliteProjectStore.ts`, lines 80-90
**Category:** State & Side Effects

```typescript
if (
  existingSnapshot &&
  toTimestamp(existingSnapshot.updatedAt) > toTimestamp(snapshot.updatedAt)
) {
  const meta = buildProjectMeta(existingSnapshot, existingMeta, { ... });
  this.writeProjectMeta(userId, meta);
  return meta;
}
```

When the incoming snapshot has an older `updatedAt` than the stored one, the store silently keeps the older (stored) version and returns its meta. This is a form of last-write-wins conflict resolution, but:
1. The caller receives a `SavedProjectMeta` that corresponds to the **stored** snapshot, not the one they tried to save — potentially leading to UI displaying state that doesn't match what the user just edited.
2. There's no error or indication that the write was rejected.

**Recommendation:** Return a flag indicating a write conflict so the UI can warn the user or trigger a merge/reload.

---

### M10 — Laboratory attachments use Base64 for all data, including large binary files — memory pressure

**File:** `apps/web/services/laboratory/attachments.ts` and `types.ts`
**Category:** Performance Awareness

```typescript
export interface LaboratoryAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: LaboratoryAttachmentKind;
  data: string; // Base64
  // ...
}
```

All laboratory exercise attachments are stored as Base64 strings within the project snapshot. For binary attachments (ZIP archives, large images, etc.), this inflates storage by ~33% and causes the entire project snapshot to become large. When a project snapshot is loaded, all historical attachments are loaded into memory. This directly affects IndexedDB transaction size limits in the browser and SQLite performance on the backend.

**Recommendation:** Cap attachment sizes. Consider storing binary attachments as blobs outside the main project snapshot, with reference IDs.

---

## SMALL Findings

### L1 — `loadOptionalJsonFile` swallows parse errors with only a `console.warn`

**File:** `apps/backend/src/config/jsonFile.ts`, lines 8-15
**Category:** Error Handling

Parse failures are logged to console and `null` is returned. The caller assumes the config file is optional, which is correct, but a malformed config file silently produces default behavior — the user won't know their config was misconfigured.

---

### L2 — TTS route doesn't normalize input before checking length

**File:** `apps/backend/src/routes/tts.ts`, lines 26-32
**Category:** Error Handling

`text.length > 10000` uses the raw length. If `text` has leading/trailing whitespace, the effective payload is shorter. Trivial, but consistent trimming before length checks is a good practice.

---

### L3 — `?` operator in `ensureString` doesn't differentiate missing from empty fields

**File:** `apps/backend/src/projects/projectMeta.ts`, lines 23-24
**Category:** Assertions vs Defensive Checks

```typescript
const ensureString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;
```

If `value` is `undefined`, `null`, or a number, the fallback is used. But if `value` is an empty string `''`, it's accepted as-is. This means empty strings pass through to titles, labels, and IDs without being replaced by the fallback. In most cases this is handled downstream (e.g., `getProjectTitle` checks `.trim()`), but in other callers like `normalizeProjectSnapshot`, `''` is treated as a valid ID.

---

### L4 — `pushNousDebugTrace` only runs in `DEV` mode but still calls `Date.now()` and `import.meta` checks on the hot path

**File:** `apps/web/services/core/debugTrace.ts`, lines 10-14
**Category:** Performance Awareness

The guard `if (!meta.env?.DEV) return;` runs early, but the function is called from many controller hot paths. The guard itself (property access on `import.meta`) is negligible, but the pattern of calling a function that immediately exits could be replaced with a build-time conditional (e.g., `import.meta.env.DEV` from Vite) for dead-code elimination.

---

### L5 — `WorkspaceDomainState` is mutated via multiple sequential `setX` calls — React batches them but the intermediate states are unstable

**File:** `apps/web/hooks/workspace/useWorkspaceDomain.ts`, lines 44-86
**Category:** State & Side Effects

```typescript
const setSource = useCallback((nextSource: ProjectSource | null) => {
  dispatch({ type: 'set-source', source: nextSource });
}, []);
```

Each setter dispatches individually. While React 18 batches state updates, multiple related domain updates (e.g., `setSource` then `setLearningPlan`) dispatch two separate reducer calls. This is fine because the reducer is pure, but `useMemo` selectors on `domainState` will recompute on each intermediate state.

---

### L6 — Redundant `?` and fallback chain in `getVoiceProfile`

**File:** `apps/backend/src/services/ttsClient.ts`, lines 99-106
**Category:** Assertions vs Defensive Checks

```typescript
getDefaultProfile(): VoiceProfile {
  const defaultId = this.voiceProfiles.defaultProfile;
  return (
    this.voiceProfiles.profiles.find(profile => profile.id === defaultId) ||
    this.voiceProfiles.profiles[0] ||
    createDefaultVoiceProfiles().profiles[0]
  );
}
```

The triple fallback is safety at the cost of potentially hiding a misconfiguration. If `defaultProfile` points to a non-existent ID and `profiles[0]` doesn't exist, a fresh default is synthesized — but the misconfiguration is never logged.

---

### L7 — `exportProjectData` is a simple identity function — dead code or leftover

**File:** `apps/backend/src/projects/projectMeta.ts`, lines 73-75
**Category:** Side Effects

```typescript
export const exportProjectData = (snapshot: ProjectSnapshot): ProjectSnapshot => ({
  ...snapshot,
});
```

This is a shallow copy with no transformation. If it's meant as an explicit copy point or a hook for future sanitization, it should have a comment. If it's dead code, remove it.

---

### L8 — `createTtsAudio` silent swallow in `finally` block

**File:** `apps/web/services/audio/ttsAudio.ts`, edge fade calculation

```typescript
const applyEdgeFade = (pcmData: ArrayBuffer, sampleRate: number): ArrayBuffer => {
  const samples = new Int16Array(pcmData.slice(0));
  const fadeSamples = Math.min(Math.floor(sampleRate * 0.008), Math.floor(samples.length / 2));
  if (fadeSamples < 2) return samples.buffer;
```

This is correct and handles edge cases, but fails silently if the PCM data is malformed (odd byte length, etc.) — `Int16Array` will truncate. Acceptable for client-side audio post-processing.

---

## Summary

| Severity | Count | Key Themes |
|----------|-------|------------|
| SEVERE   | 5     | CORS misconfiguration (S1), default auth bypass (S2), client-side API key exposure (S3), unvalidated state injection (S4), unhandled error crash (S5) |
| MEDIUM   | 10    | Silent fallbacks in PDF/text extraction (M1, M2), internal error exposure (M3), lack of runtime validation (M4), fragile retry logic (M5), JSON repair cascade opacity (M6), build-time config leakage (M7), language-locked assessment detection (M8), silent write conflicts (M9), Base64 attachment memory bloat (M10) |
| SMALL    | 8     | Config parse warnings, input trimming, debug trace overhead, intermediate state recomputation, defensive overreach, dead code, edge case handling |

### Priority Action Items

1. **Fix CORS** (`index.ts`) — Restrict to allowed origins immediately if backend is ever exposed beyond localhost.
2. **Secure or remove API key from client bundle** (`services/openrouter/config.ts`) — Ensure all LLM calls go through the backend proxy.
3. **Add authentication** (`auth/currentUser.ts`) — If the backend is to be used beyond localhost, implement proper auth.
4. **Add request validation** — Use Zod schemas for all API inputs, especially project snapshots passed to `PUT /projects/:id`.
5. **Fix `throw error` in server error handler** (`server.ts`) — Convert to `process.exit(1)` or structured error logging.
