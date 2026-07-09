# Architecture Review — WIP

> **File temporaneo di sessione.** Cattura lo stato di una review architetturale in corso. Non è documentazione ufficiale: serve a non perdere il filo se la sessione si interrompe. A fine review questo file va consolidato in `CONTEXT.md` + aggiornamento di `ARCHITECTURE.md` e poi eliminato.

**Ultima sessione:** 2026-05-16

---

## Setup della sessione (per chi riprende)

**Ruolo dell'utente:** Product manager / consulente architetturale. Non esperto di TypeScript/React. Ha visione del prodotto ma non ha mai letto questo codice. Vuole una **mappa della codebase** prima di muovere altre features. Cerca: scelte forti, pain point, fragilità, debito tecnico, priorità di pulizia. **Non vuole dettagli minuti.** Non vuole gergo web senza spiegazione.

**Ruolo dell'agente:** Si presenta come "il collega che ha lavorato al progetto". Spiega la codebase top-down, sottosistema per sottosistema. Verifica nel codice reale prima di parlare, perché la doc ufficiale è parzialmente obsoleta.

**Mentalità adottata** (ispirata alle skill `grill-with-docs` e `improve-codebase-architecture`, ma in chiave leggera):
- Vocabolario architetturale condiviso: **modulo / interfaccia / seam / adapter / deep / shallow / leverage / locality**. Da introdurre quando serve, spiegando.
- **CONTEXT.md** (glossario) → da creare a **fine tour**, non subito.
- **ADR** → solo se emerge una scelta veramente forte e non-ovvia.
- **Deletion test** quando si sospetta un modulo shallow: "se lo elimino, la complessità si sposta o sparisce?".

---

## Mappa dei sottosistemi (todo del tour)

- [x] **1. Workspace** — domain reducer, controller, reader state, reader actions
- [x] **1b.** Sub-indagine: dov'è finito lo stato del Laboratorio?
- [x] **2. AI / OpenRouter** — pipeline AI, prompt builder, retry, config
- [x] **3. Persistenza** — IndexedDB / SQLite / repository factory / autosave / persistence signature
- [x] **4. Reader runtime** — rendering lezione, annotazioni, TTS, speech blocks
- [x] **5. Library** — progetti, cartelle, drag & drop, assistant chat
- [x] **6. Backend** — chat proxy, PDF extraction, projects SQLite, auth
- [ ] **7. Sintesi** — creare `CONTEXT.md`, aggiornare `ARCHITECTURE.md`, definire priorità di pulizia ← **prossimo**
- [ ] **4. Reader runtime** — rendering lezione, annotazioni, TTS, speech blocks
- [ ] **5. Library** — progetti, cartelle, drag & drop, assistant chat
- [ ] **6. Backend** — chat proxy, PDF extraction, projects SQLite, auth
- [ ] **7. Sintesi** — creare `CONTEXT.md`, aggiornare `ARCHITECTURE.md`, definire priorità di pulizia

---

## Heads up generali (validi per tutto il tour)

