# Performance Baseline — FASE 1

Misurato il 2026-05-02 prima delle modifiche FASE 1.

## Setup

- Backend: SQLite (LAN) su localhost:3301
- Frontend: Vite dev su localhost:5173
- PDF sorgente: ~200 pagine misto testo/immagini
- Strumento: `performance.mark` / `performance.measure` in console browser

## Hot path: apertura progetto

| Step | Durata (ms) | Note |
|------|------------|------|
| `loadProject` (HTTP GET) | ~120 | Include JSON.parse del blob |
| `persistHydratedSnapshot` | ~350 | PUT full snapshot con JSON.stringify |
| PDF hydration timeout | ~20s | Timeout di 20s (non bloccante, fallisce silenziosamente) |
| **Totale percepito** | **~1500** | Dopo hydrate + persist, prima del render |

## Hot path: highlight

| Step | Durata (ms) | Note |
|------|------------|------|
| `updateSection` (reducer) | <1 | Solo JS, sincrono |
| Autosave debounce | 800 | setTimeout, non bloccante ma ritarda persist |
| `saveCurrentProject` (buildSnapshot) | ~5 | buildPersistenceSignature + createProjectSnapshot |
| `HttpRepository.saveProject` (PUT) | ~350 | JSON.stringify dell'intero snapshot + HTTP round-trip |
| SQLite saveProject | ~15 | full-snapshot upsert (localmente veloce) |
| **Totale percepito** | **~350** | delay prima del feedback "salvato" |

## Hot path: nota su annotazione

| Step | Durata (ms) | Note |
|------|------------|------|
| `updateSectionAnnotationNote` | <1 | Solo JS |
| Autosave debounce | 800 | Come sopra |
| `saveCurrentProject` (PUT) | ~350 | Stesso costo del full snapshot |
| **Totale percepito** | **~350** | |

## Hot path: completamento sezione

| Step | Durata (ms) | Note |
|------|------------|------|
| `completeActiveSection` (reducer) | <1 | Solo JS |
| `saveCurrentProject` (PUT) | ~350 | Full snapshot + HTTP |
| **Totale percepito** | **~350** | Attesa prima di navigare alla prossima |

## Hot path: creazione lezione

| Step | Durata (ms) | Note |
|------|------------|------|
| AI generation | 3000-15000 | Dominante, non ottimizzabile qui |
| `saveCurrentProject` (PUT) | ~350 | Dopo la generazione |
| **Totale percepito** | **~350** | In coda alla generazione AI |

## Riepilogo

- Il bottleneck principale è **B1** — snapshot PUT da ~100KB+ per ogni mutazione
- **B2** (SQLite full rewrite) è trascurabile (~15ms localmente)
- **B3** (React re-render) è già veloce grazie al reducer sincrono
- **Rimedi**: PATCH granulari per annotation, completion, metadata + persistQueue + optimistic update

---

## Modifiche FASE 1 (2026-05-02)

### Cosa è stato implementato

1. **Backend: endpoint `PATCH /api/projects/:id`** — accetta un `{ patch }` con solo i campi da modificare, incluso `section` per annotazioni. Evita la serializzazione/trasporto dell'intero snapshot. ([routes](apps/backend/src/routes/projects.ts), [store](apps/backend/src/projects/sqliteProjectStore.ts))

2. **Client: `patchProject` su `ProjectRepository`** — nuovo metodo sull'interfaccia, implementato su `HttpProjectRepository` (PATCH HTTP) e `IndexedDbProjectRepository` (load + mutate + save locale). ([repo interfaccia](apps/web/services/projects/projectRepository.ts), [HTTP](apps/web/services/projects/httpProjectRepository.ts), [IndexedDB](apps/web/services/projects/indexedDbProjectRepository.ts))

3. **`patchCurrentProject` su `useProjectLibrary`** — nuovo metodo hook che costruisce il delta dai campi `overrides` e invia PATCH. ([hook](apps/web/hooks/library/useProjectLibrary.ts))

4. **Autosave ridotto da 800ms → 400ms** — feedback più rapido senza cambiare la semantica.

5. **Hot path ottimistici** — `openSection`, `completeActiveSection`, `createLessonFromSelection`, `loadSection` ora usano `patchCurrentProject` in modalità fire-and-forget (no await). Il rollback (raro) resta sincrono. ([sectionProgression.ts](apps/web/hooks/workspace/controller/sectionProgression.ts))

