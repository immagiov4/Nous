# Lumina Reader — Roadmap (2026-05-02)

Roadmap operativa derivata dalla TODO list di Giov. Ordinata per **rapporto impatto/fattibilità** e suddivisa in fasi indipendenti che possono essere assegnate una alla volta a un modello esecutore (anche piccolo, es. DeepSeek).

## Come usare questo documento

Ogni fase è un **piano autonomo**:
- **Scope**: cosa è incluso, cosa no.
- **File coinvolti**: punti di partenza concreti.
- **Steps**: ordine di esecuzione.
- **Test**: cosa il modello esecutore *deve* aggiungere/aggiornare. Se la fase tocca logica di dominio o di persistenza, **NON è completa senza test**. Il modello piccolo tende a saltarli — chi assegna il task deve respingere il PR se i test mancano.
- **Open questions**: domande per Giov che bloccano l'esecuzione. Vanno risolte *prima* di passare il piano al modello esecutore.

Le fasi marcate `[NEEDS-ANSWER]` non sono pronte per il modello piccolo finché Giov non risponde alle Open questions.

---

## Risposte di Giov (2026-05-02) — assunzioni di progetto

1. **Persistenza target = SQLite/LAN**. Il lavoro di Fase 1 è sul backend (`SqliteProjectStore`, `httpProjectRepository.ts`) e sul lato client che lo consuma.
2. **PDF: nessun limite pratico**. Fase 4 va nella direzione "solo derivati" (testo + immagini), eliminando il blob originale.
3. **Bug `SALTO IMMAGINI`: nessun repro, nessun test di regressione**. Riformulato come **investigazione performance** dell'estrazione immagini (vedi Fase 2.a aggiornata). Va consolidato col pipeline di Fase 4.
4. **Bug `nota infinita`**: nessun repro disponibile — Fase 2.b parte da inspection del dispatcher tool e introduce comunque un timeout di sicurezza (no test di regressione obbligatorio, ma test del timeout sì).
5. **Re-render lenti**: tutte le viste che caricano da DB; anche l'highlight ha ~1s di latenza percepita. Confermato che è lo **stesso problema di Fase 1** → Fase 3 viene assorbita.

### Domande residue (per il modello esecutore)

- **Coverage test**: stabiliamo che ogni fase **non riduce** la copertura. Aggiungere test sui rami nuovi è obbligatorio per fasi che toccano logica di dominio o persistenza.

---

# FASE 0 — Quick wins UI (1 PR, ~mezza giornata) FATTO

Bug visivi e di UX a basso rischio. Vanno tutti insieme perché toccano file diversi e non hanno dipendenze.

## Scope
- **0.a** Rinomina cartella: il campo edit appare *sopra* la text box invece che dentro/sotto in modo coerente. Da spostare/centrare.
- **0.b** Filtro file ammessi nel "Carica file" del laboratorio (oggi accetta tutto).
- **0.c** Click su area non-popup degli allegati in chat home → chiude il menu (manca outside-click handler).
- **0.d** Scrollbar orizzontale che lampeggia nel menu "Impostazioni modelli".
- **0.e** Scrollbar custom o rimossa nell'editor delle note (oggi è di sistema e stona).
- **0.f** Follow-up: rimuovere scrollbar visibile, aggiungere freccia "vai a fine risposta" + fade-out in basso per evitare clip sgraziato.
- **0.g** Counter "0/4 consegnati - 0/4 valutati" sotto ogni lezione: spostarlo o nasconderlo dietro hover/expand. Decidere con Giov il target esatto.

## File coinvolti
- `apps/web/components/library/LibraryTreeView.tsx` (rename)
- `apps/web/components/workspace/laboratory/*` (filtro file)
- `apps/web/components/workspace/*ChatHome*` o equivalente (outside click)
- `apps/web/components/shared/ModelSettingsPanel*` (scrollbar)
- `apps/web/components/workspace/notes/*` (scrollbar note)
- `apps/web/components/workspace/*FollowUp*` (scrollbar + arrow)

## Test
- Test unitari per il filtro file (valida estensioni accettate/rifiutate).
- Test di interazione (RTL) per outside-click sul menu allegati.