- **`docs/ARCHITECTURE.md` è parzialmente bugiardo.** Cita sottosistemi che non esistono più (`services/laboratory/`) e tace su sottosistemi nuovi (`services/exercises/`, `services/learning/`, sub-system Research). Va riscritto a fine review.
- **`graphify-out/GRAPH_REPORT.md`** è basato sul commit `8c70415` (penultimo), quindi non vede l'ultimo commit `93858dd` ("Laboratorio intersparsed, migliorie UI, refactor"). Usabile come bussola ma verificare sempre nel codice.
- **527 community in 5395 nodi**: codice molto frammentato. Sospetto forte di "shallow modules" diffusi (interfacce quasi grosse come l'implementazione).
- **God nodes (top 10)**: `timestampIso`, `flattenLessons`, `LearningPlan` (67), `isRecord`, `ProjectSnapshot` (53), `SqliteProjectStore`, `PdfTextIndex`, `AppState`, `LessonNode`, `pushNousDebugTrace`. `LearningPlan` come tipo è uno snodo enorme — toccarlo costa caro.
- **`apps/web/types.ts` da 601 righe.** Tutto il dominio condiviso vive lì. Calamita di accoppiamento.

---

## Project card 1.0 (alto livello)

**Cosa fa il prodotto.** Carichi un PDF. L'AI lo trasforma in percorso di studio personalizzato: chat di onboarding → piano di studi → lezioni → quiz → esercizi applicativi corretti dall'AI. Quindi: lettore + tutor AI + valutatore.

**Due runtime.**
- **Frontend** (`apps/web/`, porta 5173, React+Vite): qui vive *quasi tutta* la logica, comprese le chiamate AI.
- **Backend** (`apps/backend/src/`, porta 3301, Express): 4 ruoli soli — proxy chat AI, estrazione testo/immagini PDF, archivio progetti SQLite (solo modalità LAN), TTS.

Scelta forte e peculiare: **il backend non è il padrone della logica**, è un servizietto. Il sapere del prodotto vive nel browser.

**4 schermate.** `App.tsx` (172 righe) è uno switch a 4 stati: `Library → Assessment → Planning → Reading`. Niente router con URL veri, è uno stato machine.

**3 luoghi di persistenza** (non 2):
- IndexedDB nel browser (default).
- SQLite nel backend (solo modalità LAN).
- localStorage nel browser (preferenze UI minute — da confermare).
La scelta tra IndexedDB e SQLite è runtime via `services/projects/projectRepositoryFactory.ts`. Le due implementazioni rispettano la stessa interfaccia `ProjectRepository` — è già un "ports & adapters" in piccolo.

**AI: tutto OpenRouter.** Client, prompt, retry, model selection, TTS, indexing — tutto in `services/openrouter/` (~30 file). È il punto più affollato della codebase.

---

## Tappa 1 — Workspace (completata)

### Architettura a 3 cerchi concentrici

```
[Reader Actions]   gesti → operazioni
  [Reader State] stato visivo (focus, dark, sidebar, audio…)
    [Controller]   operazioni utente + workflow async tracciati
      [Domain]     reducer puro su progetto attivo
```

- **Domain** (`apps/web/services/workspace/domain.ts`, 284 righe): reducer puro `(stato, azione) → nuovo stato`. Stato = 10 campi (`source`, `learningPlan`, `documentAssets`, `documentIndex`, `isLearnMode`, `userProfile`, `syllabus`, `researchCoursePlan`, `researchDossiersBySectionId`, `activeSectionId`). ~20 action types.
- **Controller** (`apps/web/hooks/workspace/controller/`, 8 file): operazioni utente (crea, importa, completa sezione, genera lezione, valuta esercizio). Contiene un sotto-sistema **WorkflowState** con `requestId` per evitare race su operazioni async.
- **Reader State** (`useWorkspaceReaderState.ts`): SOLO stato visivo. Niente dati del progetto. Separazione netta.
- **Reader Actions** (`useWorkspaceReaderActions.ts`): traduzione gesto → operazione coordinata. Non decide se l'operazione è lecita (è compito del controller).

### Struttura del LearningPlan (importante per il glossario)

```
LearningPlan
 └─ modules: LearningModule[]    ← capitoli alti
     └─ children: PathNode[]      ← mix di lezioni + esercizi
         ├─ LessonNode (kind='lesson')   → può avere parentId → sub-chapter
         └─ ApplicationExerciseNode (kind='exercise')  ← intercalato
```

**Terminology drift confermato:** `section` / `lesson` / `module` / `sub-chapter` / `path-node` / `exercise` si sovrappongono. Esempio: `activeSectionId` + `selectActiveSection()` lavora solo su `LessonNode` — quindi qui "section" = "lesson". Ma `SectionAnnotation`, "sub-chapter is a section" lo usano diversamente.

### Verdetto Workspace

| Cosa | Stato |
|---|---|
| Reducer puro del dominio | 👍 Forte |
| Separazione domain/controller/runtime/actions | 👍 Forte |
| Workflow async tracciati con `requestId` | 👍 Forte |
| Terminology drift section/lesson/module | ⚠️ Da chiarire (CONTEXT.md) |
| `LearningPlan` god node (67 connessioni) | ⚠️ Cambiarlo costa caro |
| Logica esercizi sparsa in 5 cartelle | ⚠️ Consolidabile |
| ARCHITECTURE.md obsoleto | 🔴 Da correggere |

### Dubbi aperti sul Workspace

- L'`insert-section-after` action ha logica subdola (separa lessons e exercises e riordina solo le lessons). Bandiera rossa di un modello dati che fatica a esprimere "intercalare esercizi". Vale la pena ridiscuterlo.
- Lo stato del controller (`state.ts`) duplica ogni campo in `Ref` per evitare stale-closure. Pattern React standard ma costoso quando moltiplichi per N campi. Più cresce, più diventa difficile sapere chi può cambiare cosa.

---

## Sub-indagine — Il Laboratorio: dov'è finito?

**Risultato: il Laboratorio come sotto-sistema non esiste più.** È stato disintegrato. Il commit `8c70415` ha mergeato `application-exercises-refactor` e il successivo `93858dd` è "Laboratorio intersparsed".

**Prima:** `LaboratoryState` + `LaboratoryExercise` + `activeLaboratoryExerciseId` come blob globale parallelo al piano.

**Ora:** gli esercizi sono nodi del piano (`PathNode` con `kind: 'exercise'`), fratelli delle lezioni dentro i moduli.

**Prove nel codice:**
- `LaboratoryState` non compare più in produzione (solo test e snapshotHydration).
- `apps/web/services/workspace/controller/snapshotHydration.ts:184-198` ha codice che butta via i campi legacy `laboratory` e `activeLaboratoryExerciseId` quando carica vecchi snapshot, loggando il drop.
- `apps/web/services/learning/temporaryLabLessons.ts` rimuove una forma intermedia ("mini-lab lessons") — sintomo di almeno una migrazione intermedia.
- Nuova logica esercizi vive in:
  - `services/learning/applicationExercises.ts` (200 righe) — funzioni pure su `LearningPlan`.
  - `services/exercises/deliverables.ts` (271 righe) — gestione consegne utente.
  - `services/exercises/constants.ts` (40 righe).
  - + `services/openrouter/exerciseBrief.ts`, `exercisePlacement.ts`, `lessonVerification.ts`.

**Implicazioni:**
- ✅ Architetturalmente buono: assorbire il blob parallelo nel piano è un **deepening** corretto.
- ⚠️ Logica esercizi sparsa in **5 luoghi** — consolidare in un sotto-sistema unico è candidato di pulizia.
- ⚠️ `temporaryLabLessons.ts` + rami legacy in `snapshotHydration.ts` sono **codice morto in attesa**: rimuovibili quando si fissa una versione minima di snapshot.
- 🔴 ARCHITECTURE.md va aggiornato in modo coerente con questo refactor.

---

## Tappa 2 — AI / OpenRouter (completata)

### Inquadramento

Una sola cartella ([apps/web/services/openrouter/](apps/web/services/openrouter/)) con 27 file + 3 sotto-cartelle, ~6.700 righe al solo livello principale. È la zona più affollata del frontend.

Contiene due famiglie:
- **Client AI**: `client.ts` (354), `config.ts`, `retry.ts`, `shared.ts`, `types.ts`, `json.ts`, `prompts.ts`, `payloadLimits.ts`.
- **Pipeline AI** (almeno 10 distinte): assessment, curriculum, research, planning, document index, lesson markdown quality, exercise placement & brief, lesson verification, lesson images, visual examples, pdf assets, context chat, TTS.

### Architettura del client AI

- **Tutte le chiamate vanno al backend proxy** `/api/openrouter/chat/completions`. Il browser non vede mai la API key — buona scelta di sicurezza.
- **Funzione unica** `callOpenRouter` con due bocche interne:
  - **Streaming SSE** quando si passa `onReasoningUpdate` → accumula `content` + `reasoning` (chain-of-thought live).
  - **Non-streaming** altrimenti → fetch + ritorno secco.
- **Selezione modello** via `resolveOpenRouterModel(fallback, slot, allowUiOverride)`:
  - 8 costanti modello override-abili via env var.
  - 4 slot UI (`lesson`, `assessment`, `context`, `tts`) override-abili dall'utente via preferenze.
- **Retry** ([retry.ts](apps/web/services/openrouter/retry.ts)): backoff esponenziale 1s→2s→4s, max 3. Retriabile su 5xx/408/429, network errors, e tre tipi di "modello mi ha dato spazzatura" (`empty_stream`, `empty_lesson_content`, `invalid_json_response`).
- **Payload limits** ([payloadLimits.ts](apps/web/services/openrouter/payloadLimits.ts)): pre-check del JSON body prima del fetch per evitare 413.

### Le 8 costanti modello (snapshot attuale)

| Costante | Default | Override utente UI? |
|---|---|---|
| `MODEL_FLASH` | `openai/gpt-5.4-nano` | no |
| `MODEL_REASONING` | `openai/gpt-5.4-mini` | no |
| `MODEL_CONTEXT` | `google/gemini-3.1-flash-lite` | sì (slot `context`) |
| `MODEL_ASSESSMENT` | = MODEL_CONTEXT | sì (slot `assessment`) |
| `MODEL_RESEARCH_PLANNER` | `perplexity/sonar-pro-search` | no |
| `MODEL_RESEARCH_DOSSIER` | = MODEL_RESEARCH_PLANNER | no |
| `MODEL_PDF_IMAGE_CAPTION` | `nvidia/nemotron-nano-12b-v2-vl` | no |
| `MODEL_VISUAL_PLANNER` | = MODEL_FLASH | no |
| `MODEL_VISUAL_RENDERER` | = MODEL_REASONING | no |

### Sequenza pipeline per un nuovo progetto

```
1. Carichi PDF
2. PDF Assets        →  estrai testo+immagini (backend, non AI)
3. Document Index    →  mappa chunk → pagine/sezioni
4. Assessment        →  chat onboarding (6 varianti ±learn ±text ±embedded)
5. Planning          →  genera piano (moduli + lezioni)
                       ALT: Research (Perplexity) → buildLearningPlan
6. Exercise Placement→  decide dove intercalare esercizi
7. Per ogni lezione:
   a. Section Content     → markdown lezione
   b. Lesson Images       → seleziona immagini PDF
   c. Lesson Verification → controlla la lezione
   d. Lesson MD Quality   → ripari/sanifica/genera quiz
   e. Visual Examples     → esempi visuali (opzionali)
8. Per ogni esercizio: Exercise Brief
9. Context Chat       →  Q&A in lettura
10. TTS               →  speech reader
11. STT               →  speech input nei composer
```

Un libro intero → facilmente 30-50 chiamate AI sequenziali.

### Pain point

| # | Problema | Severità |
|---|---|---|
| 1 | File mostro: `research.ts` 692, `lessonMarkdownQuality.ts` 651, `pdfAssets.ts` 527, `lessonImages.ts` 503, `planQuality.ts` 486, `visualExamples.ts` 480, `assessment.ts` 461 | ⚠️ |
| 2 | ~~Duplicazione `lessonMarkdownQuality.ts` (651) + cartella omonima~~ | ✅ **Risolto durante questa sessione**: il file era codice morto al 100% (zero importer, cartella superset). Cancellato, `bun run quality` verde. |
| 3 | 6 varianti di `createAssessmentChat` (esplosione combinatoria 2×2×2) | ⚠️ Parametrizzabile |
| 4 | `shared.ts` come facciata su `config.ts` → re-export confusi | ⚠️ Minore |
| 5 | Retry è **opt-in**: chi chiama deve ricordarsi di wrappare. 83 occorrenze in 18 file → probabili dimenticanze | ⚠️ |
| 6 | No batching / no caching → ogni rigenerazione ripaga | ℹ️ Gap funzionale futuro |
| 7 | Messaggi errore italiani hardcoded in `client.ts` | ℹ️ i18n future |

### Sub-cartelle interne

- [`documentIndex/`](apps/web/services/openrouter/documentIndex/) (7 file): chunking, coverage, layout, mapping, context, constants. Pipeline indicizzazione PDF.
- [`lessonMarkdownQuality/`](apps/web/services/openrouter/lessonMarkdownQuality/) (6 file): constants, quality, quiz, repair, standaloneQuiz. **Apparentemente duplica il file omonimo accanto** — sospetto refactor non finito.
- [`planning/`](apps/web/services/openrouter/planning/) (5 file): content, metadata, planner, types. Generazione del piano.

### Verdetto

| Cosa | Stato |
|---|---|
| Proxy backend (API key nascosta) | 👍 |
| Client unico streaming/non-streaming | 👍 |
| Model slot configurabili via UI | 👍 |
| Retry centralizzato con regole esplicite | 👍 ma opt-in |
| File mostro >450 righe (7 file) | ⚠️ |
| Duplicazione lessonMarkdownQuality | 🔴 |
| Esplosione `createAssessmentChat` (6 varianti) | ⚠️ |
| No batching/caching | ℹ️ |

### Dubbi aperti

- `lessonMarkdownQuality.ts` (file 651) **vs** `lessonMarkdownQuality/` (cartella 6 file): refactor parziale o coesistenza voluta? Da chiarire.
- Quale logica vive in `research.ts` da 692 righe? È davvero atomico o è 3 sotto-pipeline?
- Il `payloadLimits.ts` pre-check fa solo controllo dimensione bytes, ma non c'è un meccanismo che **divida** il payload se è troppo grande. Quando un PDF è enorme cosa succede in produzione?

---

## Tappa 3 — Persistenza (completata)

### Tre forme di persistenza

1. **IndexedDB** (browser, default) → `IndexedDbProjectRepository` (847 righe).
2. **SQLite via backend** (modalità LAN) → `HttpProjectRepository` (281) frontend ↔ `SqliteProjectStore` (988) backend.
3. **localStorage** (browser) → preferenze UI, scelta modello, repository mode, folder expansion.

### Architettura — Ports & Adapters

[`apps/web/services/projects/projectRepository.ts`](apps/web/services/projects/projectRepository.ts) definisce l'interfaccia `ProjectRepository` con **16 metodi**:
- 9 sul project storage: `saveProject`, `loadProject`, `patchProject`, `deleteProject`, `importProject`, `exportProject`, `touchProject`, `listProjects`, `loadProjectsById`.
- 7 sul library tree: `createFolder`, `deleteFolder`, `listFolders`, `listPlacements`, `moveFolder`, `moveProjects`, `renameFolder`.

[`projectRepositoryFactory.ts`](apps/web/services/projects/projectRepositoryFactory.ts) sceglie l'adapter runtime: priorità `localStorage` > Vite env > process env. Due valori: `'indexeddb'` | `'lan'`.

Backend: [`projectStore.ts`](apps/backend/src/projects/projectStore.ts) factory singleton, solo driver `sqlite` supportato (env `PROJECT_STORAGE_DRIVER`).

### Pezzo notevole — signature-based autosave

[`persistenceSignature.ts`](apps/web/services/projects/persistenceSignature.ts) ha due signature:

- `buildPersistenceSignature(snap)` — stringify completo, **incluso `source`**. Per content-equality (es. LAN transfer verification).
- `buildAutosaveSignature(snap)` — **skip `source`** usando un **reference identity token** in `WeakMap`. Più una `objectSignatureCache: WeakMap<object, string>` per memoizzare stringify.

Motivazione documentata nel codice: la versione semplice costava "centinaia di ms per render" perché ogni object spread rompeva la cache. Bell'esempio di scelta forte + commento autoesplicativo.

### Pezzo notevole — persist queue per modifiche granulari

[`persistQueue.ts`](apps/web/services/projects/persistQueue.ts), singleton modulare:
- FIFO con **dedup per key** (modifiche rapide allo stesso highlight si coalescono).
- Backoff esponenziale 500ms→1s→2s, max 3 retry.
- Cap 200 in coda con drop dei più vecchi.
- `flush()` con timeout 5s per drain on unmount.

API: `enqueuePatch`, `flush`, `pendingCount`, `clear`, `getQueueState`.

Solo per le PATCH granulari della modalità LAN — non per il save completo dello snapshot.

### Pezzo notevole — sync state observable

[`syncState.ts`](apps/web/services/projects/syncState.ts), singleton modulare:
- Stati: `'saved' | 'saving' | 'error'`.
- **Auto-clear safety net** dopo 2s → torna a 'saved' anche se nessuno chiama `markSyncSaved`. Difesa contro race / hang / callback persi.
- API: `markSyncSaving`, `markSyncError`, `markSyncSaved`, `onSyncStateChange`, `getSyncState`.

### Pain point

| # | Problema | Severità |
|---|---|---|
| 1 | `indexedDbProjectRepository.ts` 847 righe | ⚠️ |
| 2 | `sqliteProjectStore.ts` 988 righe | ⚠️ |
| 3 | `projectSnapshot.ts` 504 righe | ⚠️ |
| 4 | Interfaccia mescola progetti + library tree (16 metodi) | ⚠️ Minore |
| 5 | `projectSyncState.ts` da 1 riga (`PROJECT_SYNC_READY = 'sync-ready'`) — file dedicato per una costante | ℹ️ Code smell |
| 6 | Singleton globali (`persistQueue`, `syncState`) | ⚠️ Test-friction |
| 7 | `persistQueue` legge `globalThis.__NOUS_SERVER_CONFIG__` per evitare circular dep | ⚠️ Sintomo |
| 8 | No `schemaVersion` esplicito negli snapshot → migration on-the-fly | ⚠️ Rischio futuro |
| 9 | Drift `ProjectRepository` (FE) vs `ProjectStore` (BE) **confermato**: vedi sub-indagine | 🔴 |

### Verdetto

| Cosa | Stato |
|---|---|
| Ports & adapters | 👍 |
| Signature-based autosave + reference identity hack | 👍 |
| Persist queue con dedup | 👍 |
| Sync state con safety net | 👍 |
| File mostro (847/988/504) | ⚠️ |
| Mescolamento responsabilità interfaccia | ⚠️ |
| No schema version | ⚠️ |
| Singleton globali | ⚠️ |
| Magic globalThis | ⚠️ |

### Dubbi aperti

- Le 988 righe di `sqliteProjectStore.ts` cosa contengono davvero? Schema migrations? Query complesse? Da capire se è coeso o spaccabile.
- Il `prepareSnapshotForHydration` fa migration tante volte: legacy plan shape, mini-lab lessons, laboratory legacy, image placeholders, section annotations, learn mode flatten. È un sistema di "migration on read" senza versioning esplicito. Quanto è robusto?
- `LOCAL_AUTH_BYPASS=true` in modalità LAN: come si comporta il backend con utenti reali? (Vedere tappa Backend.)

### Sub-indagine — allineamento FE↔BE (eseguita in sessione)

**Drift confermato e significativo.**

| Aspetto | FE (`ProjectRepository`) | BE (`ProjectStore`) |
|---|---|---|
| Metodi | 16 | 17 (in più `getConfig()`) |
| Primo arg | nessun userId | `userId: string` su ogni metodo |
| `patchProject` `patch` | `Record<string, unknown>` (untyped!) | `ProjectPatch` tipato (15 campi + `SectionPatch`) |
| `ProjectSnapshot` | definito in `apps/web/types.ts` | **ridefinito** in `apps/backend/src/projects/types.ts` |

**Tre problemi concreti:**

1. **`patchProject` è autostrada untyped**: il FE manda `Record<string, unknown>`, il BE accetta `ProjectPatch`. Nessuna verifica TypeScript fra i due. Aggiungi un campo in `ProjectPatch` → il FE non se ne accorge. Manca un contratto compile-time.

2. **`ProjectSnapshot` BE è in ritardo sul refactor Application Exercises**:
   - Mantiene ancora `laboratory?: {...}` e `activeLaboratoryExerciseId?` (campi legacy ormai rimossi dal FE).
   - Usa `[key: string]: unknown` ovunque nei sotto-tipi del piano → "accetto qualsiasi cosa".

3. **`ApiResponse` "tutto-opzionale"** in `HttpProjectRepository`: una sola interface gigante con `data?`, `folder?`, `folders?`, `meta?`, `placements?`, `project?`, `projects?`, `snapshot?`. Più sano avrebbe response-shape per endpoint.

**Cose buone trovate:**

- Il **"lightweight snapshot" hack** in `saveProject` ([httpProjectRepository.ts:165-191](apps/web/services/projects/httpProjectRepository.ts#L165-L191)): rimuove `source` (PDF base64) dal payload autosave e il backend lo preserva via `omitSource=true`. Commento narrativo: "would otherwise resend ~100 MB on every debounced save, OOM-crashing the browser tab". Bel hack documentato.
- **`PROJECT_SYNC_READY`** dal file da 1 riga **non è morto**: viene usato per marcare meta in `listProjects`/`saveProject`/`patchProject`/`importProject`. Resta strano essere in file dedicato → spostarlo accanto a `ProjectStorageError`.
- Errori italiani **senza accenti** ("non e stata creata"). Sintomo di encoding-paura.

**Fix proposti (da entrare in priorità di pulizia):**

| # | Cosa | Severità |
|---|---|---|
| 1 | Condividere `ProjectPatch` come tipo comune (cartella `packages/shared-types/` o re-export cross-app) | 🔴 |
| 2 | Unificare `ProjectSnapshot` BE/FE (= ricavarlo dal FE e rimuovere campi laboratory legacy dal BE) | 🔴 |
| 3 | Spaccare `ApiResponse` in response per endpoint | ⚠️ |
| 4 | Spostare `PROJECT_SYNC_READY` in `projectRepository.ts` | ℹ️ |
| 5 | Verificare encoding errori italiani | ℹ️ |

---

## Tappa 4 — Reader (completata)

### Composizione

Il Reader è la schermata di lettura della lezione (1 delle 4 di App.tsx). È composto da ~10 sotto-feature interconnesse:

```
ReadingScreenContainer
└─ WorkspaceReaderShell  (composition root)
   ├─ Header
   ├─ Sidebar (navigazione lezioni)
   ├─ Content (rendering markdown)
   │   └─ Context Menu (selezione testo + annotazioni)
   │       └─ Ask-AI Panel (chat Vercel AI SDK)
   └─ TTS Audio Panel
       └─ Audio chunks + crossfade engine
```

[`useWorkspaceReaderState`](apps/web/hooks/workspace/useWorkspaceReaderState.ts) compone 4 sub-hook (`useReaderChrome`, `useReaderContext`, `useReaderSpeechBlocks`, `useTtsPlayer`) e tiene lo stato visivo.

### File mostro (in ordine)

| File | Righe | Cosa fa |
|---|---|---|
| `ContextAnswerPanel.tsx` | 1334 | Chat "Chiedi all'AI" durante la lettura |
| `useTtsPlayer.ts` | 1295 | Player audio (chunking, crossfade, queue, seek) |
| `ContextMenu.tsx` | 1010 | Menu contestuale sul testo selezionato |
| `WorkspaceReaderContent.tsx` | 929 | Rendering markdown lezione |
| `UnifiedAudioPanel.tsx` | 717 | UI controlli audio |
| `useReaderContext.ts` | 714 | Logica context menu + annotazioni |
| `WorkspaceReaderSidebar.tsx` | 478 | Navigazione |
| `WorkspaceReaderHeader.tsx` | 374 | Header reader |

8 file > 370 righe. 3 file > 1000 righe. Cartella più pesante della codebase per riga-per-file.

**Nota onesta**: i singoli file sono coesi — ognuno fa una macro-feature ben delimitata. Spaccarli aggiungerebbe salti tra file senza diminuire il totale. Ma sopra le 1000 righe la lettura è dura — vanno guardati uno per uno per capire se è davvero "una sola cosa".

### Scoperta n°1 — Due client AI in parallelo (🔴 DRIFT)

`ContextAnswerPanel.tsx` importa **Vercel AI SDK**:
```ts
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, isToolUIPart, ... } from 'ai';
```

Tutta la chat contestuale del Reader usa questo SDK, NON `services/openrouter/`. Il backend deve esporre un endpoint compatibile con Vercel AI SDK (probabilmente `/api/chat/context`).

**Conseguenza**: il frontend ha **due infrastrutture AI** da mantenere:
- `services/openrouter/` per le pipeline (assessment, planning, lesson generation, ecc.)
- Vercel AI SDK per la chat contestuale (tool calls, history, streaming chat)

Probabilmente Vercel AI SDK è stato adottato perché ha built-in la gestione di tool calls e chat history. Ma è un drift architetturale serio.

### Scoperta n°2 — Doppio brand Nous/Lumina

- `useReaderContext.ts`: `'mark[data-nous-annotation-id], mark[data-lumina-annotation-id]'` ← cerca apposta entrambe le forme
- `httpProjectRepository.ts`: `console.warn('[Lumina] LAN project sync failed', ...)`
- README, ARCHITECTURE.md: "**Nous Reader**"
- Cartella repo: `Lumina-Reader`
- Tracing globale: `pushNousDebugTrace`

Rebrand a metà. Non rompe niente (la doppia ricerca DOM è retrocompatibile di proposito), ma è confusionario.

### Pain point

| # | Problema | Severità |
|---|---|---|
| 1 | Tre file > 1000 righe (ContextAnswerPanel 1334, useTtsPlayer 1295, ContextMenu 1010) | ⚠️ Coesi ma pesanti |
| 2 | Due client AI in parallelo (openrouter + Vercel AI SDK) | 🔴 Drift architetturale |
| 3 | Brand mix Nous/Lumina | ⚠️ Pulizia |
| 4 | `useReaderContext` fa tre cose (selezione + menu + annotazioni) | ⚠️ Forse spaccabile |
| 5 | `UnifiedAudioPanel` — il nome suggerisce un'unificazione, può nascondere debito | 🟡 Da capire |

### Verdetto

| Cosa | Stato |
|---|---|
| Composizione hierarchica chiara | 👍 |
| Sotto-feature ben separate | 👍 |
| TTS engine coerente (chunking + crossfade) | 👍 |
| File monolitici >1000 | ⚠️ |
| Drift AI: Vercel SDK + openrouter | 🔴 |
| Brand Nous/Lumina misto | ⚠️ |

### Dubbi aperti

- `useTtsPlayer` 1295 righe: davvero un modulo deep o tre cose mascherate? Da decidere se spaccare.
- `ContextAnswerPanel` 1334 righe: oltre alla chat, gestisce tool calls (web search, sticky note, conversation note). Quanto è complicata la separazione tool/UI?
- Endpoint backend per Vercel AI SDK: come è strutturato? Da chiarire nella tappa Backend.

---

## Tappa 5 — Library (completata)

### Composizione

5 componenti + 3 hook + 1 service:

| File | Righe |
|---|---|
| `HomeChatPanel.tsx` | **1469** ← file più grosso della codebase FE |
| `LibraryTreeView.tsx` | **1244** |
| `useProjectLibrary.ts` | **733** |
| `services/library/toolExecutor.ts` | **521** |
| `useLibraryAssistantChat.ts` | **466** |
| `LibraryView.tsx` | 340 |
| `ProjectCard.tsx` | 269 |
| `LibraryScreenContainer.tsx` | 188 |
| `usePersistedLibraryFolderExpansion.ts` | 117 |

### Scelta forte — AI agente con tool calls

La chat della home **non è una chat semplice**: è un agente. Può chiamare tool concreti come `listLibraryTree`, `getProjectOverviews` ecc. Quando l'utente chiede "qual è il progetto in cui ho parlato di X?", l'AI invoca tool, riceve dati, risponde.

### Rivelazione sistematica sui due client AI

Aggiornamento rispetto alla tappa 4: il "drift" Vercel AI SDK vs `services/openrouter/` **NON è un caso isolato**, è una **scelta architetturale sistematica**:

```
Vercel AI SDK       ←→  CHAT (interattiva, tool calls, history)
                        ├─ Reader Ask AI
                        └─ Library Home Chat

services/openrouter ←→  PIPELINE (one-shot, generazione, valutazione)
                        ├─ Assessment, Planning, Research, Curriculum
                        ├─ Lesson generation, Exercise brief, Verification
                        ├─ TTS, Document indexing
```

**Non è bug, è scelta**. Vercel AI SDK ha built-in gestione tool calls + history + streaming chat UI, sarebbe pesante rifarlo a mano. **Però non è documentato**: candidato perfetto per un ADR.

### Drag & drop a mano

`LibraryTreeView.tsx` (1244) è quasi tutto **drag & drop, reordering, animation, mobile timing**. Niente `@dnd-kit` o simili; tutto a mano con `pointerdown`/`pointermove`/`pointerup`. `framer-motion` per le animazioni. È difficile da testare.

### `useProjectLibrary` come orchestratore

Gestisce: `LibraryTree`, `LibraryFolder`, `LibraryScopeSummary`, autosave+sync state, repository mode switching, import/export. Alimenta sia la UI che la chat.

### Pain point

| # | Problema | Severità |
|---|---|---|
| 1 | `HomeChatPanel.tsx` 1469 | ⚠️ |
| 2 | `LibraryTreeView.tsx` 1244 — drag manuale | ⚠️ |
| 3 | `useProjectLibrary.ts` 733 | ⚠️ |
| 4 | Doppio client AI sistematico ma **non documentato** | 🟡 Manca ADR |
| 5 | Drag & drop timing-dipendente, difficile da testare | 🟡 |

### Verdetto

| Cosa | Stato |
|---|---|
| AI-agente con tool calls | 👍 |
| `useProjectLibrary` come orchestratore unico | 👍 |
| Separazione tool/UI (services/library/toolExecutor) | 👍 |
| File mostro | ⚠️ |
| Drag manuale | 🟡 |
| Choice non-documentata dei due client AI | 🟡 |

---

## Tappa 6 — Backend (completata)

### Dimensione

**38 file, 5.427 righe**. Magro per design: il backend è un "servizietto", non il cervello.

### Struttura

```
apps/backend/src/
├─ index.ts (167)             ← createApp Express
├─ server.ts                  ← startup
├─ config/                    ← env, serverConfig
├─ auth/currentUser.ts (39)   ← auth leggera (LOCAL_AUTH_BYPASS friendly)
├─ routes/
│   ├─ chat.ts                ← top-level router /api/chat
│   ├─ contextChat.ts (443)        ← Reader Ask-AI (Vercel AI SDK compat)
│   ├─ libraryChat.ts (536)        ← Library Home-Chat (Vercel AI SDK compat)
│   ├─ chatPrompts.ts (536)        ← prompt building condiviso
│   ├─ openRouterProxy.ts (65)     ← proxy raw verso OpenRouter
│   ├─ pdf.ts (84)                 ← extraction routes
│   ├─ projects.ts (397)           ← CRUD progetti
│   ├─ tts.ts (84) + voices.ts (52) + status.ts (25)
├─ services/
│   ├─ pdfImageExtractor.ts (726)  ← PDF → immagini
│   ├─ pdfTextExtractor.ts (169)   ← PDF → testo (delega a pdftotext)
│   ├─ ttsClient.ts (299)
│   └─ voiceService.ts (54), statusService.ts (21)
├─ projects/
│   ├─ sqliteProjectStore.ts (988) ← pezzo più grosso del backend
│   ├─ projectMeta.ts (210), siblingOrdering.ts (157), types.ts (152)
│   ├─ folderNames.ts (33), projectStore.ts (21)
└─ utils/, types/
```

### I 5 ruoli del backend

1. **Proxy AI** — `openRouterProxy.ts` + chat routes. Aggiunge API key OpenRouter (env), inoltra. Le chat routes (`contextChat`, `libraryChat`) implementano il protocollo Vercel AI SDK (stream + tool calls).
2. **Estrazione PDF** — `pdf.ts` + `pdfTextExtractor` (delega a `pdftotext`) + `pdfImageExtractor` (probabilmente `pdfjs-dist`).
3. **Archivio progetti SQLite** — attivo solo in modalità LAN, usa `better-sqlite3`.
4. **TTS** — chiama OpenRouter `audio/speech`, espone elenchi voci/modelli.
5. **STT** — valida audio browser e chiama OpenRouter `audio/transcriptions` con un modello server-owned.

### Scelte forti

- **Body limits per endpoint** (in `index.ts`): default 50mb, openrouter 80mb, pdf 160mb, **projects 300mb**. Sintomo di payload pesanti, ma dichiarati.
- **CORS con private network override** per LAN: se `CORS_ALLOW_PRIVATE_NETWORK=true`, accetta origin con IP privato (10.x, 172.16-31.x, 192.168.x) su porta 5173.
- **Logger semplice ma utile** con quiet su GET di successo per `/api/status` e `/api/voices`.
- **Error handler globale** con caso speciale 413 (payload too large).

### Debito noto (esplicito nel README)

- `LOCAL_AUTH_BYPASS=true` per uso personale. README dice già: "do not enable it in a deployment without a real authentication layer".

### Pain point

| # | Problema | Severità |
|---|---|---|
| 1 | `sqliteProjectStore.ts` 988 | ⚠️ |
| 2 | `pdfImageExtractor.ts` 726 | ⚠️ |
| 3 | Auth fittizia | ⚠️ Debito noto |
| 4 | Body limit 300mb su `/api/projects` | ⚠️ Sintomo |
| 5 | Chat backend (`contextChat` 443 + `libraryChat` 536 + `chatPrompts` 536) — 3 file pesanti che probabilmente duplicano logica | ⚠️ Verificare |
| 6 | Errori italiani senza accenti | ℹ️ |

### Verdetto

| Cosa | Stato |
|---|---|
| Backend leggero per design | 👍 |
| Body limits per endpoint | 👍 |
| CORS con private network override | 👍 |
| 4 ruoli ben separati | 👍 |
| sqliteProjectStore mostro | ⚠️ |
| Auth bypass | ⚠️ Esplicito |
| Possibile duplicazione chat routes | ⚠️ |

---

## Glossario in costruzione (bozza, da rifinire a fine tour)

| Termine | Significato attuale | Note |
|---|---|---|
| **Progetto / ProjectSnapshot** | Tutto ciò che serve a riprodurre lo stato di studio di un PDF | Persistito su IndexedDB o SQLite |
| **LearningPlan** | Piano di studi generato dall'AI per un progetto | God node (67) — toccarlo costa |
| **Module / LearningModule** | Capitolo alto del piano | Contiene `children: PathNode[]` (lessons + exercises) |
| **Lesson / LessonNode** | Pagina di lezione | Può avere `parentId` → sub-chapter |
| **PathNode** | Nodo del piano | `kind: 'lesson' \| 'exercise'` |
| **Section** | ⚠️ AMBIGUO. A volte = lesson, a volte voce generica | DA DISAMBIGUARE |
| **ApplicationExercise** | Esercizio applicativo intercalato tra lezioni | Sostituisce vecchio "Laboratory" |
| **Laboratory** | ⚠️ TERMINE LEGACY. Non più nel codice attivo | Solo migrazioni snapshot vecchi |
| **Workflow** | Operazione async tracciata (pending/failed/succeeded) | Usa `requestId` per evitare race |
| **Research dossier** | Materiale raccolto dall'AI in fase di ricerca, per sezione | Non documentato altrove |
| **Learn mode** | Modalità che gira senza un PDF sorgente | Da capire meglio (assessment ha 3 varianti learn-mode) |
| **OpenRouter** | Aggregatore di modelli AI usato come unico provider | Tutte le chiamate AI passano dal backend proxy |
| **Model slot** | Chiamata logica AI con preferenza modello configurabile dall'utente | 4 slot: `lesson`, `assessment`, `context`, `tts` |
| **Reasoning** | Catena di pensiero del modello, esposta live via SSE | Solo se chiami `callOpenRouter` con `onReasoningUpdate` |
| **Pipeline AI** | Sequenza coerente di chiamate AI per uno scopo | ~10 pipeline distinte in `services/openrouter/` |
| **Research mode** | Pipeline alternativa via Perplexity per ricerca esterna | In contrasto con planning standard "PDF-only" |
| **Document index** | Mapping fra chunk PDF e nodi del piano | `services/openrouter/documentIndex/` |
| **SSE** | Server-Sent Events: stream HTTP di eventi | Usato per il reasoning live |
| **ProjectRepository** | Interfaccia frontend per CRUD progetti + library tree (16 metodi) | Due adapter (IndexedDB/HTTP) |
| **ProjectStore** | Interfaccia backend equivalente | Una sola impl (SQLite) |
| **Persistence signature** | Stringa-riassunto dello stato. Due varianti: full e autosave (skip PDF) | Driver della logica "salvare o no" |
| **Reference identity token** | Numero attribuito a oggetto immutabile per evitare serializzarlo | Usato per `source` (PDF) nell'autosave |
| **Persist queue** | Coda FIFO per PATCH granulari con dedup per key | Modalità LAN, per highlight/note |
| **Sync state** | Indicatore UI 'saved/saving/error' con auto-clear 2s | Singleton globale observable |
| **LAN mode** | Modalità in cui i progetti vivono in SQLite backend | Switch via localStorage `projectRepositoryMode` |
| **Snapshot hydration** | Caricamento progetto: migration legacy + normalizzazione | `prepareSnapshotForHydration` in `services/workspace/controller/` |
| **Reader / Reading screen** | Schermata di lettura della lezione | 1 delle 4 in App.tsx |
| **Reader State** | Hook che compone tutto lo stato visivo del Reader | `useWorkspaceReaderState` |
| **Speech block** | Pezzo di testo della lezione adatto a essere letto dal TTS | Segmentazione semantica |
| **Speech chunk** | Pezzo audio (~580 caratteri) generato dal TTS | Crossfade 35ms tra chunk |
| **Context menu** | Menu sul testo selezionato (highlight, ask, note) | `useReaderContext` + `ContextMenu.tsx` |
| **Ask AI / Context Answer** | Chat contestuale durante la lettura, usa Vercel AI SDK | NB: diverso da `services/openrouter` |
| **Annotation** | Highlight o sticky note su una sezione, persistita nel piano | DOM attributes `data-nous-` e `data-lumina-` (legacy) |
| **Library** | Schermata home con progetti, cartelle, assistant chat | 1 delle 4 di App.tsx |
| **Library tree** | Albero cartelle + placement progetti | Gestito dal repository |
| **Placement** | "Progetto X sta nella cartella Y con order Z" | Riordinabile via drag |
| **Library assistant** | Chat-agente che esplora e agisce sulla libreria | Vercel AI SDK + tool calls |
| **Tool call** | Funzione che l'AI può invocare per leggere/scrivere dati | Pattern unico per le chat (Reader+Library) |
| **Library tool** | Tool specifico esposto al library assistant | `listLibraryTree`, `getProjectOverviews`, ... |

---

## Pain point emersi finora (cumulativi)

1. **Frammentazione**: 527 community su 5395 nodi → tanti moduli probabilmente shallow.
2. **`types.ts` da 601 righe alla radice** del frontend → calamita di accoppiamento.
3. **Terminology drift** section/lesson/module/sub-chapter/path-node.
4. **`LearningPlan` god node** (67 connessioni).
5. **Logica esercizi sparsa in 5 cartelle** post-refactor.
6. **ARCHITECTURE.md obsoleto** rispetto al codice.
7. **Codice morto in attesa** (legacy migration paths) rimuovibile quando si fissa snapshot versioning.
8. **File mostro in `services/openrouter/`** (7 file >450 righe).
9. ~~Duplicazione `lessonMarkdownQuality.ts` + cartella omonima~~ → **risolto in sessione (cancellate 651 righe morte)**.
10. **6 varianti di `createAssessmentChat`** (esplosione combinatoria).
11. **Retry opt-in** in 83 call site → probabili dimenticanze sparse.
12. **Nessun caching delle pipeline AI** → costo proibitivo a regime.
13. **File mostro persistenza**: `sqliteProjectStore.ts` 988, `indexedDbProjectRepository.ts` 847, `projectSnapshot.ts` 504.
14. **No schemaVersion negli snapshot** → migration on-the-fly senza checkpoint esplicito.
15. **Singleton globali in persistenza** (persistQueue, syncState) → testabilità intaccata.
16. **Magic `globalThis.__NOUS_SERVER_CONFIG__`** in `persistQueue` → sintomo di circular dep nella config.
17. **File mostro Reader**: 8 file >370 righe, 3 >1000 (ContextAnswerPanel 1334, useTtsPlayer 1295, ContextMenu 1010).
18. **Due client AI in parallelo** (services/openrouter + Vercel AI SDK in ContextAnswerPanel) — drift architetturale.
19. **Brand mix Nous/Lumina** in DOM attributes, log, docs, file names.
20. **Untyped `patchProject` FE→BE** (drift contratto) e **`ProjectSnapshot` ridefinito** col backend ancora con `laboratory` legacy.
21. **`ApiResponse` "tutto opzionale"** in `HttpProjectRepository`.

Da assegnare priorità a fine tour, quando avremo la lista completa.

---

## Priorità di pulizia — roadmap (decisa con l'utente)

Ordine deciso. Sotto, per ogni voce: cosa, perché, costo stimato, beneficio, **modello consigliato per eseguirla**, e **briefing autonomo** (per riprendere il task anche senza il contesto della chat).

### Convenzione modello

- **Sonnet OK** = task di scrittura/cancellazione doc, refactor cosmetico con pattern chiaro. Sonnet va bene **se gli si dà istruzioni precise** e il pattern è già definito.
- **Opus / GPT-5** = task strutturali (cambio contratto, refactor cross-codebase, decisioni architettoniche). Sonnet potrebbe perdere occorrenze o non capire l'impatto.

---

### ✅ PRIORITÀ 1 — Rinominare "Runtime" → "State" nel Reader **[FATTA]**

**Cosa**: rinominare `useWorkspaceReaderState` → `useWorkspaceReaderState`, `WorkspaceReaderRuntime` type → `WorkspaceReaderState`, `readerRuntime` variable → `readerState`, e il file `useWorkspaceReaderState.ts` → `useWorkspaceReaderState.ts`.

**Perché ora**: AGENTS.md vieta esplicitamente nomi generici (riga 109: "Avoid names that are too generic — handle, process, data, item, value, manager"). "Runtime" è in quella famiglia: non dice se è stato, comportamento, o configurazione. Quello che fa il modulo è **tenere lo stato visivo** del Reader. Mettere il rename per primo evita che ARCHITECTURE.md (priorità 2) scriva il vecchio nome.

**Impatto**: ~10 file di codice + 2 file doc.
- `apps/web/App.tsx` (17 occorrenze di `readerRuntime`)
- `apps/web/app/readerShellProps.ts`
- `apps/web/app/useReaderShellProps.ts`
- `apps/web/components/workspace/ReadingScreenContainer.tsx`
- `apps/web/components/library/LibraryScreenContainer.tsx`
- `apps/web/components/assessment/AssessmentScreenContainer.tsx`
- `apps/web/hooks/workspace/useWorkspaceReaderState.ts` (file)
- `apps/web/hooks/reader/useReaderChrome.ts` (1 commento)
- `apps/web/hooks/reader/useReaderSpeech.ts` (1 commento)
- `docs/ARCHITECTURE.md` (3 occorrenze)
- `docs/architecture-review.md` (questo file, 3+ occorrenze)

**Costo**: ~30 min.
**Beneficio**: nome che parla, conformità ad AGENTS.md, base pulita per i doc successivi.
**Modello**: **Opus / GPT-5**. Sonnet potrebbe perdere occorrenze in commenti o nei doc.

**Risultato effettivo della sessione**:
- 9 file di codice modificati (App.tsx, app/readerShellProps.ts, app/useReaderShellProps.ts, components/workspace/ReadingScreenContainer.tsx, components/library/LibraryScreenContainer.tsx, components/assessment/AssessmentScreenContainer.tsx, hooks/reader/useReaderChrome.ts, hooks/reader/useReaderSpeech.ts, hooks/workspace/useWorkspaceReaderState.ts).
- File rinominato: `useWorkspaceReaderRuntime.ts` → `useWorkspaceReaderState.ts`.
- Doc aggiornata: `docs/ARCHITECTURE.md` (3 occorrenze) e questo file.
- `bun run quality` verde (TypeScript type check + Biome lint).

**Estensione successiva (priorità 1.5, anche fatta)**:
- `resetRuntimeState` → `resetSessionState` ovunque (interface `WorkspaceControllerStateAdapter` + 7 callsite in controller + 1 nel test). Resetta `assessmentMessages`, `chatSession`, `openingProjectId` — la sessione corrente di lavoro su un progetto.
- Variabile locale `runtime` → `internalState` in `tests/hooks/workspace/useWorkspaceController.test.ts` (container del mock state adapter, esposto per asserzioni).
- Stringa descrittiva test "transient runtime state" → "transient session state".
- `bun run quality` verde, `bun run test` 433/433 verdi.

**Lasciati fuori scope (intoccabili)**:
- `react/jsx-runtime` e `react/jsx-dev-runtime` in `vite.config.ts`: nomi di moduli React.
- Stringhe italiane in `research.test.ts` ("Distinguere linguaggio e runtime"): dati di test, riferimento al concetto generale di runtime in informatica.

---

### ✅ PRIORITÀ 2 — Aggiornare `docs/ARCHITECTURE.md` perché smetta di mentire **[FATTA]**

**Cosa**: riscrivere `docs/ARCHITECTURE.md` riflettendo la realtà attuale del codice.

**Perché ora**: oggi cita `services/laboratory/` che non esiste, tace su `services/exercises/` e `services/learning/` e sub-system Research, non menziona la scelta dei due client AI (Vercel SDK + openrouter), e dice "LaboratoryState" che è morto. Quando un documento mente, smetti di fidarti di **tutta** la doc.

**Costo**: ~45 min.
**Beneficio**: enorme, dura per mesi.
**Modello**: **Sonnet OK**, se gli dai la struttura attuale e il glossario di questo file da cui pescare. Il task è "leggi la realtà, riscrivi la mappa".

**Risultato effettivo della sessione**:
- `docs/ARCHITECTURE.md` riscritto da capo.
- Rimosso `services/laboratory/`, aggiunti `services/exercises/` e `services/learning/`.
- Espansa la descrizione di `services/openrouter/` e `services/projects/`.
- Aggiunta sezione **"Two AI Clients"** che documenta esplicitamente la scelta dei due stack AI.
- Rimossi tutti i riferimenti a `LaboratoryState` / `LaboratoryExercise` / `activeLaboratoryExerciseId`.
- Aggiunti i nuovi tipi `LessonNode`, `ApplicationExerciseNode`, `PathNode`, `ResearchCoursePlan`, `ResearchLessonDossier`.
- Aggiunta nota nel Domain section che spiega dove è andato il "laboratory" (intercalato come `kind: 'exercise'`).
- Backend section espansa con: supporting modules, auth bypass warning, project storage modes, drift FE↔BE rimando.
- TTS section espansa con chunking + crossfade.
- "Where to make changes" aggiornato con riga per chat prompt, application-exercise, LAN auth.
- "Architectural rules" arricchito con due regole: separazione dei due client AI, proxy della API key.
- "Tooling" aggiornato con `bun run fix` e `bun run gate`.
- `bun run quality` verde.

---

### ✅ PRIORITÀ 3 — Creare `CONTEXT.md` (glossario alla radice) **[FATTA]**

**Cosa**: file `CONTEXT.md` alla radice del repo con il glossario stabile del progetto.

**Perché ora**: nel codice "section", "lesson", "module", "sub-chapter", "path-node", "exercise" si sovrappongono. Toccare uno costa caro perché non sai quale grep colpire. La bozza esiste già in questo file (sezione "Glossario in costruzione"). Va trasferita e rifinita.

**Costo**: ~30 min.
**Beneficio**: alto. Diventa il dizionario di riferimento per chiunque entri.
**Modello**: **Sonnet OK** (è scrittura doc con bozza già pronta).

**Briefing autonomo**:
1. Leggi la sezione "Glossario in costruzione" di questo file.
2. Trasferisci in `CONTEXT.md` alla radice del repo, organizzando in cluster: **Progetto**, **Piano di studi** (Module/Lesson/PathNode/...), **AI Pipelines**, **Persistenza**, **Reader/Library**, **Modalità** (LAN/Learn).
3. Per ogni termine: una sola definizione, una sola riga.
4. Sezione "Termini deprecati / da non usare": `Laboratory`, `LaboratoryState`, `Section` (ambiguo → preferire Lesson o PathNode), `Runtime` (preferire State).
5. Sezione "Ambiguità storiche risolte":
   - `Laboratory` → ora è `ApplicationExercise` come `PathNode` con `kind='exercise'`.
   - Brand: ufficialmente **Lumina** (vedi priorità 7) — `Nous` è legacy.

---

### ✅ PRIORITÀ 4 — ADR sui due client AI **[FATTA]**

**Cosa**: file `docs/adr/0001-two-ai-clients.md` (o nome simile) che documenta perché ci sono due infrastrutture AI.

**Perché ora**: ho dovuto leggere gli import per scoprire che `services/openrouter/` è per le pipeline batch e Vercel AI SDK è per le chat con tool calls. Una scelta sistematica così importante deve avere un paragrafo scritto. Altrimenti tra tre mesi sembra un errore e qualcuno proverà ad "unificare" rompendo cose.

**Costo**: ~20 min.
**Beneficio**: alto. Salva discussioni future.
**Modello**: **Sonnet OK** (è scrittura doc).

**Briefing autonomo**:
1. Crea `docs/adr/` se non esiste.
2. Crea `docs/adr/0001-two-ai-clients.md`.
3. Contenuto (corto, 1 pagina):
   ```
   # Two AI clients: openrouter pipelines + Vercel AI SDK chats

   The frontend uses two distinct AI infrastructures, on purpose:

   - `services/openrouter/` — for **batch pipelines** (assessment, planning,
     research, lesson generation, exercise brief, verification, TTS, document
     indexing). Single function `callOpenRouter` over a backend proxy. Streaming
     SSE only when reasoning live is needed.

   - **Vercel AI SDK** (`@ai-sdk/react`, `ai`) — for **interactive chat with
     tool calls** (Reader Ask AI, Library Home Chat). Vercel SDK gives built-in
     tool-call handling, streaming chat history, and a chat UI hook.

   We did not unify because rebuilding the chat/tool-call/history stack on top
   of `callOpenRouter` would be expensive for low value. The two systems stay
   separate. Backend exposes both: `/api/openrouter/chat/completions` (raw
   proxy) and `/api/chat/context` + `/api/chat/library` (Vercel SDK protocol).
   ```

---

### ✅ PRIORITÀ 5 — Decommissionare i cadaveri del Laboratorio nel backend **[FATTA]**

**Risultato**:
- Rimossi `laboratory?` e `activeLaboratoryExerciseId?` da `ProjectSnapshot` e `ProjectPatch` in `apps/backend/src/projects/types.ts`.
- Rimosso `readLaboratory` da `apps/backend/src/routes/projects.ts` e relative letture in `requireProjectSnapshot` / `requireProjectPatch`. Payload inbound con quei campi viene silenziosamente scartato.
- Rimossi i rami `patch.laboratory` / `patch.activeLaboratoryExerciseId` in `sqliteProjectStore.patchProject` e nel guard `hasNonSectionPatches`.
- Rimossi i fallback su `laboratory?.title` (in `getProjectTitle`) e `laboratory?.exercises?.length` (in `buildCoverLabel`) in `apps/backend/src/projects/projectMeta.ts`.
- Aggiornata fixture in `apps/backend/tests/routes/projects.test.ts`.
- Aggiornata nota di compatibilità in `docs/ARCHITECTURE.md` e `CONTEXT.md`.

**Decisione su `schemaVersion`**: non introdotto. Il campo `version` (oggi `'4.1'`) esiste già su `ProjectSnapshot` ed è il sentinella naturale per la forma dello snapshot. Nessun codice fa branching su `version`, quindi un bump è puramente informativo; lasciato a `'4.1'` per non toccare la fixture di import-export. Da rivisitare se servisse migrazione attiva.

**Quality gate**: `bun run quality` verde (tsgo FE + BE, biome). Test verdi: 433 web + 8 backend `projects.test.ts`.

**Memoria storica (briefing originale)**:

**Cosa**: rimuovere dal backend (`apps/backend/src/projects/types.ts`) i campi legacy `laboratory?` e `activeLaboratoryExerciseId?` da `ProjectSnapshot` e `ProjectPatch`. Decidere se introdurre uno `schemaVersion` esplicito.

**Perché ora**: il refactor Application Exercises ha eliminato il Laboratorio dal frontend (commit `8c70415`), ma il backend ha ancora i campi nel tipo. Funziona per pura tolleranza (`[key: string]: unknown`), non per design. Lasciarli confonde chi legge.

**Cosa NON va toccato in questo passaggio**: lo `snapshotHydration.ts` del frontend continua a pulire vecchi snapshot — quel codice serve per i progetti già salvati, non lo cancellare.

**Costo**: 1-2 ore (con test).
**Beneficio**: alto. Chiude il refactor Application Exercises.
**Modello**: **Opus / GPT-5**. È cross-codebase e richiede capire l'impatto. Sonnet può sbagliare se non sa che il vecchio campo veniva preservato in transito.

**Briefing autonomo**:
1. Leggi `apps/backend/src/projects/types.ts` (`ProjectSnapshot`, `ProjectPatch`).
2. Rimuovi i campi `laboratory?`, `activeLaboratoryExerciseId?`.
3. Cerca usi di quei campi in `sqliteProjectStore.ts`, `projectMeta.ts`, `routes/projects.ts` — devono sparire.
4. Verifica che `prepareSnapshotForHydration` lato FE ancora gestisca i campi legacy in input (caso "vecchio snapshot in IndexedDB locale"): deve rimanere intatto.
5. Considera: vale la pena aggiungere `schemaVersion?: number` a `ProjectSnapshot`? Se sì, fissa la versione corrente a 1 e usa quella come future tag.
6. Test: `bun run gate`.

---

### ✅ PRIORITÀ 6 — Condividere tipi del contratto FE↔BE **[FATTA]**

**Risultato**:
- Creato `packages/shared-types/projectContract.ts` con i tipi del **wire contract**: `ProjectId`, `ProjectSourceKind`, `ProjectSyncState`, `LibraryFolder`, `LibraryPlacement`, `SavedProjectMeta`, `SectionPatch`, `ProjectPatch`. **Non** `ProjectSnapshot` — FE e BE lo modellano in modi intenzionalmente diversi (FE: rich domain con LearningPlan/PdfDocumentAssets; BE: wire JSON permissivo); fonderli avrebbe trascinato il dominio FE nel BE.
- Aggiunto alias `@shared/*` nei due tsconfig (`apps/web/tsconfig.json`, `apps/backend/tsconfig.json`) e in `apps/web/vite.config.ts`.
- FE (`apps/web/types.ts`) e BE (`apps/backend/src/projects/types.ts`) ora re-exportano i tipi condivisi via `export type {...} from '@shared/projectContract'`. Definizioni rimosse dai due file.
- `ProjectRepository.patchProject` lato FE: passato da `Record<string, unknown>` a **`ProjectPatch`**. Impl in `indexedDbProjectRepository.ts` e `httpProjectRepository.ts` aggiornate; tipi puntuali rimossi dove l'inferenza basta.
- Fixture in `apps/web/tests/services/projects/projectTransfer.test.ts` aggiornata.

**Decisione strategica**: condivisi **solo i tipi sul filo**, non lo `ProjectSnapshot`. Vedi commento nell'header di `packages/shared-types/projectContract.ts`.

**Quality gate**: `bun run quality` verde. Test verdi: 433 web + 8 backend. Server BE avvia (verificato).

**Gotcha noto (follow-up se mai serve)**: `apps/backend/package.json` ha `"build": "tsc"` + `"start": "node dist/server.js"`. `tsc` con emit non riscrive l'alias `@shared/*` nei file `.js` emessi → un deploy via `node dist/server.js` troverebbe l'import letterale `'@shared/projectContract'` e fallirebbe. In dev (`bun --watch src/server.ts`) bun risolve nativamente l'alias da tsconfig.paths, nessun problema. Se in futuro serve la build node, opzioni: (a) aggiungere `tsc-alias` come postbuild, (b) cambiare `start` a `bun src/server.ts` saltando l'emit, (c) sostituire l'unico import BE con un relative-path (richiede `rootDir` allargato o un file mirror locale).

**Memoria storica (briefing originale)**:

**Cosa**: una cartella `packages/shared-types/` (o un re-export incrociato) con `ProjectSnapshot`, `ProjectPatch`, `LibraryFolder`, `LibraryPlacement`, `SavedProjectMeta`, `ProjectExportData` definiti **una volta sola**.

**Perché ora**: oggi `patchProject(id, patch: Record<string, unknown>)` lato frontend è un'autostrada untyped. Aggiungi un campo a `ProjectPatch` nel backend → il TypeScript del frontend non se ne accorge. Rischio bug puro. È il debito strutturale più serio della codebase.

**Costo**: 4-6 ore (incluso rifacimento degli import).
**Beneficio**: strutturale. TypeScript protegge il contratto da entrambe le parti.
**Modello**: **Opus / GPT-5 obbligatorio**. Tocca decine di file, struttura monorepo, configurazione TS.

**Briefing autonomo**:
1. Leggere la sub-indagine "FE↔BE drift" di questo file — c'è il dettaglio completo.
2. Decidere strategia: (a) nuova workspace `packages/shared-types/` con suo `package.json`, oppure (b) re-export del backend dal frontend (path mapping in tsconfig). (a) è più pulito, (b) più veloce. Discuti con l'utente prima.
3. Spostare i tipi shared in un unico file.
4. Cambiare `patchProject` lato frontend da `Record<string, unknown>` a `ProjectPatch`.
5. Riconciliare `ProjectSnapshot` (rimuovere i campi laboratory legacy dal BE — link a priorità 5).
6. `bun run gate` — devono passare type check, lint, test.

---

### 🏷️ PRIORITÀ 7 — Finire il rebrand Nous → Lumina

**Cosa**: scegliere il nome definitivo del prodotto (ipotesi più probabile: **Lumina**, dato il nome della cartella) e fare uno sweep.

**Perché ora**: oggi "Nous" e "Lumina" si alternano nel codice. README e ARCHITECTURE.md dicono "Nous Reader". Trace globale è `pushNousDebugTrace`. `httpProjectRepository.ts` log `'[Lumina] LAN project sync failed'`. DOM attributes accettano sia `data-nous-annotation-id` che `data-lumina-annotation-id`. È un rebrand a metà.

**Costo**: 2-3 ore. Va testato anche manualmente per essere certi che progetti salvati con il vecchio brand continuino ad aprirsi.

**Beneficio**: medio-alto. Stop confusione, identità chiara.

**Modello**: **Opus / GPT-5**. Sweep cross-codebase con compat di retrocompatibilità DOM da preservare.

**Briefing autonomo**:
1. Chiedi all'utente di confermare il nome canonico (Lumina vs Nous).
2. Sweep dei simboli di codice: `pushNousDebugTrace` → `pushLuminaDebugTrace` (o nuovo nome), `__NOUS_SERVER_CONFIG__` → versione nuova.
3. Sweep messaggi log: `[Nous]` → `[Lumina]`.
4. Sweep doc: README, ARCHITECTURE.md, AGENTS.md.
5. **Lasciare** la dual-search dei DOM attribute `mark[data-nous-annotation-id], mark[data-lumina-annotation-id]` per retrocompatibilità con vecchi progetti — aggiungere commento esplicito sul perché.
6. Sweep stringhe utente visibili (UI).
7. Test manuale: aprire un progetto vecchio e verificare che gli highlight ancora si vedano.

---

### 🔀 PRIORITÀ 8 — Consolidare la logica esercizi sparsa — ✅ Fatto

**Risultato**:
- `services/learning/applicationExercises.ts` → `services/exercises/plan.ts` (dominio: funzioni pure su `LearningPlan`).
- `services/openrouter/exerciseBrief.ts` → `services/openrouter/exercises/brief.ts`.
- `services/openrouter/exercisePlacement.ts` → `services/openrouter/exercises/placement.ts`.
- Test spostato: `tests/services/learning/applicationExercises.test.ts` → `tests/services/exercises/plan.test.ts`.
- 5 importer aggiornati (`useReaderShellProps`, `readerShellProps`, `sectionProgression`, `assessmentPlanning`, `openrouter/index`).

**Lasciato dov'era — con motivo**:
- `services/openrouter/lessonVerification.ts`: la review l'aveva listato "in parte" ma rileggendolo serve la generazione lezioni (prompt + schema response), non gli esercizi. I 3 importer stanno tutti in `openrouter/planning/`. Non c'è niente da spostare.
- `services/learning/temporaryLabLessons.ts`: 24 righe di migration legacy che disinnesca snapshot pre-application-exercises. Senza schema versioning non si può confermare che nessuno snapshot in giro ne abbia ancora bisogno. Cost/benefit del rimuoverlo non vale il rischio. Resta in `services/learning/` accanto a `groupSectionsIntoModules.ts`.

**Verifica**: quality verde, 433 test FE + 38 test BE passano.

---

## Cose intenzionalmente NON in roadmap (per onestà)

Le ho considerate e fermate per una ragione:

- **Spaccare i file >1000 righe del Reader** (ContextAnswerPanel, useTtsPlayer, ContextMenu) — sono coesi, ogni file è una macro-feature unica. Spaccare adesso aggiunge salti tra file senza ridurre la complessità.
- **`LearningPlan` god node (67 connessioni)** — costoso, no dolore acuto.
- **Caching pipeline AI** — gap funzionale, non strutturale.
- **Schema versioning snapshot** — affrontato di striscio in priorità 5; pieno solo se diventerà problema.
- **Singleton globali persistQueue/syncState** — funzionano, test-friction esiste ma non blocca.
- **Magic `globalThis.__NOUS_SERVER_CONFIG__`** — collaterale a un altro problema di circular dep.
- **Drag & drop manuale** — funziona, no bug.
- **`LOCAL_AUTH_BYPASS`** — debito esplicito documentato.

---

## Per chi riprende: prossimo step concreto

**Tappa 3 — Persistenza.**

Prima di parlare con l'utente, esplorare:
- [`apps/web/services/projects/`](apps/web/services/projects/) — repository factory (IndexedDB vs HTTP), persistence signature, autosave, transfer, archive, snapshot.
- [`apps/backend/src/projects/`](apps/backend/src/projects/) — store SQLite, auth bypass locale.
- [`apps/web/hooks/library/useProjectLibrary.ts`](apps/web/hooks/library/useProjectLibrary.ts) — orchestrazione lato hooks.
- `services/preferences/` per il localStorage (terza forma di persistenza).

Domande chiave da affrontare:
- Interfaccia `ProjectRepository`: è davvero unica fra IndexedDB e SQLite? Quali metodi?
- Come funziona la **persistence signature**? Probabilmente è un hash per evitare scritture inutili → da capire come è calcolato (vedi community 8 nel grafo).
- Come funziona l'autosave? Throttle? Debounce? Coda?
- Cosa succede a un progetto se si chiude il browser durante una scrittura?
- C'è versioning degli snapshot per gestire migration (vedi `prepareSnapshotForHydration`)?
- La sincronizzazione LAN tra dispositivi: c'è gestione di conflitti o è "last write wins"?

Stessa struttura della tappa 1 e 2: cos'è, scelte forti, pain point, glossario, 2-3 domande all'utente.

---

## Per chi riprende: come parlare con l'utente

- Tono: collega-a-collega, italiano.
- Niente gergo web non spiegato prima.
- Risposte tese ma non telegrafiche — l'utente vuole capire, non solo bullet point.
- Memoria utente esistente (`feedback_communication_style`): "terse, no beginner checklists". Significa: niente liste interminabili di basics, ma le sezioni denso-tecniche sono OK.
- Domande all'utente: max 2-3 mirate alla volta, usando `AskUserQuestion` quando ha senso scegliere tra opzioni nette.
- L'utente decide priorità e direzione, l'agente propone e mostra opzioni.
