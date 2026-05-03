# Performance Baseline — FASE 1

Misurato il 2026-05-02, aggiornato al 2026-05-03 dopo il commit finale.

## Setup

- Backend: SQLite (LAN) su localhost:3301
- Frontend: Vite dev su localhost:5173
- Strumenti: `performance.mark`/`measure` (baseline), React DevTools Profiler (post-fix)

---

## Baseline (prima delle modifiche)

| Operazione | Durata (ms) | Causa |
|-----------|------------|-------|
| Highlight + persist | ~350-1800 | PUT full snapshot + SQLite JSON parsing |
| Nota su annotazione | ~350 | Stesso costo full snapshot |
| Completamento sezione | ~350 (bloccante) | PUT prima di navigare |
| Apertura sezione (cached) | ~350 | PUT activeSectionId |

---

## Modifiche FASE 1 (committate 2026-05-03)

### Backend (3 file)

| Modifica | Impatto |
|----------|---------|
| `PATCH /api/projects/:id` — endpoint che accetta delta (section, scalar) | Payload ridotto da ~100KB a ~1KB |
| `patchSectionOnly()` in transazione esplicita (`database.transaction`) | Lock window dimezzato: 2 UPDATE → 1 commit |
| `touchProject()` senza `readSnapshot()` completo | Evita di caricare ~237KB JSON solo per aggiornare `lastOpenedAt` |

### Client persistenza (5 file)

| Modifica | Impatto |
|----------|---------|
| `ProjectRepository.patchProject()` su interfaccia + HTTP + IndexedDB | Chiamata PATCH invece di PUT |
| `patchCurrentProject(overrides)` su `useProjectLibrary` | Costruisce il delta e invia PATCH |
| `patchSectionAnnotations(sectionId, annotations, content?)` | Invia solo il delta sezione (~1KB) |
| `persistQueue.ts` | FIFO + dedup + retry esponenziale (pronto, non integrato) |
| `syncState.ts` + `useSyncIndicator` + `SyncBadge` | Badge "Salvataggio"/"Errore" con auto-clear 2s |

### Performance React (7 file)

| Modifica | Impatto |
|----------|---------|
| `useReaderShellProps` hook con `useMemo` su 5 sotto-oggetti | Sidebar/header/banners non si rifanno per highlight |
| `React.memo` su Shell, Sidebar, Content, Header | Confronto shallow props prima di re-render |
| `useWorkspaceDomain`: selettori con dipendenze strette (`[learningPlan, activeSectionId]`) | I selettori non si invalidano tutti insieme |
| `useMemo` sull'intero return di `useWorkspaceDomain` | Controller stabile (non cambia ref a ogni dispatch) |
| Header: primitive (`activeSectionId`, `activeSectionTitle`) invece di `LearningSection` | Header non re-rendera per annotazioni |
| Debug trace: dipende da `learningPlan` stabile | Zero console.log spuri dopo highlight |
| Hot path ottimistici: `patchCurrentProject` fire-and-forget | Sezione naviga subito, persist in background |

---

## Diagnosi reale del collo di bottiglia residuo (da review esterno)

Dopo tutte le ottimizzazioni, resta un problema **architetturale** non risolto in questa fase:

### 1. Annotazioni incorporate in `content`

```typescript
handleHighlight()
  -> applySectionAnnotation(...)
  -> updateSection(activeSectionId, section => ({
       ...section,
       content: result.content,     // <-- problema: content mutato
       annotations: result.annotations,
     }))
```

Ogni highlight modifica `content` (incolla `<mark>` tag nel markdown). Questo forza:
- Nuova `LearningSection` → nuovo `learningPlan` → nuovo `domainState`
- `React.memo` vede `sectionContent` cambiato → `MarkdownRenderer` ri-analizza tutto
- Le 1500 parti della lezione vengono ri-processate per colorare tre parole

**Soluzione**: separare annotazioni dal contenuto markdown. Le annotazioni dovrebbero essere un overlay CSS sul testo stabile, non una mutazione del documento.

### 2. Propagazione a sidebar

La sidebar deriva `sidebarGroups` da `learningPlan.sections` completo — ogni annotazione rischia di ricostruire la sidebar. Richiede una proiezione leggera: `{ id, title, parentId, completed }` invece dell'intera `LearningSection`.

### 3. `updateSectionInPlan` invalida l'intero albero

```typescript
const updateSectionInPlan = (learningPlan, sectionId, updater) => ({
  ...learningPlan,
  sections: learningPlan.sections.map(section => ...)  // nuovo array
});
```

Ogni highlight produce nuovi oggetti in tutta la catena `learningPlan → sections → activeSection → sectionContent`. Tutti i consumer si invalidano insieme anche se è cambiata solo una annotazione su una sezione.

---

## Cosa NON è stato risolto (lavoro futuro)

| Problema | Impatto | Difficoltà | Note |
|----------|---------|------------|------|
| Annotazioni mutano `content` | ~30-300ms per highlight | Alta | Refactor modello dati: overlay invece di `<mark>` inline |
| Sidebar da `learningPlan.sections` completo | ~5-15ms inutile | Media | Proiezione leggera `SidebarSectionMeta` |
| `persistQueue` non integrato | — | Bassa | Da collegare ai consumer |
| Test regressione optimistic update | — | Bassa | Mock backend lento → render prima di conferma |
| **Rendering per chunk** | ~0 (paradigma) | Media | Una volta separato overlay, spezzare markdown in chunk da rendere in parallelo/sotto-richiesta |

---

## Riepilogo

La FASE 1 ha risolto i problemi di **persistenza** e **re-render header/sidebar**. 

Il collo di bottiglia **residuo** è puramente architetturale: le annotazioni sono incorporate nel markdown come `<mark>` tag, forzando la ri-analisi dell'intero contenuto a ogni highlight. È il passo logico per la FASE 1bis o per il prossimo ciclo di sviluppo.