## Open questions
- **0.b**: quali estensioni vogliamo accettare nel laboratorio? Default proposto: `pdf, png, jpg, jpeg, webp, txt, md, docx`.
- **0.g**: nascondere completamente o mostrare solo se `consegnati > 0`?

---

# FASE 1 — UI ottimistica + DB non bloccante (SQLite/LAN)

**Il problema più impattante e la fase più grande della roadmap.** Aprire un corso, creare una lezione, evidenziare prendono ~1s perché lo store attende il round-trip backend→SQLite→backend prima di renderizzare. Questa fase **assorbe la vecchia Fase 3** (i re-render lenti sono DB-driven).

## Diagnosi mirata (da fare in step 1, prima di toccare)

Il sospetto principale è uno di questi tre bottleneck — il modello esecutore deve identificare *quale* prima di scegliere la cura:

- **B1.** Il client `httpProjectRepository.ts` fa `await` di un POST/PUT che serializza l'intero snapshot a ogni mutazione → richiesta di rete inutilmente grande.
- **B2.** `SqliteProjectStore` riscrive l'intero blob progetto (tutta la `LearningPlan` o l'intera `LaboratoryState`) anche per un singolo highlight → I/O sproporzionato al delta.
- **B3.** Il client invalida il context React e scatena re-render dell'intero workspace dopo la conferma DB.

Probabilmente è una combinazione, ma il rimedio cambia: B1/B2 → patch granulare; B3 → optimistic update + split context.

## Scope
1. Pattern `applyOptimistic(action) → enqueuePersist(delta)`: lo state in memoria si aggiorna subito, la persistenza è asincrona.
2. La persistenza diventa **per delta** (non snapshot completo) per highlight, note, completion section, attachment.
3. Hot path da convertire (in ordine): apertura progetto → highlight → nota → creazione lezione → completamento sezione.
4. Errori persistenza → toast non-bloccante con "Riprova"; **no rollback automatico** salvo conflitto reale.
5. Indicatore globale di sync state in topbar (badge piccolo: "salvato"/"in salvataggio"/"errore").

## File coinvolti
- `apps/backend/src/services/SqliteProjectStore.ts` (cerca path esatto; god node con 38 edges)
- `apps/backend/src/routes/projects.ts` (endpoint da estendere con patch granulari, es. `PATCH /api/projects/:id/highlights`)
- `apps/web/services/projects/httpProjectRepository.ts` (242 LOC, da rifattorizzare per usare patch)
- `apps/web/services/projects/projectRepository.ts` (interfaccia: aggiungere metodi delta)
- `apps/web/services/projects/persistenceSignature.ts` (dedup)
- `apps/web/services/workspace/domain.ts` (azioni reducer; non devono cambiare semantica)
- `apps/web/hooks/workspace/useWorkspaceController.ts` + `controller/projectLifecycle.ts`, `sectionProgression.ts`
- Nuovo: `apps/web/services/projects/persistQueue.ts`

## Steps (ordine esecuzione obbligatorio)
1. **Misurare baseline** — aggiungere `performance.mark`/`measure` su: apertura progetto, highlight, nuova nota, completamento sezione. Log in dev console + scrivere i numeri in `docs/PERF_BASELINE.md`. Senza baseline il modello esecutore non può dimostrare miglioramento.
2. **Identificare bottleneck B1/B2/B3** dai numeri raccolti. Documentare la causa nel PR.
3. **Endpoint patch granulari** sul backend per highlight + nota + section completion. Devono accettare un delta piccolo, non lo snapshot intero. Test di integrazione su SQLite per ognuno.
4. **`persistQueue.ts`** lato client: FIFO, dedup per chiave (es. `highlight:<sectionId>:<id>`), retry esponenziale, drain on unmount. Test unitari sul modulo.
5. **Convertire openProject** per primo (più isolato): UI mostra dati subito, hydration in background.
6. **Convertire highlight** (caso più sentito a ~1s percepito): apply ottimistico + enqueue patch.
7. **Convertire addNote**.
8. **Convertire createSection** + completamento sezione.
9. **Sync indicator** in topbar.
10. **Ri-misurare** e confrontare col baseline. Numeri prima/dopo nel PR.