6. **Sync indicator** — badge "Salvataggio"/"Errore" nell'header del reader, visibile solo durante stato non-idle. ([componente](apps/web/components/workspace/shell/WorkspaceReaderHeader.tsx), [hook](apps/web/hooks/workspace/useSyncIndicator.ts), [servizio](apps/web/services/projects/syncState.ts))

7. **`persistQueue.ts`** — coda FIFO con dedup per chiave e retry esponenziale (max 3 tentativi). Preparata per uso futuro ma non ancora integrata nei consumer (la semplicità di `patchCurrentProject` via fetch diretta è sufficiente). ([file](apps/web/services/projects/persistQueue.ts))

### Miglioramenti attesi

| Operazione | Prima (ms) | Dopo (ms stimati) | Note |
|-----------|-----------|-------------------|------|
| Highlight singolo | ~350 | ~50 | Il PATCH è ~1KB invece di ~100KB |
| Nota su annotazione | ~350 | ~50 | Idem |
| Completamento sezione | ~350 (bloccante) | ~5 (ottimistico) | `patchCurrentProject` fire-and-forget |
| Apertura sezione (cached) | ~350 (bloccante) | ~5 (ottimistico) | `patchCurrentProject` fire-and-forget |
| Autosave generico | 800+350=1150 | 400+50=450 | Debounce ridotto, PATCH leggera |

### Modifiche aggiuntive (iterazione 2, stesso PR)

8. **`patchSectionAnnotations(sectionId, annotations, content?)`** — metodo dedicato che invia **solo** il delta di una sezione al backend. Payload: ~1KB invece dell'intero `learningPlan`. ([hook](apps/web/hooks/library/useProjectLibrary.ts), [type](apps/web/hooks/workspace/controller/types.ts))

9. **Reader actions → PATCH diretto** — `handleHighlight`, `handleSaveNote`, `handleDeleteAnnotation`, `handleSaveConversationNote` ora chiamano `patchSectionAnnotations()` subito dopo `updateSection()`. L'autosave viene soppresso. ([reader actions](apps/web/hooks/workspace/useWorkspaceReaderActions.ts))

10. **Autosave via PATCH** — l'effetto autosave ora usa `patchCurrentProject()` invece di `saveCurrentProject()`. ([hook](apps/web/hooks/library/useProjectLibrary.ts))

11. **Laboratory controller → PATCH** — `persistActiveLaboratory`, `commitLaboratory`, `openLaboratoryExercise` ora usano `patchCurrentProject()` invece di `saveCurrentProject()`. ([controller](apps/web/hooks/workspace/controller/laboratory.ts))

### Da fare (future iterazioni)

- Integrare `persistQueue.ts` per deduplicare patch rapide consecutive (es. click multipli su highlight)
- Aggiungere test di regressione per optimistic update (mock backend lento → verificare render prima della conferma)
- Estendere indicator di sync anche alla Library screen

---

## Iterazione 6 (2026-05-03) — Schema split: documentIndex in colonna separata

Trace di 1:40 (`Trace-20260503T012347.json.gz`) dopo i fix dell'iterazione 5: PATCH ancora 1487ms, PUT autosave ancora a +1353ms.

### Diagnosi reale: SQLite `json_set` parsa comunque tutto

Il fix con `json_extract`/`json_set` **non aiuta**: SQLite parsa l'intero documento JSON anche per operazioni mirate. Con `documentIndex` di 200 pagine inline in `snapshot_json` (3-5MB), ogni PATCH paga ~1.5s di parsing.

### Fix definitivo: split schema

- Nuova colonna `document_index_json text` su `project_snapshots`.
- Migration idempotente backfilla i progetti esistenti (estrae `documentIndex` da `snapshot_json`, lo sposta nella nuova colonna, e lo rimuove dal vecchio JSON).
- `loadProject`/`readSnapshot`: read merge-on-the-fly delle due colonne.
- `saveProject`: split + write su entrambe le colonne.
- `patchSectionOnly`: torna alla forma semplice `JSON.parse` + mutate + `JSON.stringify` — ora `snapshot_json` è ~10-50KB, l'operazione è <5ms.

File: [`sqliteProjectStore.ts`](apps/backend/src/projects/sqliteProjectStore.ts)

### Test di regressione

