# Grafo curricolare e collegamento diagnostico per #119

Proposta tecnica del 10 settembre 2026, verificata contro il codice di `main` al commit `c7c324dd1c2fbad06aafc8a04c17b53606331351`. Il primo blocco strutturale è stato approvato e implementato nei [contratti e validatori](../04-section-data/03-p-curriculum-contract.md). Le sezioni su generazione, persistenza ed estensioni descrivono il lavoro successivo.

Il grafo conserva ciò che il corso si impegna a insegnare, i concetti coinvolti, i prerequisiti e gli obiettivi delle attività. La diagnosi conserva ciò che è stato dichiarato o osservato. Il collegamento fra questi artefatti permette al pianificatore di motivare un punto iniziale senza trasformare una risposta circoscritta in conoscenza generale.

- [Autorità e ingressi](#autorità-e-ingressi)
- [Modello verificato nel codice](#modello-verificato-nel-codice)
- [Vocabolario](#vocabolario)
- [Schema concettuale minimo](#schema-concettuale-minimo)
- [Collegamento dalla diagnosi](#collegamento-dalla-diagnosi)
- [Riuso fra corsi dello stesso account](#riuso-fra-corsi-dello-stesso-account)
- [Punto iniziale e composizione delle lezioni](#punto-iniziale-e-composizione-delle-lezioni)
- [Responsabilità e interfacce](#responsabilità-e-interfacce)
- [Persistenza e ciclo di vita](#persistenza-e-ciclo-di-vita)
- [Compatibilità delle definizioni storiche](#compatibilità-delle-definizioni-storiche)
- [Transizione e parti implementabili](#transizione-e-parti-implementabili)
- [Decisioni residue](#decisioni-residue)
- [Casi di verifica](#casi-di-verifica)

## Autorità e ingressi

Il [commento decisionale di #119](https://github.com/immagiov4/Nous/issues/119#issuecomment-5452537922) prevale sulle alternative esplorative nel corpo della issue. Stabilisce artefatti diagnostico e curricolare separati, identità dei concetti riusabili nel prodotto, obiettivi locali a corso e lezione, estensioni additive con origine e motivazione. Esclude versionamento reversibile generale del corso. La [roadmap #169](https://github.com/immagiov4/Nous/issues/169) colloca questo contratto dopo la riconciliazione degli ingressi e prima del nucleo delle attività.

Gli ingressi riconciliati sono il contratto e la proposta operativa di [#85](https://github.com/immagiov4/Nous/issues/85) e la consegna diagnostica di [#112](https://github.com/immagiov4/Nous/issues/112). Le decisioni applicabili sono riportate nelle sezioni seguenti.

La precisazione finale #85 mantiene fissi obiettivo e ambito del corso. Approfondimento e granularità hanno un valore esplicito `auto`, centrale e predefinito: segue la fonte quando presente, altrimenti indica un riferimento bilanciato. Le scelte manuali sono relative a quel riferimento. Il grafo conserva il riferimento all'ingresso approvato senza assegnare una metrica a queste preferenze. L'approfondimento sviluppa il fuoco corrente con conoscenze disponibili; la granularità cambia quanto materiale viene affrontato insieme a copertura e collegamenti invariati. Le formulazioni esplorative precedenti sulla destinazione variabile sono superate.

La decisione dell'utente sul riuso, approvata tramite l'orchestratore il 10 settembre 2026, stabilisce la consultazione progressiva dei corsi dello stesso account: elenco e descrizioni, grafi dei corsi plausibilmente pertinenti, confronto dei concetti, quindi sole prove necessarie quando la corrispondenza è fondata. La pianificazione di nuovi corsi e lezioni può usare queste prove mantenendo provenienza, condizioni e dubbi. #120 possiede il registro cronologico trasversale, #121 le decisioni consentite. Questo chiarimento estende il contesto consultabile; le osservazioni conservano il corso di origine e i confini descritti sotto.

Il [manifesto locale](../01-section-overview/02-p-manifesto.md) richiede un percorso comprensibile, propedeutico e circoscritto al contenuto pertinente. I commenti decisionali di [#91](https://github.com/immagiov4/Nous/issues/91#issuecomment-5452550263), [#39](https://github.com/immagiov4/Nous/issues/39#issuecomment-5452549189), [#120](https://github.com/immagiov4/Nous/issues/120#issuecomment-5452549724) e [#121](https://github.com/immagiov4/Nous/issues/121#issuecomment-5452551305) definiscono i consumatori: criteri legati a obiettivi precisi, tentativi conservati, registro cronologico e proposte motivate con riferimenti. Le ipotesi di punteggio globale e quote fisse nei testi esplorativi non sono il contratto da implementare.

Questa proposta deriva dai requisiti approvati e dal codice. Non introduce una nuova affermazione scientifica o una politica pedagogica da giustificare mediante ricerca esterna.

## Modello verificato nel codice

L'approvazione della proposta nell'intervista avvia la generazione sul server. La preparazione legge il progetto e la sua revisione, recupera `userProfile` e trasforma la conversazione in `assessmentSummary`. Il processo distingue `learn`, `single-source`, `source-set` e `archive`. I pianificatori producono una proposta grezza; il verificatore valuta copertura, granularità, progressione, coesione, duplicazione, prerequisiti e proporzionalità. Il piano raffinato passa poi per fonti, collocazione degli esercizi e salvataggio.

Il risultato comprende `plan`, `researchCoursePlan` e `syllabus`. `buildCoursePlanOutput` genera identificatori posizionali come `module-1-lesson-1`. Il piano grezzo contiene `keyConcepts` e `prerequisites` come liste di testo. Il contesto della lezione conserva concetti, domande guida e altri dettagli; i prerequisiti restano strutturati soltanto nel piano di ricerca della modalità `learn`. Le strategie documentali producono `researchCoursePlan: null` e `syllabus: []`.

La generazione della lezione compone il contesto da descrizione, `contextPrompt`, profilo, programma e piano di ricerca. `readPreviousLessonTitles` legge tutti i figli completati, compresi eventuali esercizi; quel dato esprime completamento del percorso. La #119 richiede invece relazioni esplicite per descrivere quali capacità servono nel punto corrente. Il completamento rimane distinto dalle prove di apprendimento.

Il salvataggio del corso controlla revisione, unicità degli identificatori e presenza di una lezione leggibile. Scrive piano, profilo e proiezioni nella transazione del processo, conservando un'impronta e i dati per un ripristino protetto. Il client applica la revisione salvata. Il formato di trasporto del progetto ha una propria versione e un elenco di campi ammessi: il contenitore JSONB non rende automaticamente compatibile un nuovo campo.

| Evidenza | Fonte nel codice |
| --- | --- |
| Approvazione e applicazione della revisione | [assessmentPlanning.ts](../../../apps/web/hooks/workspace/controller/assessmentPlanning.ts#L1294), [runDurableCourse](../../../apps/web/hooks/workspace/controller/assessmentPlanning.ts#L452) |
| Preparazione e strategie | [courseGenerationPreparation.ts](../../../apps/backend/src/workflows/courseGenerationPreparation.ts#L83) |
| Lezione grezza, lezione salvabile e piano | [courseGenerationWorkflowContract.ts](../../../apps/backend/src/workflows/courseGenerationWorkflowContract.ts#L63), [CourseLessonSchema](../../../apps/backend/src/workflows/courseGenerationWorkflowContract.ts#L110), [CourseLearningPlanSchema](../../../apps/backend/src/workflows/courseGenerationWorkflowContract.ts#L218) |
| Identificatori e trasformazione | [courseGenerationPlanning.ts](../../../apps/backend/src/workflows/courseGenerationPlanning.ts#L100) |
| Verifica semantica e coerenza strutturale | [coursePlanVerification.ts](../../../apps/backend/src/workflows/coursePlanVerification.ts#L49) |
| Obiettivo testuale dell'esercizio e collocazione per modulo | [courseExercisePlanning.ts](../../../apps/backend/src/workflows/courseExercisePlanning.ts#L74) |
| Contesto delle lezioni e completamento | [lessonGenerationPreparation.ts](../../../apps/backend/src/services/lessonGenerationPreparation.ts#L45), [lessonGenerationPrompt.ts](../../../apps/backend/src/services/lessonGenerationPrompt.ts#L58) |
| Scrittura e ripristino protetti | [courseGenerationPersistence.ts](../../../apps/backend/src/workflows/courseGenerationPersistence.ts#L63) |
| Formato del progetto e ricostruzione client | [projectSnapshotWire.ts](../../../packages/shared-types/projectSnapshotWire.ts), [projectSnapshot.ts](../../../apps/web/services/projects/projectSnapshot.ts#L742) |

`parentId` indica un modulo nel piano `learn` e la lezione madre negli approfondimenti. `type: prerequisite` classifica una lezione o un modulo; nessuno dei due campi identifica una relazione di prerequisito fra capacità. `assessedObjective` è testo, non un'identità condivisa. Il registro delle capacità degli agenti appartiene all'esecuzione tecnica, non al vocabolario curricolare.

Graphify non dispone di `graph.json` in questa copia. `graphify reflect --if-stale` ha prodotto un riepilogo senza memorie. La mappa qui riportata deriva dalla lettura delle fonti e dai due riscontri paralleli in sola lettura.

## Vocabolario

Il vocabolario seguente appartiene alla proposta #119. La descrizione del sistema esistente rimane nelle pagine Cubic pertinenti.

| Termine | Significato |
| --- | --- |
| Concetto | Contenuto o capacità disciplinare con identità riusabile e ambito esplicito. Il titolo è una rappresentazione del concetto. |
| Obiettivo di apprendimento | Prestazione osservabile che il corso o una lezione si impegna a costruire, con condizioni e criterio di riuscita. |
| Grafo curricolare | Insieme degli obiettivi, dei concetti e delle relazioni che descrivono il corso progettato. |
| Ruolo del concetto nella lezione | Uso previsto del concetto, assunto, richiamato per orientare, introdotto o sviluppato. È una proprietà dell'insegnamento previsto. |
| Prerequisito | Capacità specifica su un concetto necessaria per affrontare un obiettivo nel contesto del corso. |
| Programma | Ordine visibile dei moduli, delle lezioni e degli esercizi. Può raggruppare più concetti e obiettivi. |
| Nodo diagnostico | Argomento locale della raccolta iniziale. Il genitore esprime contenimento tematico. |
| Claim diagnostico | Capacità che un compito intende osservare entro un ambito dichiarato. |
| Evidenza | Parte identificabile della prestazione, nelle condizioni effettive, usata per interpretare un criterio. |
| Corrispondenza diagnostica | Relazione motivata fra un elemento della diagnosi e uno o più elementi curricolari, con limiti espliciti. |
| Punto iniziale | Proposta di ingresso nel percorso sostenuta da prove, dichiarazioni e lacune pertinenti. |
| Opportunità di evidenza | Attività pianificata per far emergere una prestazione su un obiettivo. Precede la sua istanza concreta e i tentativi. |
| Estensione curricolare | Aggiunta collegata al corso stabile, con origine, lezione madre, motivo ed elementi aggiunti. |

La stessa identità di concetto può comparire in più corsi. La pianificazione può consultare dichiarazioni e prove degli altri corsi dello stesso account attraverso riferimenti alle registrazioni originali. Obiettivi con testo simile restano locali ai rispettivi corsi o lezioni; il riuso di un concetto non unifica i loro criteri di riuscita.

## Schema concettuale minimo

Il contratto proposto è un aggregato tipizzato. Evita un motore generico di nodi e archi: ogni relazione ha campi e validazioni propri. Gli identificatori sono opachi e assegnati dal server; l'ordine di un array o il titolo non ne determina l'identità.

| Registrazione proposta | Contenuto minimo | Invariante |
| --- | --- | --- |
| `ConceptDefinition` | `conceptId`, definizione e ambito, origine della definizione | Il riuso riferisce la stessa definizione risolvibile. Cambiare capacità o significato non riscrive un concetto già referenziato. |
| `CourseCurriculum` | `curriculumId`, versione del formato, identità del progetto e della sua incarnazione, `planningInputRef`, concetti, obiettivi e relazioni | Un solo nucleo pubblicato per il corso. Il riferimento all'ingresso risolve la proposta approvata #85. |
| `LearningObjective` | `objectiveId`, proprietario corso oppure lezione, prestazione, condizioni, criterio di riuscita, origine | L'obiettivo appartiene a quel curriculum. Il criterio descrive l'obiettivo; la rubrica di un compito resta del nucleo #91/#124. |
| `ObjectiveConceptLink` | `objectiveId`, `conceptId`, aspetto del concetto richiesto dall'obiettivo, motivo e origine | L'obiettivo può riguardare più concetti, con contributi espliciti. |
| `LessonConceptUse` | `useId`, `lessonId`, `conceptId`, `role`, ambito trattato, motivo e origine | Il ruolo si riferisce a quella lezione e a quell'aspetto del concetto. |
| `LessonObjectiveLink` | `lessonId`, `objectiveId`, contributo della lezione | Può distribuire un obiettivo del corso su più lezioni. Un obiettivo di lezione appartiene alla lezione dichiarata. |
| `PrerequisiteRequirement` | `requirementId`, `forObjectiveId`, `conceptId`, capacità richiesta, motivo e origine | Esprime che cosa serve per affrontare quell'obiettivo. Non dichiara che il discente lo possiede. |
| `PrerequisitePreparation` | `requirementId`, `dependentLessonId`, usi e obiettivi della lezione preparatoria oppure associazioni diagnostiche pertinenti, motivo e limiti | Registra la preparazione proposta per quel requisito. Può conservare una lacuna irrisolta. |
| `PlannedActivityTarget` | `activityPlanId`, posizione prevista nel corso, `objectiveId`, prestazione da osservare, motivo e origine | Collega l'attività pianificata all'obiettivo prima della risposta. Più righe possono riferire la stessa attività. |
| `CurriculumExtension` | `extensionId`, `curriculumId`, `parentLessonId`, origine, motivo, elementi e relazioni aggiunti | Conserva il nucleo e le precedenti aggiunte. |

`role` usa i significati `assumed`, `oriented`, `introduced`, `developed`. Sono etichette interne senza ordinamento numerico. Introduzione e sviluppo possono coesistere nella medesima lezione. Assumere un aspetto e svilupparne un altro richiede due usi con ambiti distinti. Un richiamo orientativo non soddisfa automaticamente un prerequisito.

La relazione di prerequisito termina su un obiettivo locale. Questa scelta circoscrive l'affermazione pedagogica: la familiarità con un concetto può bastare per un obiettivo e non per un altro. Una relazione universale fra due titoli di concetto perderebbe questa distinzione. La proposta conserva quindi capacità richiesta e motivo, senza attribuire difficoltà intrinseca al concetto.

`PrerequisitePreparation` distingue `planned-in-course`, `entry-assumption` e `unresolved`. Il primo riferisce `providerLessonId`, `useIds` e `objectiveIds`; il secondo le `mappingIds` diagnostiche oppure i collegamenti alle prove di altri corsi, sempre con limiti; il terzo il requisito ancora da risolvere. In tutti i casi sono obbligatori motivo e origine. La variante `entry-assumption` registra un'assunzione motivata della pianificazione, non un requisito certificato dalla diagnosi o dal completamento di un altro corso. Il validatore non sceglie la variante e non trasforma un uso `developed` in preparazione sufficiente.

La collocazione nel programma può motivare come preparare un requisito mediante una lezione precedente. La pianificazione deve riferire gli usi e gli obiettivi pertinenti. La verifica dell'ordine fra lezioni è deterministica quando questi riferimenti sono espliciti; l'adeguatezza della preparazione resta un giudizio semantico documentato. Per passaggi nella stessa lezione serve la verifica del loro ordine nel contenuto. L'uguaglianza di `conceptId` da sola non prova che la capacità richiesta sia stata insegnata.

I cicli si valutano sulla relazione che significa precedenza obbligatoria. Le altre relazioni del grafo, comprese quelle molti-a-molti fra lezioni e concetti, possono formare percorsi chiusi senza contraddizioni didattiche. Un validatore che rifiutasse qualunque ciclo del grafo confonderebbe queste semantiche.

Le relazioni `planned-in-course` fra lezioni diverse dichiarano una precedenza verificabile con l'ordine del programma. Se preparazione e uso sono nella stessa lezione, il controllo è semantico sul contenuto e viene segnalato come tale. Un requisito `unresolved` resta tale anche con una struttura formalmente valida: la politica #121 deve decidere come affrontarlo prima di presentare il percorso come adeguatamente preparato.

Ogni riferimento a lezione usa `curriculumId` e `lessonId`; il solo identificatore posizionale storico non è sufficiente. Dopo la pubblicazione, identità e significato degli obiettivi rimangono stabili. Le estensioni aggiungono propri identificatori senza riassegnare quelli esistenti. Una lettura per una proposta conservata identifica il nucleo e le specifiche `extensionIds` usate, così una nuova aggiunta non cambia il contesto di una decisione precedente. Questo è un riferimento agli elementi, non un sistema di revisioni concorrenti del corso.

La futura istanza concreta di un'attività riferisce `activityPlanId` e gli obiettivi previsti. I suoi criteri appartengono ciascuno a un obiettivo preciso, secondo #91/#124. Posizione della scheda, indice nel testo o uguaglianza della consegna non sostituiscono questo collegamento.

L'origine di un elemento generato deve risolvere il risultato conservato, il modello e l'esecuzione pertinente. Una fonte documentale si collega alla relazione o all'obiettivo che sostiene, attraverso i riferimenti alle fonti già esistenti e il loro contenuto immutabile. La provenienza di una definizione e la copertura delle pagine del corso sono responsabilità distinte. Un'associazione proveniente da ripiego nella mappatura delle fonti conserva tale origine e non certifica correttezza curricolare.

## Collegamento dalla diagnosi

La #119 importa i tipi posseduti da #112. La vista effettiva usa `planningView.nodes`, `collectionEnd`, `missingInformation` e `conflicts`; i nomi esemplificativi precedenti nella #85 non diventano una seconda definizione del contratto.

Il modulo riceve `assessmentRef = { diagnosticId, revisionId }` e risolve `selfReportRef`, `evidenceRef` e `collectionContextRef` nel medesimo ambito autorizzato. La revisione diagnostica deve rimanere disponibile oltre la conservazione dei registri operativi. Il risolutore consegna al modello il contenuto pertinente con i riferimenti, non soltanto gli identificatori opachi.

Una `DiagnosticCurriculumMapping` appartiene al curriculum e riferisce la revisione diagnostica. Ogni voce ha `mappingId`, origine, motivo, limiti e una sorgente discriminata:

| Sorgente | Riferimenti obbligatori |
| --- | --- |
| Nodo | Revisione diagnostica e `nodeId` |
| Dichiarazione | Revisione, `nodeId`, `selfReportId`, `selfReportRef` |
| Osservazione per criterio | Revisione, `nodeId`, `taskId`, `attemptId`, `interpretationId`, `claimId`, `criterionId`, `evidenceRef` |

Per un compito riferito a più nodi, le associazioni mantengono i nodi effettivi del compito. Il validatore accerta che interpretazione, criterio, claim e tentativo appartengano allo stesso episodio. `claim.scope` arriva dalla risoluzione di `evidenceRef` e conserva la capacità specifica osservata; l'ambito più ampio del nodo non lo sostituisce.

L'esito del collegamento distingue questi casi:

| Esito proposto | Contenuto | Uso consentito |
| --- | --- | --- |
| `not-reviewed` | Sorgente e stato di elaborazione | Segnala lavoro ancora da esaminare. |
| `unmatched` | Sorgente, motivo, origine e limiti | Rende esplicita l'assenza di corrispondenza riconosciuta. |
| `matched` | Uno o più destinatari confermati dalla proposta, ciascuno con motivo e ambito del collegamento | Permette di reperire gli elementi pertinenti, mantenendo la natura della sorgente. |
| `ambiguous` | Gruppi alternativi di destinatari candidati, con motivazioni e dubbio irrisolto | Conserva alternative senza selezionarne una. |

Ogni destinatario è `{ kind: 'concept', conceptId }` oppure `{ kind: 'objective', objectiveId }`. Un collegamento confermato con due destinatari significa che entrambi sono pertinenti; due alternative ambigue non significano che entrambi siano confermati. La parola `matched` descrive la corrispondenza proposta, non padronanza, affidabilità statistica o raggiungimento dell'obiettivo.

La vista conserva l'elenco delle sorgenti ricevute e il loro stato di collegamento. Una sorgente omessa dal risultato resta non esaminata, mai trasformata in `unmatched`. Una diagnosi `not-collected` rende il collegamento non applicabile; un artefatto atteso ma irrisolvibile produce un errore esplicito e non viene trattato come assenza di raccolta.

Invarianti del raccordo:

1. Due titoli uguali non producono uguaglianza di identità.
2. Una relazione genitore-figlio diagnostica non produce prerequisiti né collegamenti ai discendenti.
3. Il collegamento di un nodo non collega automaticamente tutte le sue prove. Ogni prova mantiene claim e criterio.
4. Una dichiarazione rimane una dichiarazione anche quando il suo destinatario è un obiettivo preciso.
5. Il modello può motivare una corrispondenza semantica; il server controlla identità, ambiti e provenienza. La validità strutturale non certifica il giudizio semantico.
6. Correzioni del raccordo conservano l'associazione usata dalle precedenti proposte. L'identità di un'associazione già referenziata non cambia significato.
7. Lacune, contrasti, aiuti e condizioni delle prestazioni restano risolvibili. Nessuna preferenza risolve un contrasto fra evidenze.

### Esempio circoscritto

Il nodo diagnostico parla di equazioni lineari. Il compito chiede di risolvere `2x + 3 = 11` mantenendo l'equivalenza dei passaggi. Un'interpretazione osserva che la risposta `2x = 11 + 3; x = 7` viola quel criterio.

Il raccordo può collegare l'osservazione al concetto di trasformazione equivalente e a un obiettivo locale che richiede di giustificare il passaggio. Mantiene compito, criterio, risposta e limite del singolo caso. Un obiettivo sulle equazioni differenziali rimane distinto anche se una sua etichetta contiene la parola «equazioni». L'autovalutazione di autonomia resta una sorgente separata; il raccordo non sceglie quale delle due informazioni debba prevalere.

## Riuso fra corsi dello stesso account

Per preparare un corso di fisica, il pianificatore può trovare che un precedente corso di analisi tratta derivate e integrali. Apre quel grafo, confronta i concetti con le capacità richieste dalla nuova lezione e chiede le prove collegate. Una risposta precedente sul calcolo di una derivata può informare la spiegazione della velocità; lascia da valutare la capacità di interpretare quella derivata nel problema fisico. Una risposta data dopo un suggerimento mantiene quell'aiuto nel suo contesto.

Il catalogo privato per account acquista così una funzione concreta. Le identità aiutano a trovare materiale e prove già pertinenti, mentre ogni corso conserva obiettivi, programma e tentativi propri. Il chiarimento mantiene il confine privato del catalogo e amplia l'uso delle letture rispetto alla prima proposta, che considerava soprattutto la diagnosi del corso corrente.

### Scoperta progressiva

1. Il pianificatore riceve l'elenco dei corsi dell'account con titolo, descrizione conservata, riferimento al curriculum e disponibilità del grafo. La descrizione deriva dal piano salvato, non da un riassunto delle capacità del discente. Un corso storico privo di descrizione o grafo conserva l'assenza esplicita.
2. Confronta quelle descrizioni con la richiesta del nuovo corso o gli obiettivi della lezione corrente. Indica quali corsi sono plausibilmente pertinenti e motiva la richiesta dei rispettivi grafi. Un nome simile è un indizio per cercare, non una corrispondenza concettuale. I corsi non esaminati restano distinguibili da quelli esaminati senza risultati pertinenti.
3. Il server carica soltanto i grafi richiesti e autorizzati. Il pianificatore legge definizioni, ambiti, obiettivi e relazioni e registra le corrispondenze considerate. Può chiedere un altro grafo se dal confronto emerge una dipendenza pertinente, mantenendo la ragione della nuova richiesta.
4. Per le corrispondenze fondate, il recupero chiede al registro #120 le osservazioni collegate nel corso originale. Risolve anche compito, criteri, tentativi precedenti pertinenti, aiuti e contesti necessari a interpretarle. La richiesta riferisce corso e identità specifiche, evitando una ricerca libera su tutta la cronologia dell'account.
5. La pianificazione usa il materiale risolto per motivare il punto iniziale o la preparazione della lezione. Cita corrispondenze e prove effettivamente utilizzate, distinguendo sostegno, dubbi e conflitti. La #121 governa quale azione sia ammessa sulla base di queste informazioni.

Questa è la sequenza approvata dall'utente, descritta senza graduatorie, soglie di somiglianza o numero massimo di corsi. La scoperta può mancare un corso utile se la descrizione è insufficiente o il giudizio del modello è errato: perciò conserva ciò che è stato esaminato e il limite della ricerca. La mancata scoperta non certifica l'assenza di conoscenze precedenti.

Le fasi di scoperta non sono una paginazione del materiale probatorio già selezionato. Una volta individuata una prova, il contesto necessario a interpretarla deve arrivare integro. Non si scelgono soltanto i tentativi positivi o gli ultimi tentativi. Se il materiale pertinente non entra nel contesto disponibile, il problema resta esplicito; questa proposta non introduce tagli automatici, graduatorie o riassunti del modello per nasconderlo.

Nel codice, [GET /projects](../../../apps/backend/src/routes/projects.ts#L519) usa già l'account autenticato e [listProjectsWithClient](../../../apps/backend/src/projects/postgresProjectStore.ts#L426) legge i metadati, separatamente dallo stato completo. Il contratto [SavedProjectMeta](../../../packages/shared-types/projectContract.ts#L39) include titolo e dati della biblioteca, ma non una descrizione curricolare o un riferimento al grafo. La futura vista di scoperta deve quindi proiettare titolo e sintesi del piano con la loro provenienza e disponibilità. L'ordine recente della biblioteca non costituisce una graduatoria di pertinenza per il pianificatore.

### Identità, corrispondenza e utilizzabilità della prova

Sono tre verifiche distinte. Un `conceptId` già condiviso identifica la stessa definizione. Il collegamento al nuovo obiettivo precisa quale aspetto sia pertinente. L'interpretazione della prova stabilisce che cosa la risposta precedente permetta di sostenere nelle condizioni attuali. Superare il primo passaggio non risolve gli altri due.

Quando gli identificatori sono diversi, il confronto considera definizioni, ambiti e capacità effettivamente richieste. Il pianificatore rende esplicito se sostiene la stessa identità concettuale oppure soltanto una sovrapposizione circoscritta. Un'evidenza su una parte comune può essere utile senza unificare i due concetti. Una prestazione nel contesto precedente non dimostra automaticamente trasferimento al nuovo contesto.

Il contratto proposto `CrossCourseAlignment` conserva origine della valutazione, riferimento al curriculum sorgente, concetto o obiettivo sorgente, destinatario del corso corrente, ambito comune, differenze e motivo. Riusa i significati `matched`, `ambiguous`, `unmatched` e `not-reviewed` del raccordo diagnostico. Nel caso `matched` distingue la stessa identità concettuale da una sovrapposizione parziale e registra i limiti della valutazione; nel caso `ambiguous` mantiene le alternative senza sceglierne una. Il server verifica riferimenti e ambiti autorizzati, mentre l'esattezza del confronto rimane una valutazione semantica verificabile.

«Sufficientemente fondata» non diventa una percentuale. La corrispondenza deve essere esaminabile attraverso definizioni confrontate, capacità interessata, motivazione e limiti. La successiva proposta pedagogica deve spiegare perché quella prova, con quelle condizioni, sia pertinente al nuovo obiettivo. I due argomenti rimangono separati e nessun esito strutturale impone di omettere contenuto.

Una relazione contestuale può citare due identità esistenti senza riscriverle. Se il nuovo corso riferisce un concetto già identificato nel catalogo dell'account, riusa quel `conceptId` con il collegamento motivato. Una sovrapposizione parziale mantiene identità distinte. La nuova corrispondenza non fonde retroattivamente concetti, obiettivi o tentativi. L'approvazione del riuso rende questo collegamento parte del meccanismo di pianificazione; un sistema generale di fusione e riscrittura del catalogo esistente rimane estraneo al blocco proposto.

### Vista trasversale e provenienza

La vista trasversale è il risultato di letture autorizzate, non un nuovo archivio delle conoscenze. Ogni prova rimane identificata dal corso sorgente e dalla sua incarnazione, dall'attività e dal tentativo, dal criterio applicato e dall'interpretazione conservata. I collegamenti al curriculum corrente stanno nella proposta che li usa. Le osservazioni sorgenti non vengono riassegnate all'obiettivo nuovo.

Per ogni uso, la proposta conserva un riferimento alla corrispondenza e ai dati che hanno influito sulla decisione: obiettivo sorgente, criterio, evidenza, data del tentativo e dell'interpretazione, contesto effettivo, aiuti, eventuali esposizioni precedenti, valutatore e limiti. La data resta informazione cronologica; questa proposta non stabilisce scadenza o decadimento delle prove. La data di lettura non sostituisce quella della prestazione.

La stessa osservazione raggiunta attraverso più concetti compare come un solo riferimento con più collegamenti. Tentativi diversi restano distinti anche quando la risposta è identica. Osservazioni discordanti di corsi diversi rimangono reperibili con la rispettiva cronologia: nessuna fusione in un punteggio, nessun vincitore automatico in base alla data e nessuna supposizione di indipendenza fra tentativi.

Il corso in cui una prova è stata registrata determina dove la prova vive; l'account determina chi può leggerla. Il curriculum determina il contenuto pertinente; la proposta #121 registra l'interpretazione relativa alla decisione corrente. Anche una diagnosi nuova può contraddire prove precedenti: il pianificatore conserva il contrasto invece di aggiornare un profilo globale del discente.

### Confini con #120 e #121

Il commento approvato della #120 stabilisce una cronologia locale al corso e consente il recupero di osservazioni pertinenti preservando identità, ordine e divergenze. La decisione successiva dell'utente assegna alla #120 il registro cronologico trasversale dell'account: consulta le sequenze conservate nei corsi di origine e ne mantiene la provenienza. La #119 fornisce identità e corrispondenze necessarie a formulare quelle richieste; #39 e #120 rimangono proprietari di tentativi e prove.

Il commento della #121 descrive un contesto di decisione con evidenze locali e vieta tagli automatici del materiale pertinente. Il chiarimento estende le origini consultabili anche agli altri corsi dell'account. La proposta pedagogica mantiene riferimenti, ragione, limiti e azioni ammesse. Gli obiettivi del corso stabile e le evidenze già raccolte conservano il loro significato.

La riconciliazione documentale richiesta riguarda quindi il perimetro delle letture di #120/#121, non la trasformazione del registro in uno stato globale. Per implementare il recupero serviranno i loro contratti concreti. La #119 può prima definire riferimenti qualificati, corrispondenze e interfacce per la scoperta dei corsi e la lettura dei grafi, senza anticipare valutazione dei tentativi o politiche di adattamento.

## Punto iniziale e composizione delle lezioni

Il pianificatore produce una `CourseEntryProposal` legata a `planningInputRef`, curriculum e raccordi effettivamente usati. La proposta riferisce gli obiettivi o gli usi concettuali da cui partire, le associazioni diagnostiche e le prove di altri corsi che l'hanno influenzata, i prerequisiti pertinenti, il motivo e i dubbi residui. Se la diagnosi del nuovo corso manca, conserva quell'assenza anche quando esistono prove provenienti da altri corsi.

Questa struttura registra una proposta, non un algoritmo di selezione. Le eventuali decisioni di omissione, compressione e preparazione appartengono alla politica del corso in #121. Nessuna categoria dichiarata o corrispondenza ai concetti produce automaticamente un'azione sul programma.

Per la generazione della lezione servono gli obiettivi pertinenti, gli usi dei concetti, i prerequisiti richiesti, la loro collocazione nel programma e il contesto #85. Il sistema mantiene separati ciò che è previsto prima, ciò che è stato presentato e ciò che è stato osservato in un tentativo. I titoli delle lezioni completate possono integrare il contesto precedente; non sono la prova che una capacità sia posseduta.

L'approfondimento confronta sviluppi dello stesso fuoco con l'ambito fissato. Ogni sviluppo dichiara quale aspetto chiarisce e su quali conoscenze si appoggia. Recuperare una base mancante, anticipare un obiettivo successivo o aprire un altro tema richiede una decisione distinta. La granularità confronta distribuzioni diverse degli stessi impegni del corso, mantenendo riconoscibili copertura e collegamenti.

Prima della pubblicazione, un raggruppamento diverso può modificare le lezioni e i loro obiettivi locali. Gli impegni del corso e i concetti mantengono riferimenti confrontabili; il confronto semantico verifica che nessun impegno sia scomparso. Dopo la pubblicazione, il nucleo rimane stabile. Queste alternative di progettazione non sono revisioni concorrenti di un corso già pubblicato.

Il numero di concetti, archi, lezioni o collegamenti non misura difficoltà, profondità o distanza dallo studente. La #85 possiede la forma e il dominio dei controlli; la #119 rende esplicito ciò che i confronti devono preservare.

## Responsabilità e interfacce

| Proprietario | Responsabilità | Consumatori |
| --- | --- | --- |
| #85 | `CoursePlanningInput`, intento finale, ambito, contesti immutabili e preferenze risolte | Diagnosi, pianificazione, generazione e verifica |
| #112 | Artefatto diagnostico, riferimenti e vista minima | Raccordo #119 e pianificazione |
| #119, modulo curricolare | Identità e definizioni curricolari private per account, relazioni tipizzate, raccordi, descrizioni dei corsi, lettura selettiva dei grafi e integrità strutturale | Piano, lezioni, #91/#124, #39, #120, #121 |
| Pianificazione del corso | Produzione del candidato e del punto iniziale motivato | Verificatore e persistenza |
| Verificatore del piano | Valutazione pedagogica sulle relazioni esplicite e sullo stesso ingresso del generatore | Raffinamento già esistente |
| #91/#124 | Scopo, compito, rubrica, istanze e corrispondenza criterio-obiettivo | #39 e #120 |
| #39 | Conservazione dell'esecuzione, dei tentativi e dei riferimenti alla rubrica applicata | Diagnosi e registro delle evidenze |
| #120 | Registro cronologico trasversale dell'account, con osservazioni conservate nei corsi di origine e recupero autorizzato per riferimenti | #121 e viste eventuali |
| #121 | Proposte per corso, lezione e transizione entro azioni ammesse, usando anche prove pertinenti di altri corsi dello stesso account | Generazione e adattamenti autorizzati |

Collocazione proposta: i contratti comuni in `packages/shared-types`, il modulo curricolare e il raccordo nel backend, gli archivi durevoli accanto agli altri archivi di progetto. Il modulo espone operazioni per responsabilità, senza un registro universale di nodi né un'interfaccia diversa per ogni chiamante.

- `validateCurriculum` riceve candidato, definizioni risolte e piano di riferimento. Restituisce esito strutturale e violazioni con identificatori pertinenti. Controlla unicità, ambiti, riferimenti e relazioni esplicite; non classifica testo.
- `validateDiagnosticMapping` riceve associazioni, revisione diagnostica risolta e curriculum. Controlla la catena dei riferimenti e gli stati del raccordo. Non sceglie identità concettuali.
- `loadCurriculumContext` riceve proprietario autenticato, corso e riferimento richiesto. Risolve il contratto e la sua disponibilità storica. Un consumatore non deve ricostruire relazioni da `contextPrompt`.
- La pubblicazione avviene nel coordinamento transazionale della generazione. Un'estensione usa una scrittura additiva con identità della richiesta e curriculum di destinazione verificati.

Sono interfacce progettuali, da tradurre nei tipi concreti dopo revisione. Il nucleo puro di validazione è il primo punto verificabile senza modello o database. Gli archivi e il coordinamento restano distinti perché gestiscono autorizzazione, transazione e ripresa.

## Persistenza e ciclo di vita

La proposta tecnica conserva separatamente definizioni dei concetti e curriculum del corso. Per il curriculum, un documento tipizzato in una registrazione dedicata mantiene insieme obiettivi e relazioni. Le estensioni hanno registrazioni additive. L'alternativa di una tabella per ogni arco offre vincoli relazionali più granulari, ma moltiplica scritture e caricamenti senza un consumatore che richieda ancora interrogazioni globali degli archi.

Il contratto di scrittura richiede:

- identità del proprietario autenticato e della specifica incarnazione del progetto, oltre alla revisione attesa;
- piano e curriculum pubblicati nella stessa transazione, con riferimenti validi e origine della generazione;
- unicità del nucleo per corso e identità della richiesta per il riesame di un esito già salvato;
- rifiuto esplicito di una richiesta già usata con dati incompatibili;
- notifica della revisione dopo la scrittura autorevole;
- protezione contro un processo precedente che tenti di modificare un progetto eliminato e ricreato con lo stesso `projectId`.

Il ripristino tecnico di una pubblicazione fallita riguarda soltanto gli elementi di quella operazione ancora autorevoli. Conserva le protezioni esistenti contro modifiche successive. Non fornisce un comando di ritorno a una precedente versione pedagogica del corso.

Il formato di lettura distingue curriculum disponibile, assente nel formato storico ed errore di integrità. Un corso storico non riceve un grafo vuoto presentato come completo. Per un nuovo corso che richiede il grafo, un riferimento irrisolvibile è un errore, non un ritorno silenzioso al percorso testuale.

Il catalogo dei concetti è privato per account e rende riusabili identità e definizioni fra i suoi corsi. Le prove del discente, le fonti private del corso e le motivazioni personali restano nei record locali autorizzati; il recupero trasversale le risolve per riferimento. Ogni lettura di corso, grafo e prova verifica sul server lo stesso proprietario autenticato. La visibilità fra utenti resta fuori da questo contratto. Il riuso cita l'identità esistente oppure conserva una relazione circoscritta; preserva le registrazioni precedenti.

I riferimenti alla diagnosi, al contesto #85, ai compiti e alle origini devono risolvere contenuti immutabili indipendenti dalla pulizia dei registri operativi. Conservare soltanto un identificatore di evento temporaneo non soddisfa il contratto. La #119 conserva il proprio raccordo e importa i riferimenti della #112, evitando un secondo archivio delle risposte.

Eliminare corso o account rimuove curriculum locale, raccordi, estensioni e dati diagnostici locali secondo il contratto dei rispettivi proprietari. Una definizione riusata da un altro corso dello stesso account non viene eliminata in cascata insieme al singolo corso. L'eliminazione dell'account comprende il suo catalogo privato. Una prova rimossa dal corso di origine non resta in vita in una copia del nuovo corso: i suoi riferimenti diventano indisponibili e il consumatore deve distinguere tale stato dall'assenza di conoscenza. La propagazione dell'indisponibilità alle decisioni conservate va coordinata con #39/#120/#121.

Esportazione e importazione devono distinguere contenuto curricolare e prove personali. Condividere un corso non include le prove degli altri corsi consultati. La portabilità personale richiede un ambito esplicito e riferimenti risolvibili o una rimappatura dichiarata. Il codec del progetto, la ricostruzione client e i salvataggi da client precedenti vanno verificati insieme. La libertà del campo `extensions` non sostituisce questo contratto.

## Compatibilità delle definizioni storiche

Un campo facoltativo cambia comunque lo schema serializzato. La compatibilità richiede che schemi e impronte delle definizioni storiche rimangano identici. La capacità del parser corrente di accettare un vecchio oggetto non dimostra questa proprietà.

| Definizioni registrate | Confine da preservare |
| --- | --- |
| Corso corrente, precedente alle preferenze e topologia precedente alla verifica | `CourseLearningPlanSchema`, schemi grezzi, stati, effetti del fornitore, nodi e identità di compatibilità |
| Intervista corrente, precedente alle preferenze con salvataggio `commit`, precedente con salvataggio `run` | Ingresso, proposta, segnali, attese, stato e punto del salvataggio |
| Lezione corrente, precedenti a spiegazione quiz, contratto di ricerca e `sourceHash` | Ingresso didattico, contesto, piano delle sottolezioni, bozze, risultati ed effetti |
| Riparazione PDF corrente e varianti precedenti | Schemi del corso condivisi, preparazione, instradamento e finalizzazione |

Il [registro di produzione](../../../apps/backend/src/workflows/runtime/workflowRuntimeComposition.ts#L210) registra queste famiglie insieme alle modalità precedenti di calcolo delle impronte. La [factory degli stati del corso](../../../apps/backend/src/workflows/courseGenerationWorkflowContract.ts#L348) varia il profilo ma riusa lo schema del piano. Gli [insiemi della lezione](../../../apps/backend/src/workflows/lessonGenerationWorkflowContract.ts#L130) riusano contesto e ingresso; [SublessonPlanStateSchema](../../../apps/backend/src/workflows/lessonGenerationWorkflowContract.ts#L62) importa direttamente `CourseLessonSchema`.

La soluzione raccomandata mantiene il grafo dietro un contratto separato e lo aggiunge esclusivamente alla nuova definizione corrente. Prima di modificare qualunque schema condiviso, conserva integralmente l'insieme precedente e lo assegna esplicitamente a tutte le definizioni che lo usavano. La nuova definizione ha una nuova identità di compatibilità; quella che era corrente viene mantenuta fra le definizioni precedenti.

I servizi devono distinguere il contratto di esecuzione selezionato dal registro. Un processo storico continua a consumare e produrre i suoi formati anche se condivide funzioni con quello corrente. Il [manifesto esclude i corpi delle funzioni](../../../apps/backend/src/workflows/validation.ts#L362): impronte uguali non provano equivalenza del comportamento. Anche l'identità degli effetti del fornitore cambia quando cambia il formato del risultato conservato.

La migrazione fisica crea gli archivi necessari prima del rilascio del consumatore. La lettura storica riconosce l'assenza del grafo; un'eventuale costruzione per corsi precedenti sarebbe un'operazione separata con origine e verifica, non una migrazione automatica da titoli o `parentId`. Nessun dato diagnostico viene ricavato dai vecchi `experienceLevel` o `assessmentSummary`.

Le prove al registro devono caricare le impronte letterali precedenti, incluse quelle dell'attuale `main`, e risolverle con la nuova composizione. Su database isolato devono coprire avvio precedente→nuovo, nuovo→precedente e nuova replica identica. La replica precedente non deve riprendere autorità con un insieme di definizioni più ristretto. Si preservano storia dei rilasci e controlli di conflitto.

Riferimenti di verifica esistenti: [workflowRuntimeComposition.test.ts](../../../apps/backend/tests/workflows/workflowRuntimeComposition.test.ts#L75), [workflowDefinitions.test.ts](../../../apps/backend/tests/workflows/workflowDefinitions.test.ts), [pdfMappingRepairCompatibility.test.ts](../../../apps/backend/tests/workflows/pdfMappingRepairCompatibility.test.ts), [courseGenerationPersistence.test.ts](../../../apps/backend/tests/workflows/courseGenerationPersistence.test.ts).

## Transizione e parti implementabili

| Parte | Condizione di avvio | Risultato verificabile |
| --- | --- | --- |
| Contratti e validatori puri del curriculum e dei raccordi diagnostico e trasversale | Revisione del contratto tecnico e autorizzazione applicativa | Casi strutturali sotto verificati senza modello, rete o database. Identità fornite esplicitamente, riferimenti qualificati per account e corso. |
| Archivi e lettura autorizzata | Contratto di catalogo e ciclo di vita riconciliati, tipi #85/#112 disponibili | Salvataggio e rilettura senza perdita, isolamento fra proprietari e incarnazioni, ripetizione senza duplicati |
| Nuova generazione con grafo | Ingresso #85 e diagnosi #112 eseguibili, autorità di associazione concettuale definita | Un candidato unico alimenta verifica, piano, fonti ed esercizi in tutte le strategie |
| Consumo nelle lezioni | Contratto corrente distinto da tutti gli insiemi storici | Generatore e verificatore ricevono gli stessi obiettivi, requisiti e contesto effettivo |
| Collegamento delle attività | Schema concreto #91/#124 | Criterio riferito a un obiettivo preciso prima del tentativo; #39 conserva quel riferimento |
| Estensioni e proposte successive | Azioni ammesse dalla politica #121 | Aggiunte motivate, parentela e origine conservate, nucleo invariato |

Il primo blocco approvato implementa il contratto strutturale #119: concetti e obiettivi, ruoli e prerequisiti, riferimenti qualificati al curriculum sorgente e destinatario, esiti dei due raccordi e validatori puri. Accetta corrispondenze già dichiarate e controlla che ogni riferimento appartenga all'account e al corso indicati. Le prove #112/#39/#120 sono riferimenti ai contratti dei loro proprietari; la #119 non ne replica gli schemi interni.

Le verifiche del blocco coprono identità condivisa fra corsi, obiettivi locali distinti, corrispondenza parziale rispetto a identità condivisa, ambiguità, riferimenti estranei e conservazione della provenienza. Il controllo puro accerta coerenza rispetto al contesto risolto; l'autorizzazione effettiva richiede poi letture backend eseguite per l'account autenticato. Questo blocco prepara la lettura progressiva dei grafi. Recupero cronologico delle prove e scelta dell'azione rimangono integrazioni successive con #120 e #121.

La prima parte può validare identità e relazioni già dichiarate. Non sceglie automaticamente se due descrizioni siano lo stesso concetto, quali prove usare per omettere materia o come distribuire il contenuto fra lezioni. Queste scelte non diventano valori predefiniti del validatore.

Il percorso completo richiede aggiornamenti al codec, alle proiezioni client, ai lettori del piano e ai contratti di esportazione. Un tipo condiviso lasciato senza consumatori non completa la #119. La prima consegna definisce il punto d'ingresso del lavoro, con integrazioni e condizioni di completamento separate.

## Decisioni residue

| Decisione | Proprietario e motivo | Lavoro indipendente |
| --- | --- | --- |
| Intento finale formalizzato e controlli | #85: il grafo importa `planningInputRef`; forma dell'obiettivo finale e dominio dei controlli restano al proprietario | Collegamenti agli obiettivi senza scegliere scale |
| Contratti durevoli condivisi | #85/#112/#91/#124: risoluzione oltre i registri operativi, istanze, contesti, origini e conservazione | Catena dei riferimenti e validazioni richieste dalla #119 |
| Azioni di pianificazione e adattamento | #121: scelta iniziale concreta, omissione o preparazione dei prerequisiti e conseguenze dei dubbi | Registrazione di proposta, motivo, riferimenti e limiti |
| Presentazione del percorso e dei controlli | Progettazione visiva: scelta e verifica con l'utente prima dei componenti | Contratti privi di scelte visive |

Il confine di riuso e il primo blocco strutturale sono approvati. Il lavoro successivo richiede la riconciliazione delle interfacce con #120/#121 e i contratti durevoli dei rispettivi proprietari. La forma del prerequisito e la collocazione degli archivi sono proposte tecniche motivabili dal codice, non nuove politiche pedagogiche. Gli eventuali dubbi successivi tornano alla task orchestratrice, che mantiene un solo proprietario per ciascuna domanda all'utente.

## Casi di verifica

La tabella specifica i criteri di accettazione della futura implementazione. La lettura del codice e la verifica dei riferimenti documentali sono distinte dall'esecuzione di questi casi.

| Caso | Esito richiesto |
| --- | --- |
| Due concetti con lo stesso titolo e identità diverse | Restano distinti. Nessuna equivalenza per titolo. |
| Stesso concetto usato in due corsi | Identità riusata esplicitamente, obiettivi e osservazioni locali distinti. |
| Descrizione di corso plausibilmente pertinente | Caricamento del grafo richiesto con motivo; nessuna conclusione sulla conoscenza dal solo elenco. |
| Corso presente nell'elenco ma non esaminato | Stato non esaminato, distinto da assenza di grafi o evidenze pertinenti. |
| Concetti corrispondenti ma compito precedente più ristretto | Prova utilizzabile soltanto entro capacità e condizioni documentate; obiettivo nuovo non considerato già raggiunto. |
| Due prove discordanti provenienti da corsi diversi | Provenienza e ordine originali mantenuti, entrambe disponibili, nessuna regola «vince l'ultima». |
| Prova raggiunta da più collegamenti | Un solo riferimento all'episodio con tutti i collegamenti pertinenti, senza contarlo come più prestazioni. |
| Corso o prova di un altro account | Rifiuto autorevole anche se il modello ne fornisce l'identificatore. |
| Obiettivo estraneo inserito come proprietario nel nuovo curriculum | Rifiuto; un collegamento trasversale deve qualificare il corso di origine e il destinatario locale. |
| Concetto assunto e sviluppato su aspetti differenti | Usi distinti e motivati; nessuna scala numerica dei ruoli. |
| Nodo diagnostico con figlio inesplorato | Collegamento del genitore senza propagazione al figlio. |
| Claim ristretto e nodo più ampio | Il destinatario mantiene l'ambito del claim e il limite della prova. |
| Criterio, tentativo o interpretazione appartenenti a episodi diversi | Rifiuto strutturale della catena incoerente. |
| Una sorgente con due corrispondenze confermate | Entrambe disponibili con il proprio ambito. |
| Due alternative ancora ambigue | Nessun destinatario trattato come confermato. |
| Sorgente non esaminata e sorgente senza corrispondenza | Stati distinguibili, nessuna conversione silenziosa. |
| Dichiarazione elevata e prestazione discordante | Entrambe reperibili con provenienza, senza vincitore automatico. |
| Risposta assente, non valutabile o «Non so valutarmi» | Conserva il rispettivo significato senza errore di conoscenza inventato. |
| Diagnosi storica assente e riferimento diagnostico rotto | Assenza lecita nel primo caso, errore di integrità nel secondo. |
| Contesto linguistico cambiato dopo un tentativo | Raccolta conserva il contesto originale; generazione usa il proprio riferimento #85. |
| Lezione completata senza prova sul requisito | Il completamento non certifica il requisito. |
| Preparazione collocata dopo la lezione che la richiede | Violazione dell'ordine esplicitamente dichiarato; motivazione e riferimenti disponibili al verificatore. |
| Dipendenze di precedenza obbligatoria cicliche | Contraddizione segnalata sulla relazione pertinente, senza rigettare cicli di altre relazioni. |
| Granularità diversa sullo stesso obiettivo del corso | Stessi impegni e collegamenti riconoscibili; adeguatezza valutata sui contenuti. |
| Approfondimento che richiede una base nuova o anticipa una lezione futura | Violazione del vincolo #85 rilevabile dal confronto con requisito, collocazione e contenuto. |
| Ripetizione della pubblicazione o dell'estensione | Stesso esito per la stessa richiesta; conflitto se il contenuto cambia. |
| Eliminazione e ricreazione del progetto con uguale ID | Esecuzione precedente incapace di scrivere nella nuova incarnazione. |
| Pulizia dei registri operativi | Diagnosi, origini e contesti ancora risolvibili per i dati conservati. |
| Esportazione, importazione e salvataggio da client precedente | Riferimenti conservati o rimappati esplicitamente; nessuna perdita silenziosa. |
| Definizioni storiche e nuova definizione in entrambi gli ordini | Impronte precedenti risolvibili, esecuzione storica coerente e autorità del rilascio preservata. |

I controlli strutturali provano integrità e conservazione. La pertinenza delle corrispondenze, l'adeguatezza dei prerequisiti e l'invarianza della copertura richiedono esempi prodotti e valutati nel loro contenuto. Cercare parole nel testo dei prompt non verifica queste proprietà.

Stato della consegna: contratti strutturali implementati e verificati con prove pure, integrazione dell'adattatore e una prova locale con Luna. La [pagina del contratto](../04-section-data/03-p-curriculum-contract.md) precisa il perimetro di ciascuna verifica. Collegamento al processo durevole, persistenza e interfaccia appartengono alle parti successive e restano **NOT VERIFIED**.

La prima consegna e l'integrazione sul riuso fra corsi hanno ricevuto ciascuna due revisioni indipendenti senza rilievi materiali, sui requisiti e sulle regole del repository. Verificati i 30 collegamenti locali della proposta aggiornata. `main` remoto coincide con il commit di ricognizione. Queste verifiche riguardano la proposta, non l'esecuzione dei casi applicativi.