## Test
- Unit: `persistQueue` (dedup, retry, ordering, drain on shutdown).
- Backend integration: ogni nuovo endpoint patch (creazione/aggiornamento/cancellazione di un singolo highlight non deve riscrivere altri campi).
- Frontend integration: mock backend lento (200ms artificiali) → verifica che il render del nuovo highlight avvenga **prima** della conferma backend.
- Regression: snapshot dei reducer prima/dopo (le azioni non devono cambiare semantica).
- Conflict handling: due patch concorrenti sullo stesso highlight → l'ultima vince (last-write-wins) e nessuna eccezione.

## Note per il modello esecutore
- **Non** trasformare le mutazioni in CQRS o event sourcing. Resta semplice: state in memoria + queue + patch endpoint.
- Il pattern "sync indicator" deve riusare lo store esistente, non aggiungere un secondo state manager.
- Se identifichi un quarto bottleneck non listato, fermati e segnalalo prima di intervenire.

---

# FASE 2 — Bugfix critici (1-2 PR, dipendono da repro)

Due bug che bloccano flussi reali. Vanno **prima** delle feature nuove.

## 2.a — Estrazione immagini PDF lenta (investigazione perf, non bug)
**Riformulato 2026-05-02**: Giov non ha repro di rottura, sospetta solo che l'estrazione immagini sia inutilmente lenta. Niente regression test — è un'analisi di performance.

- **Obiettivo**: capire perché l'estrazione immagini è "così pesante" e ridurla.
- **File**: `apps/backend/src/services/pdfImageExtractor.ts` (modificato di recente), `apps/backend/src/utils/sanitizePartialPages.ts` (nuovo).
- **Steps**:
  1. Strumentare il pipeline con timing per pagina (parsing, decode, encode, write). Output in console + file `docs/PDF_EXTRACTION_PROFILE.md`.
  2. Profilare con un PDF di ~50 pagine misto (testo + immagini): identificare il top time consumer.
  3. Possibili rimedi (da scegliere in base al profilo, non in cieco):
     - Parallelizzare per pagina con `Promise.all` se attualmente seriale.
     - Saltare ri-encode se l'immagine è già in formato accettabile.
     - Caching intra-sessione delle immagini già estratte.
     - Sostituire libreria PDF se è il bottleneck (decisione *grossa*, fermarsi e chiedere a Giov).
  4. Documentare numeri prima/dopo.
- **Consolidamento con Fase 4**: questo lavoro tocca lo stesso pipeline che Fase 4 modifica (storage solo derivati). Considerare di **fonderle** in un unico PR se le modifiche sono adiacenti.

## 2.b — "Sto caricando i dettagli della nota proposta..." infinito su highlight in tabella
- **Sintomo**: highlight su tabella → loading infinito + log `Tool result is missing for tool call tool_requestAddToNotes_*`.
- **Repro**: non disponibile. Il modello esecutore parte da inspection statica del dispatcher tool.
- **File sospetti**: cerca `requestAddToNotes` nel codice (`grep -r requestAddToNotes apps/web/`), `apps/web/services/openrouter/*` per la chiusura del tool call, `services/library/` o equivalente per l'esecuzione tool.
- **Steps**:
  1. Mappa il flusso `tool_use → tool_result` partendo dal nome `requestAddToNotes`.
  2. Identifica i casi in cui il tool può finire senza emettere `tool_result` (eccezione silenziata, early return, race con stream close).
  3. **Fix difensivo**: aggiungi un timeout (30s) lato dispatcher che, se nessun `tool_result` arriva, emette uno di fallback con messaggio "operazione non riuscita" e chiude il loading state.
  4. Test del timeout: simulare un `tool_use` che non riceve mai `tool_result` → la UI esce dal loading entro 30s e mostra il messaggio di errore.

## Open questions
- **2.B** Va bene timeout di 30s? Se vuoi più aggressivo (es. 10s) cambia il numero, ma assicurati che le tool call legittime (es. genera contenuto) non vengano interrotte.