`apps/backend/tests/routes/projects.test.ts`:
- `section PATCH stays fast even with a heavy documentIndex`: snapshot con 3MB di documentIndex, PATCH section deve completare <500ms (in pratica ~10ms).
- `migrates inline documentIndex from snapshot_json into its own column`: simula un DB legacy, verifica che la migration backfill funzioni e che il read merge sia trasparente.

### Risultato atteso (da misurare)

| Operazione | Pre | Post |
|-----------|-----|------|
| PATCH section RTT | ~1500ms | <30ms |
| PUT autosave spurio post-highlight | sempre | mai (pendingPatchCountRef già attivo) |

---

## Iterazione 5 (2026-05-02) — Due bug residui

Terza trace (`trace.json.gz` desktop) dopo la fix stale-closure: ancora 428ms click → ancora un PUT `saveProject` a +1710ms.

### Root cause A: backend `patchSectionOnly` lento (~1.8s)

`patchSectionOnly` faceva `JSON.parse(full_snapshot_json)` + mappa sezioni + `JSON.stringify(snapshot)`. Su un progetto con `documentIndex` da 200 pagine il round-trip JSON era ~1.8s in Node.js (sinchrono, bloccava l'event loop e metteva in coda tutti gli altri request).

**Fix**: usare `json_extract` per leggere solo `learningPlan`, applicare la patch in JS, e riscrivere con `json_set(snapshot_json, '$.learningPlan', json(?), '$.updatedAt', ?)`. `documentIndex` non viene mai toccato.
File: `apps/backend/src/projects/sqliteProjectStore.ts`

### Root cause B: autosave non soppresso durante patch in-flight

`patchSectionAnnotations` aggiornava `lastPersistedSignatureRef` DOPO l'`await` (1.8s dopo il click). L'autosave debounce scattava a +400ms (prima della risposta HTTP) perché il confronto firma vedeva old ≠ new. Risultato: PUT a +1710ms nonostante la patch.

**Fix**: `pendingPatchCountRef` incrementato prima dell'`await`, decrementato in `finally`. L'effetto autosave ritorna early se `pendingPatchCountRef.current > 0`.
File: `apps/web/hooks/library/useProjectLibrary.ts`

### Impatto atteso

| Operazione | Prima | Dopo |
|-----------|-------|------|
| PATCH sezione (backend) | ~1800ms | ~5–15ms |
| PUT autosave inutile post-highlight | sempre | mai (patch in-flight) |

---

## Iterazione 4 (2026-05-03) — RISOLTO: era uBlock Origin

**Trace Chrome DevTools del 2026-05-03 ha smentito la diagnosi B3.**

Click event di 537ms analizzato con CPU profiler:
- 209.8ms `ublock-filters.js` (uBOL_scriptlets, setConstant)
- 169.4ms `annoyances-cookies.js` (uBOL_scriptlets)
- 156.2ms idle
- **<1ms codice React/applicativo**

Il bottleneck non era nel codice del reader: **uBlock Origin Lite** inietta scriptlet che bloccano il main thread ad ogni click su pagine con certi pattern. Whitelistare `localhost` in uBO risolve completamente.

**Conseguenze**:
- FASE 1 (optimistic update + PATCH granulari) funziona come progettata.
- L'iterazione 3 (FASE 1bis: useReaderShellProps + memo + split context) **non serve** ed è stata cancellata.
- Lezione per il futuro: **profile prima, refactor dopo**. Ho proposto un refactor da ~300 righe basato su analisi statica. Il trace l'ha smentito in 5 minuti.

## Iterazione 3 (2026-05-03) — ANNULLATA: vedi Iterazione 4

**Sintomo persistente**: l'highlight (e tutte le viste DB-driven) ha ancora ~1s di latenza percepita anche dopo l'optimistic update + PATCH granulari.

### Diagnosi reale: il bottleneck era B3 (re-render React), sottostimato

Il PERF_BASELINE iniziale ha misurato `<1ms` per il reducer JS e ha concluso "B3 è veloce". **Falso**: ha misurato il reducer ma non il React commit phase sull'albero.

Il problema strutturale:

1. **`buildReaderShellProps` ([readerShellProps.ts](apps/web/app/readerShellProps.ts))** è una function non-hook che a ogni render del container produce:
   - Un oggetto fresh con 5 sotto-oggetti (`banners`, `content`, `header`, `overlays`, `sidebar`)
   - 50+ inline arrow function (`onAttachLaboratoryFiles: files => {...}`, `onCompleteSection: () => readerActions.handleCompleteSection()`, etc.)
   - **Tutte nuove referenze ad ogni render.**

2. **`useWorkspaceDomain` ([useWorkspaceDomain.ts:46-51](apps/web/hooks/workspace/useWorkspaceDomain.ts:46))** ha `useMemo([domainState])` su `activeSection`/`sectionContent`/`quiz`/etc. → ogni `updateSection` invalida tutti i selettori contemporaneamente.

3. **Zero memoization sui componenti pesanti**: solo 3 `memo()` in tutta la repo. WorkspaceReaderShell, Sidebar (599 LOC), ReaderContent (268 LOC), Header (386 LOC) — tutti non memoizzati. Anche se lo fossero, riceverebbero props sempre nuove (vedi punto 1) → memo inutile.

**Risultato**: ogni `updateSection` provoca il re-render dell'intero albero del reader, inclusi sidebar con tutta la learning plan e markdown content.

### Piano di fix (FASE 1bis)

Eseguibile in 3 step incrementali. **Misurare dopo ogni step.**

#### Step 1: stabilizzare le props del Shell (alto impatto, basso rischio)

Convertire [`buildReaderShellProps`](apps/web/app/readerShellProps.ts) da plain function a hook `useReaderShellProps`:

- Avvolgere ciascuno dei 5 sotto-oggetti (`banners`, `content`, `header`, `overlays`, `sidebar`) con `useMemo` con dipendenze esplicite.
- Sostituire le inline arrow function con `useCallback` (o estrarre handler dal container che già le ha stabili).
- Selettori derivati (`isLaboratoryBusy`, `activeLaboratoryExercise`, `activeSectionSourcePageRangeLabel`) avvolti con `useMemo`.

**Effetto atteso**: i 5 sotto-oggetti cambiano ref *solo* quando i loro inputi reali cambiano. Sidebar non rerendera durante un highlight nel content.

#### Step 2: memo sui componenti top-level del Shell

- `WorkspaceReaderShell`, `WorkspaceReaderSidebar`, `WorkspaceReaderContent`, `WorkspaceReaderHeader` → wrap con `React.memo`.
- Verificare che dopo lo Step 1 le props siano davvero stabili (controllo via `whyDidYouRender` o un piccolo Profiler wrapper temporaneo).

#### Step 3: split useMemo in `useWorkspaceDomain` (se ancora lento)

In [useWorkspaceDomain.ts](apps/web/hooks/workspace/useWorkspaceDomain.ts):

- I `useMemo([domainState])` per `activeSection`, `sectionContent`, etc. invalidano insieme. Ridurre dipendenze a sotto-rami specifici.
- `selectActiveSection(domainState)` può dipendere solo da `domainState.learningPlan` + `domainState.activeSectionId`, non dall'intero stato.

#### Misurazione

Prima di ogni step e dopo, aggiungere un `<Profiler>` temporaneo attorno a `WorkspaceReaderShell` con `onRender` che logga `actualDuration` in console. Eseguire un highlight, leggere il numero. Salvare prima/dopo qui.

### Per il modello esecutore (prompt da incollare)

> FASE 1 ha ottimizzato la persist (B1) ma il bottleneck reale è B3 (re-render). Esegui il piano di fix in `docs/PERF_BASELINE.md` sezione "Iterazione 3":
> 1. **Aggiungi un `<Profiler>` wrapper temporaneo** attorno a `WorkspaceReaderShell` in `ReadingScreenContainer.tsx`. `onRender` logga `actualDuration` in console. Salva la baseline (highlight ms) prima di toccare altro.
> 2. **Step 1**: converti `buildReaderShellProps` in `useReaderShellProps`. Avvolgi i 5 sotto-oggetti con `useMemo`, le inline arrow con `useCallback`. Misura.
> 3. **Step 2**: `memo()` su Shell + Sidebar + Content + Header. Misura.
> 4. **Step 3** (solo se ancora >100ms): split `useMemo([domainState])` in `useWorkspaceDomain`.
> 5. **Test**: aggiungi un test che monta il Reader e conta i render durante un `updateSection`. Sotto i 3 render = passa.
> 6. Rimuovi il `<Profiler>` temporaneo prima del PR.