---

# FASE 3 — [ASSORBITA da FASE 1]

Giov ha confermato che le viste lente sono *tutte* quelle che caricano da DB e che l'highlight ha ~1s di latenza. Questo è esattamente il sintomo che FASE 1 risolve (UI ottimistica + patch granulari).

**Solo se** dopo FASE 1 restano lentezze evidenti non DB-driven, riapri questa fase con:
- Profiling React DevTools → top 5 offender → memoization mirata.
- File candidati residui: `LibraryTreeView.tsx`, hook `useReaderChrome.ts`.

Non eseguire questa fase prima di aver completato FASE 1.

---

# FASE 4 — PDF: storage solo derivati (testo + immagini)

## Scope (deciso)
**Opzione (b)**: eliminare il blob PDF originale dalla persistenza, tenere solo testo estratto + immagini. Target: nessun limite pratico di dimensione PDF.

## Pre-check (step 0 obbligatorio)
Prima di rimuovere il blob, il modello esecutore deve verificare che **nessun consumatore lato runtime** richieda il PDF originale. Cerca `pdfBlob`, `originalPdf`, `sourcePdf`, `arrayBuffer` nel codice e documenta in PR. Se trovi un caso d'uso non banale (es. visualizzazione PDF nativa nel reader), **fermati e chiedi**.

## Steps
1. Pre-check sopra. Documenta in `docs/PDF_STORAGE_DECISION.md`.
2. Rimuovere il campo blob dallo schema persistenza (`projectSnapshot.ts`, `SqliteProjectStore`).
3. Migrazione progetti esistenti: al caricamento di un progetto vecchio, scartare il blob e mantenere derivati. Nessuna conversione necessaria se i derivati erano già salvati.
4. Rimuovere il limite di dimensione check (cerca check su `MAX_PDF_SIZE` o simili).
5. Verificare che l'estrazione (Fase 2.a) non crei colli di bottiglia su file molto grandi (>200MB). Se sì, streaming dell'estrazione invece di buffering.

## File coinvolti
- `apps/web/services/openrouter/pdfAssets.ts`
- `apps/backend/src/services/pdfImageExtractor.ts`
- Schema persistenza: `httpProjectRepository.ts`, `projectSnapshot.ts`, `SqliteProjectStore`
- Migrazione: `services/projects/migrations/dropPdfBlob.ts` (nuovo)
- Eventuale check di limite: cerca `MAX_PDF` / `pdfSizeLimit` nel codice.

## Test
- Migrazione: progetto vecchio formato (con blob) → caricamento → snapshot nuovo formato (senza blob, derivati intatti).
- Caricamento di un PDF di ~150MB senza errori.
- Regression: test esistenti su `pdfAssets` continuano a passare.

## Note
- **Consolidare con Fase 2.a** se possibile: stesso pipeline, stesso modello esecutore.
- Se l'estrazione è già lenta (Fase 2.a), valutare se renderla cancellabile dall'utente (oggi non lo è? verificare).

---

# FASE 5 — TTS che segue il testo + lanciabile da punto arbitrario `[NEEDS-ANSWER]`

## Scope
Word/sentence-level highlight sincronizzato con audio + click su una porzione di testo per partire da lì.

## Steps
1. Verificare se l'API TTS attuale (OpenRouter audio/speech) restituisce timestamp per parola/frase. Se non li restituisce, serve allineamento forzato (whisper-style) o stima euristica.
2. Aggiungere mapping `[testo_porzione → time_offset_audio]` nel risultato TTS.
3. UI: highlight della porzione corrente + handler click su testo che esegue `audio.currentTime = offset`.
4. Cache audio per evitare ri-generazione.

## File coinvolti
- `apps/web/hooks/reader/useReaderSpeech.ts`
- `apps/web/hooks/reader/useTtsPlayer.ts` (presunto)
- `apps/backend/src/services/ttsClient.ts`
- Nuovo: `apps/web/services/audio/textTimeline.ts`

## Test
- Test del builder di timeline (input: testo + array di timestamp; output: mappa porzione→offset).
- Test del seek-from-text.

## Open questions
- **5.A** Granularità: parola, frase, paragrafo? Suggerisco frase (compromesso costo/UX).
- **5.B** L'API TTS attuale supporta timestamp? (Da verificare nel codice di `ttsClient.ts`.)
- **5.C** Caching audio: in memoria, IndexedDB, o filesystem (LAN)?

---

# FASE 6 — Laboratorio: bundling sessioni + UX prompt `[NEEDS-ANSWER]`

Riorganizza la generazione e presentazione del laboratorio. Più piccoli stage in una stessa fase.

## Scope
- **6.a** Capire e documentare come oggi si decide il numero di sessioni (cerca in `services/openrouter/laboratory.ts` + `services/laboratory/state.ts`).
- **6.b** Migliorare prompt "errori da evitare": rendere i messaggi non-ambigui (Giov segnala domande linguisticamente ambigue).
- **6.c** Esempio guidato come ultimo punto della sezione "non dare troppi aiuti".
- **6.d** Pause attive: domande non linguisticamente ambigue (controllo prompt).

## Steps
1. Leggere `apps/web/services/openrouter/laboratory.ts` e annotare le decisioni di bundling in commento → poi in `docs/LABORATORY_DESIGN.md`.
2. Aggiornare i prompt incriminati (file `apps/web/services/openrouter/prompts.ts`).
3. Aggiungere snapshot test sui prompt per fissare la formulazione.

## Test
- Snapshot dei prompt: se cambiano, deve essere intenzionale.
- Test della logica di bundling con input controllati.

## Open questions
- **6.A** Vuoi che il bundling resti automatico o configurabile dall'utente?
- **6.B** Hai esempi concreti di "domanda ambigua" da inserire nei test come anti-pattern?

---

# FASE 7 — Library: drag-out, no-duplicati LAN, custom instructions

Stage di feature varie sul library/projects.

## Scope
- **7.a** LAN: due cartelle con stesso nome non devono coesistere. Aggiungere validazione + suffisso "(2)" in caso di import.
- **7.b** Drag fuori da una cartella corso (oggi non funziona o si comporta male).
- **7.c** Custom instructions: salva su blur invece che on-change (oggi sembra debounced lento).

## File coinvolti
- `apps/web/components/library/LibraryTreeView.tsx`
- `apps/web/services/projects/projectTransfer.ts`
- `apps/backend/src/routes/projects/*` (per validazione lato LAN)
- Componente custom-instructions (cercare con grep `custom instructions` o simile).

## Test
- Test della funzione di deduplica nomi cartella.
- Test del comportamento drag-and-drop (RTL + dnd-kit se usato).

## Open questions
- **7.A** Su collisione nome: rinominare automaticamente, prompt all'utente, o rifiutare?

---

# FASE 8 — Mappe come artefatto richiamabile `[NEEDS-ANSWER]`

**Feature nuova grossa.** Va isolata in un PR proprio.

## Scope
- Creare uno "skill" tipo `generateMindMap` invocabile da Gemini in un follow-up.
- L'output va in una "window di artefatto" (componente nuovo).
- Usa il modello "lezioni" (Pro/lento), non quello veloce.
- L'artefatto è salvabile come nota.

## Steps
1. Definire il formato dati della mind map (es. `{nodes, edges}` JSON).
2. Aggiungere prompt + servizio `services/openrouter/mindMap.ts`.
3. Esporre come tool nel chat (cercare il dispatcher dei tool esistenti, riusare il pattern).
4. Componente `components/workspace/artifacts/MindMapArtifact.tsx` con renderer (consiglio: react-flow o reaflow).
5. Salvataggio nelle note: il render serializzato + dati grezzi.

## Test
- Test del prompt (snapshot).
- Test della serializzazione/deserializzazione mappa.
- Test che l'artefatto si salvi e ricarichi correttamente nelle note.

## Open questions
- **8.A** Renderer scelto? (suggerisco `react-flow`, già maturo).
- **8.B** L'artefatto deve essere editabile manualmente o solo read-only?
- **8.C** Va dentro la nota come embed o come allegato linkato?

---

# FASE 9 — Futuro: laboratorio interspersed `[NEEDS-ANSWER]`

**Big design change.** Non eseguibile da modello piccolo. Richiede design doc + review prima di implementare.

## Scope
Esercitazioni laboratorio sparse a fine capitolo / dopo N competenze, invece che in un blocco finale.

## Pre-work richiesto
1. Design doc (`docs/INTERSPERSED_LAB_DESIGN.md`) con:
   - Trigger di inserimento (fine capitolo? soglia di competenze? configurabile?)
   - Effetti su stato/dominio (`LaboratoryState` cambia o resta uguale?).
   - Migrazione progetti esistenti.
2. Review di Giov.
3. Solo dopo, piano implementativo.

## Open questions
- **9.A** Trigger preferito?
- **9.B** Si applica a *tutti* i progetti o configurabile per corso?

---

# Bug/issue addizionali rilevati durante l'analisi (da confermare)

Trovati guardando lo `git status` e i file recenti:

- **A.** `apps/web/services/openrouter/documentIndex.ts` cancellato + nuova cartella `documentIndex/`. Verificare che la migrazione sia completa e che non ci siano import rotti.
- **B.** `apps/web/utils/dom/mediaQuery.ts` cancellato + nuovo `apps/web/utils/mediaQuery.ts`. Stessa verifica.
- **C.** `apps/web/utils/text/clipText.ts` e `normalizeLineEndings.ts` cancellati, sostituiti da `apps/web/utils/text.ts`. Verificare import.
- **D.** Nuovi file `sanitizePartialPages.ts` (sia backend che web) — duplicazione? Vedere se possono essere accorpati in uno shared.

Questi vanno chiusi (FASE 0.h) o messi in un PR di pulizia separato. Il modello piccolo deve fare `npm run quality` e `npm test` per assicurarsi che non ci siano import rotti dopo i rename.

---

# Regole per il modello esecutore (DeepSeek o simile)

Da incollare nel prompt quando assegni una fase:

> Stai eseguendo una fase della roadmap di Lumina Reader. Regole:
> 1. **Leggi `docs/ARCHITECTURE.md`** prima di iniziare. Per domande su come moduli si collegano, usa `graphify query "<domanda>"` invece di grep.
> 2. **Non andare oltre lo scope della fase.** Se vedi cose da sistemare fuori scope, scrivile in un commento del PR, non implementarle.
> 3. **Test obbligatori**: ogni fase che tocca logica deve includere test. Se non aggiungi test, il PR viene rifiutato. Esegui `npm test` e `npm run quality` prima di chiudere.
> 4. **Open questions**: se ci sono `[NEEDS-ANSWER]` o "Open questions" non risolte nel piano, **fermati e chiedi**. Non assumere.
> 5. **Bug fix**: senza un test di regressione che fallisce *prima* del fix e passa *dopo*, il fix non è completo.
> 6. **Performance**: niente refactor "preventivi". Misura prima, ottimizza dopo, ri-misura.
> 7. **Optimistic update**: se la fase introduce questo pattern, gestisci esplicitamente il caso di errore (non silenzioso).
> 8. Dopo aver modificato file, esegui `graphify update .` per aggiornare il grafo.

---

# Ordine di esecuzione consigliato (aggiornato 2026-05-02)

1. **FASE 0** — quick wins UI, basso rischio.
2. **FASE 2.b** — fix loading infinito tool call (timeout difensivo).
3. **FASE 1** — UI ottimistica + DB non bloccante. **Il fix di impatto più grande.** Sblocca anche FASE 3.
4. **FASE 2.a + FASE 4** consolidate — investigazione perf estrazione immagini + storage solo derivati. Stesso pipeline, un PR (o due piccoli adiacenti).
5. **FASE 7** — library quick (drag, dedup, custom instructions).
6. **FASE 6** — prompt laboratorio.
7. **FASE 5** — TTS sincronizzato.
8. **FASE 8** — mind map artefatto.
9. **FASE 9** — lab interspersed (design doc prima).
10. **FASE 3** — solo se dopo Fase 1 restano lentezze residue.
