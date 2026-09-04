# Valutazione delle fonti accademiche per la raccolta di ricerca

- Issue: [#71 — Evaluate academic-paper sources for research collection](https://github.com/immagiov4/Nous/issues/71)
- Data della verifica: 4 settembre 2026
- Codice esaminato: [`8cd5956ec2fb05806db71fcbf0719a603eee64d0`](https://github.com/immagiov4/Nous/tree/8cd5956ec2fb05806db71fcbf0719a603eee64d0)
- Natura del documento: decisione di ricerca; nessuna integrazione realizzata

## Decisione

**Raccomandare OpenAlex come unico candidato per un pilota limitato al corpus principale e ai soli metadati. Non autorizzare ancora richieste al fornitore né un'integrazione di produzione.**

La precondizione è una verifica legale scritta che chiarisca la convivenza fra dichiarazione CC0 dei metadati e licenza limitata delle condizioni del servizio, confermando espressamente che richieste di prova e conservazione del record normalizzato proposto sono ammesse. Senza tale conferma, non deve partire alcuna chiamata e l'esito resta negativo.

Se la precondizione viene soddisfatta, il pilota deve interrogare OpenAlex dal server usando soltanto argomento, titolo della sezione o lacuna dichiarata, senza inviare materiale originale, profilo, obiettivi personali o altri contenuti dell'utente. Deve recuperare dati bibliografici, identificatori, stato di ritrattazione e collegamenti; non deve conservare abstract, collegamenti diretti ai contenuti, PDF o testo integrale. I risultati devono rimanere separati dalle fonti già mostrate all'utente finché non sono soddisfatti i criteri di accettazione e approvate le scelte di prodotto ancora aperte.

Le ragioni seguenti sono **inferenze** basate sui documenti pubblici; non sostituiscono le misure del pilota né una verifica legale:

- OpenAlex è l'ipotesi iniziale più promettente per copertura generale, identificatori, relazioni citazionali, metadati dichiarati CC0 e accesso pubblico.
- Crossref è un ottimo secondo componente per DOI e metadati depositati, ma non il candidato più adatto alla scoperta generale iniziale.
- La licenza Semantic Scholar limita la concessione ordinaria all'uso interno, ma disciplina anche l'attribuzione per l'esposizione pubblica; l'uso pubblico non commerciale resta quindi da chiarire con AI2, mentre gli usi diversi, compreso quello commerciale, richiedono una licenza estesa.
- Google Scholar non offre un accesso massivo supportato e vieta l'automazione non conforme alle istruzioni per i robot.
- Europe PMC, OpenAIRE e DataCite sono integrazioni specialistiche valide, non sostituti generali iniziali.
- CORE e l'intermediario commerciale ScholarAPI richiedono verifiche contrattuali e sui diritti sproporzionate per il primo passo.

**Esito:** raccomandazione documentale di OpenAlex per il primo pilota, subordinata a conferma legale e approvazione del responsabile; nessuna scelta di produzione. Restano esclusi testo integrale ed effetti sul percorso utente.

Ogni regola specifica di Nous su ordinamento, esclusione e deduplicazione compare soltanto nella sezione **EURISTICA PROPOSTA**: è una proposta da approvare, non un'autorizzazione all'implementazione.

## Metodo e lessico probatorio

Sono state consultate il 4 settembre 2026 soltanto fonti primarie: documentazione, condizioni, informative e pagine ufficiali dei fornitori, oltre al codice corrente di Nous. Non sono state usate chiavi, dati privati o chiamate a pagamento. Non è stata inviata alcuna richiesta alle API dei fornitori.

Nel resto del documento:

- **FATTO** indica una proprietà dichiarata da una fonte primaria o osservata nel codice corrente.
- **INFERENZA** indica una conseguenza tecnica o di prodotto ricavata dai fatti.
- **INCOGNITA** indica un punto che la documentazione pubblica non consente di chiudere.

Le cifre su corpus, quote e prezzi sono fotografie della data di verifica e vanno ricontrollate prima di acquistare o integrare un servizio.

### Verifica del documento

- I 75 collegamenti HTTPS unici sono stati controllati il 4 settembre 2026. Settanta hanno risposto direttamente con stato 200 al controllo automatico; le cinque eccezioni dovute a rifiuto del metodo o protezione dall'automazione sono state riaperte e verificate sulle rispettive pagine primarie di Google, OpenAlex e Lens. Non è rimasto alcun collegamento non verificato.
- Tre revisioni separate in sola lettura hanno riesaminato rispettivamente il percorso interno di Nous, i quattro fornitori principali e le alternative con diritti, quote e riservatezza.
- Il commit locale esaminato coincideva con `HEAD` remoto al termine della ricerca. Il controllo meccanico degli spazi e la rilettura strutturale del nuovo file non hanno segnalato problemi.

## Percorso attuale delle fonti in Nous

### Ricerca del corso

1. **FATTO — raccolta:** `researchCourseWeb` invia a un modello di ricerca l'argomento, il contesto dell'utente e, quando presente, il materiale originale; abilita la ricerca sul web e chiede un titolo, un URL e l'uso di ogni fonte ([prompt](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/backend/src/workflows/courseGenerationResearch.ts#L88-L101), [chiamata](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/backend/src/workflows/courseGenerationResearch.ts#L181-L197)). In parallelo viene eseguita la ricerca YouTube ([raccolta dei due rami](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/backend/src/workflows/courseGenerationResearch.ts#L371-L390)).
2. **FATTO — contratto:** una fonte del corso contiene soltanto `title`, `url`, `note` e gli eventuali campi video; non ha DOI, autori, data, sede editoriale, fornitore, licenza o stato di ritrattazione ([schema](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/backend/src/workflows/courseGenerationWorkflowContract.ts#L145-L167)).
3. **FATTO — identità e selezione:** fonti web e video vengono unite in una mappa indicizzata dall'URL esatto. In modalità `learn`, il piano può citare soltanto URL presenti nella mappa ([raccolta e controllo](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/backend/src/workflows/courseGenerationPlanning.ts#L64-L94)); nelle modalità documentali il vincolo resta un'istruzione del prompt e gli URL non vengono persistiti nel piano di ricerca ([diramazione](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/backend/src/workflows/courseGenerationPlanning.ts#L135-L172)).
4. **INFERENZA:** questa convalida impedisce al modello di inventare una fonte fuori dall'insieme raccolto, ma considera diversi `doi.org`, URL editoriali, parametri di tracciamento e copie in repository come opere diverse.

### Materiale originale

1. **FATTO — preparazione:** in modalità documentale, la preparazione carica le fonti persistite, mantiene soltanto gli identificatori ancora utilizzabili e sceglie una strategia a fonte singola o insieme di fonti ([preparazione](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/backend/src/workflows/courseGenerationPreparation.ts#L97-L128)).
2. **FATTO — separazione:** ogni materiale originale viene ordinato e serializzato in un blocco `<source>` distinto, con nome, eventuale indice ed estratto ([formattazione](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/backend/src/workflows/courseGenerationSources.ts#L59-L79)).
3. **INFERENZA:** un indice accademico deve arricchire la ricerca esterna senza sostituire, inviare al fornitore o confondere con essa la fonte originale scelta dall'utente.

### Ricerca e persistenza della lezione

1. **FATTO — decisione di ricerca:** una lezione senza fonti, con lacune o da aggiornare abilita la ricerca web; una lezione con fonti ritenute sufficienti usa solo il contesto fornito ([modalità](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/backend/src/services/lessonGenerationModel.ts#L201-L245)).
2. **FATTO — risultato del modello:** anche qui ogni fonte web è soltanto `note`, `title`, `url` ([contratto](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/backend/src/services/lessonResearchContract.ts#L11-L26)).
3. **FATTO — normalizzazione:** le fonti web prodotte dalla ricerca vengono limitate a URL HTTP/HTTPS, ricevono se necessario un titolo di ripiego dal dominio e vengono fuse nel dossier della sezione ([normalizzazione e dossier](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/backend/src/services/lessonGenerationResearch.ts#L112-L131), [fusione](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/backend/src/services/lessonGenerationResearch.ts#L171-L210)).
4. **FATTO — deduplicazione:** la chiave è prima `sourceId`, altrimenti l'URL minuscolo senza barre finali, altrimenti il titolo normalizzato. Non vengono normalizzati DOI, alias, parametri o versioni dell'opera ([implementazione](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/backend/src/services/lessonGenerationSources.ts#L412-L442)).
5. **FATTO — stesura:** il dossier e le fonti selezionate alimentano la stesura della lezione ([passaggio ricerca-stesura](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/backend/src/workflows/lessonGenerationStageServices.ts#L534-L610)).
6. **FATTO — interfaccia:** il lettore riceve le fonti persistite della sezione e mostra, per una fonte esterna, soltanto titolo collegato e nota ([passaggio al lettore](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/web/app/useReaderShellProps.ts#L496-L504), [resa](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/web/components/workspace/shell/WorkspaceReaderContent.tsx#L830-L915)). Anche il tipo del client non contiene metadati accademici ([tipo](https://github.com/immagiov4/Nous/blob/8cd5956ec2fb05806db71fcbf0719a603eee64d0/apps/web/types.ts#L32-L42)).

### Punto minimo di integrazione

**INFERENZA:** il punto di acquisizione più stretto e coerente è sul server, accanto al ramo `research-course-web`, prima che `courseGenerationPlanning` costruisca l'insieme citabile. Il modello riceve un insieme chiuso di URL e, in modalità `learn`, il piano rifiuta URL estranei; un ramo accademico può quindi produrre candidati verificabili senza affidare al modello l'invenzione degli identificatori.

Con il contratto corrente, l'adattatore deve produrre almeno un URL stabile, per esempio quello del risolutore DOI quando il DOI esiste o la pagina dell'opera OpenAlex quando manca: `collectResearchSources` elimina i record privi di URL. In alternativa, la raccolta dovrà essere modificata esplicitamente per usare DOI o ID del fornitore come identità.

Non conviene nascondere OpenAlex dentro una generica nota web: si perderebbero provenienza, DOI e informazioni sui diritti. La minima superficie durevole comprende:

- un adattatore di acquisizione lato server, iniettato nei servizi della ricerca del corso;
- un tipo normalizzato condiviso che conservi almeno fornitore, identificatore del record, DOI originale, chiave locale di confronto del DOI, autori, anno o data, sede, tipo di opera, stato di ritrattazione con fornitore e data di recupero, e localizzazioni con versione/licenza;
- propagazione di quei campi attraverso piano, ricerca della lezione e dossier;
- una citazione leggibile nel lettore, separando attribuzione bibliografica, provenienza dei metadati e diritto del singolo testo.

**INFERENZA:** il pilota può arrestarsi prima di questa propagazione e produrre un reperto di valutazione separato. L'integrazione di produzione, invece, non è onesta se comprime i metadati accademici in `note`.

## Confronto sintetico

Nella tabella, copertura, accesso, diritti e identificatori riassumono **fatti** dichiarati dai fornitori; l'ultima colonna contiene **inferenze** per Nous. Le incertezze decisive sono sviluppate nelle sezioni successive.

| Fonte | Copertura e ruolo | Accesso, limiti e costo | Diritti e attribuzione | Identità e citazioni | Decisione per Nous |
| --- | --- | --- | --- | --- | --- |
| OpenAlex | Oltre 320 milioni di opere nel corpus principale; oltre 510 milioni includendo l'espansione. Ricerca generale, autori, sedi, temi, riferimenti e citazioni. | REST senza chiave per prova; budget gratuito maggiore con chiave. Tetto tecnico di 100 richieste/s e budget giornaliero; ricerca e contenuti hanno costi diversi. Nessuno SLA pubblico individuato. | La documentazione dichiara i metadati CC0, ma le condizioni concedono una licenza limitata e vietano copie non autorizzate: riuso e attribuzione richiedono chiarimento legale. PDF e XML conservano i diritti originari. | ID OpenAlex, DOI, PMID, PMCID e altri identificatori; fusioni e reindirizzamenti interni; grafo citazionale. | **Candidato al pilota**, solo dopo verifica legale, corpus principale e soli metadati. |
| Crossref | Oltre 185 milioni di record depositati da membri. Fonte autorevole per DOI e metadati editoriali; completezza variabile per campo. | API pubblica gratuita; accesso identificato tramite `mailto` consigliato. Quote diverse per record singolo e liste; gli header di risposta sono vincolanti. SLA soltanto nel servizio Metadata Plus. | Metadati bibliografici generalmente riutilizzabili; abstract e testi possono restare protetti. Un collegamento TDM non concede accesso né riuso. | DOI, relazioni, aggiornamenti, licenze e riferimenti depositati. Conteggi citazionali limitati ai riferimenti ricevuti. | **Seconda fase** per verifica e arricchimento DOI, non motore iniziale. |
| Semantic Scholar | 214 milioni di articoli, 2,49 miliardi di citazioni e 79 milioni di autori dichiarati; metadati semantici e citazionali ricchi. | Molti punti di accesso pubblici condivisi; chiave consigliata, inizialmente 1 richiesta/s. Nessun listino pubblico per licenza estesa. Nessuno SLA numerico individuato. | La licenza corrente limita la concessione ordinaria all'attività interna, legittima, non commerciale, di ricerca/formazione, ma impone collegamento, nome e logo per l'esposizione pubblica. L'uso pubblico non commerciale resta ambiguo; l'uso diverso o commerciale richiede una licenza estesa. | `paperId`, `corpusId`, DOI e altri ID; citazioni, riferimenti, contesti e influenza. | **Non procedere senza conferma scritta di AI2 sull'uso previsto**. |
| Google Scholar | Copertura dichiarata molto ampia di articoli, libri, tesi, preprint e rapporti, inclusi contenuti in abbonamento. | Nessuna API massiva ufficiale per Scholar; massimo 1.000 risultati per ricerca nell'interfaccia. | Google chiede di rispettare `robots.txt` e non offre accesso in blocco. I collegamenti possono puntare a copie gratuite o in abbonamento. | Versioni e citazioni visibili nell'interfaccia, ma nessun contratto dati automatizzabile. | **Non procedere nel servizio lato server**; nessuna estrazione automatizzata o intermediazione che la mascheri. |
| OpenAIRE Graph | Prodotti, dati, software, progetti, finanziamenti, organizzazioni e repository, con particolare valore europeo. | Gratuito; 60 richieste/ora senza autenticazione e fino a 7.200/ora con autenticazione. Servizio dichiarato operativo 24/7, senza SLA numerico nella pagina consultata. | Record API CC-BY; OpenAIRE deve essere riconosciuto come fonte. | Numerosi identificatori persistenti e relazioni; pulizia e deduplicazione dichiarate. | Alternativa successiva per finanziamenti, progetti e repository europei. |
| Europe PMC | Letteratura biomedica e delle scienze della vita; abstract, preprint, riferimenti, citazioni e annotazioni. | REST, SOAP, OAI e scarichi ufficiali pubblici; nessuna quota REST unica individuata. Vietato lo scarico massivo dal sito ordinario. | Il sottoinsieme ad accesso aperto espone testo tramite servizi ufficiali, ma la licenza va verificata articolo per articolo. | PMID, PMCID, DOI, ORCID e rete citazionale. | Ottima integrazione specialistica biomedica, non generale. |
| DataCite | DOI per dati, software, tesi, rapporti e altri risultati di ricerca. | REST pubblico: 500 richieste/5 minuti non identificate, 1.000 identificate, 3.000 autenticate; l'accesso pubblico restituisce soltanto DOI nello stato `Findable`. | Metadati CC0; nessun diritto generale sul contenuto collegato. | DOI e relazioni tra versioni, parti e oggetti. | Complemento futuro a Crossref per risultati non editoriali. |
| CORE | Oltre 449 milioni di record ricercabili e 57 milioni di testi integrali dichiarati, inclusi lavori senza DOI. | Accesso pubblico limitato; maggiore capacità e usi di prodotto possono richiedere licenza o pagamento. | CORE avverte che licenze e metadati possono essere incoerenti e attribuisce all'utente il controllo dei diritti. | Corpus armonizzato; serve comunque deduplicazione locale. | **Non iniziale**: chiarimento contrattuale prima di qualsiasi uso di prodotto. |
| ScholarAPI | Intermediario commerciale che non documenta nelle pagine consultate un'affiliazione o autorizzazione Google; dichiara oltre 30 milioni di testi/abstract e 20.000 fonti, cerca metadati e offre PDF/testo. | Account e chiave obbligatori; sistema a crediti, con prezzi e promozioni modificabili. Condizioni senza garanzia di disponibilità. | Le condizioni attribuiscono all'utente la verifica della licenza di ogni pubblicazione e limitano la redistribuzione in blocco. | Identificatore proprio e collegamento alla fonte; nessuna garanzia pubblica di deduplicazione individuata. | **Non iniziale**: provenienza, catena dei diritti, identità contrattuale e costo da chiarire. |

### Lavoro d'integrazione e riservatezza comparati

Questa è un'**inferenza** sulla superficie necessaria, non un punteggio o una classifica automatica. Dove la documentazione non chiude il trattamento dei dati, l'ostacolo è un'**incognita**.

| Fonte | Lavoro minimo per Nous | Ostacolo operativo o di riservatezza |
| --- | --- | --- |
| OpenAlex | Adattatore di ricerca, modello accademico normalizzato, identità DOI/ID, propagazione nel dossier e citazione nell'interfaccia. | Le richieste e i dati tecnici possono essere associati alla chiave e la politica ammette conservazione fino a sei mesi dopo la cessazione dell'uso; occorre inviare un testo minimo e non personale. |
| Crossref | Adattatore di recupero per DOI, riconciliazione dei campi e conservazione della provenienza per ogni valore. | La documentazione dice che IP e richiesta entrano in registri eliminati dopo tre mesi; l'informativa dice che l'email identificativa non viene conservata salvo necessità di assistenza tecnica. Il trattamento concreto di `mailto` va chiarito. |
| Semantic Scholar | Superficie tecnica simile a OpenAlex, più collegamenti obbligatori, nome/logo, chiarimento con AI2 ed eventuale gestione dell'accordo esteso. | Forma, costo e condizioni dell'eventuale licenza estesa non sono pubblici; uso e dati di ingresso sono soggetti al contratto AI2. |
| Google Scholar | Non esiste un punto di accesso ufficiale adatto: non è stimabile un'integrazione conforme del servizio lato server. | Una query automatica violerebbe il percorso indicato dalla guida; le normali condizioni e l'informativa Google governano l'uso manuale. |
| OpenAIRE, Europe PMC, DataCite | Un adattatore e una trasformazione specifici per ciascun modello; attribuzione OpenAIRE e controllo licenza per i testi Europe PMC. | L'autenticazione OpenAIRE raccoglie dati di registrazione; per Europe PMC e DataCite non è stata individuata una garanzia pubblica completa sulla conservazione delle singole query. |
| CORE | Adattatore per record e copie, verifica record per record dei diritti e accordo con CORE per l'uso previsto. | Licenza d'uso del prodotto e condizioni economiche da negoziare; una chiave registrata usa un indirizzo email. |
| ScholarAPI | Adattatore proprietario, gestione chiave/crediti, controllo dei diritti per record e verifica della provenienza. | Account, parametri delle richieste e IP registrati; identità societaria, sede e tempi di conservazione non risultano abbastanza chiari dalle pagine consultate. |

## Valutazione per fornitore

### OpenAlex

**FATTI**

- Le [opere](https://help.openalex.org/data/works/) comprendono articoli, atti, libri, capitoli, dati, tesi e preprint. Il [corpus principale](https://help.openalex.org/data/works/corpus/) supera 320 milioni di opere; l'espansione porta il totale oltre 510 milioni ma è dichiarata più scarna e rumorosa.
- La costruzione del catalogo aggrega Crossref, DataCite, PubMed, repository e altre fonti; applica fusione dei record e disambiguazione automatica ([processo](https://help.openalex.org/data/how-its-built/)).
- Gli [attributi delle opere](https://help.openalex.org/data/works/attributes/) comprendono DOI e altri identificatori, autori, date, sede, tipo, ritrattazione, riferimenti, citazioni e localizzazioni.
- La [ricerca testuale](https://help.openalex.org/api/searching/) considera internamente titolo, abstract e testo integrale; la pertinenza predefinita combina somiglianza testuale e numero di citazioni. La [ricerca semantica](https://help.openalex.org/api/semantic-search/) usa rappresentazioni vettoriali del titolo e dell'abstract ed è limitata a 2.000 caratteri, 50 risultati e 1 richiesta/s.
- L'[API](https://help.openalex.org/api/) è REST e può essere provata senza chiave. L'[autenticazione](https://help.openalex.org/api/authentication/) con chiave aumenta il budget gratuito ma non rimuove il tetto tecnico di 100 richieste/s. La [pagina dei costi](https://help.openalex.org/access/example-costs/) indica, alla data della verifica, 0,10 USD ogni mille chiamate di elenco/filtro, 1 USD ogni mille ricerche e 10 USD ogni mille scarichi di contenuti; senza chiave il budget gratuito giornaliero è un decimo di quello associato a una chiave gratuita.
- I metadati sono dichiarati [CC0](https://help.openalex.org/access/pricing/). La nozione di accesso aperto è però inclusiva: anche licenze restrittive possono risultare aperte, e una localizzazione può avere licenza nulla o generica ([accesso aperto](https://help.openalex.org/data/works/open-access/), [vocabolario delle licenze](https://help.openalex.org/data/licenses/)).
- L'archivio contiene oltre 50 milioni di PDF e versioni TEI/XML, ma i [testi integrali](https://help.openalex.org/access/fulltext/) conservano il copyright originario e OpenAlex non concede diritti ulteriori.
- L'[informativa](https://openalex.org/OpenAlex_privacy_policy.pdf), rivista il 15 agosto 2026 e raccolta con le condizioni nella [pagina legale ufficiale](https://openalex.org/legal), promette di non vendere i dati d'uso associati alle chiavi né usarli per pubblicità; dichiara però la raccolta di orari, endpoint, errori, prestazioni, IP e agente utente associabili alla chiave, e permette di conservare informazioni fino a sei mesi dopo la cessazione dell'uso salvo richiesta di cancellazione anticipata.
- Le [condizioni del servizio](https://openalex.org/OpenAlex_termsofservice.pdf), anch'esse riviste il 15 agosto 2026, concedono una licenza limitata e revocabile per le funzioni gratuite, vietano copie per finalità non autorizzate e non garantiscono continuità o disponibilità. Questa disciplina del servizio convive con la dichiarazione CC0 dei metadati nella documentazione: il perimetro concreto di un prodotto va verificato legalmente.

**INFERENZE**

- Tra i candidati esaminati presenta l'insieme tecnico più promettente di copertura generale e identificatori per il primo pilota; la tensione fra dichiarazione CC0 e condizioni d'uso lascia però irrisolta l'idoneità giuridica.
- Il corpus di espansione aumenterebbe subito rumore e record poveri di metadati; non è giustificato prima di misurare il corpus principale.
- Il numero di citazioni incorporato nella pertinenza predefinita può sfavorire lavori recenti, discipline con pratiche citazionali diverse e ricerca non anglofona. Se l'euristica proposta viene approvata, Nous conserva l'ordine del fornitore come dato senza presentarlo come misura assoluta di qualità.
- L'etichetta `is_oa` non è una decisione sui diritti. Per il pilota deve essere soltanto informativa.

**INCOGNITE**

- Copertura e pertinenza reali sui temi e sulle lingue usati dagli utenti di Nous.
- Stabilità della classifica tra aggiornamenti del corpus.
- Base giuridica, applicazione della finestra massima dichiarata e periodo effettivo di conservazione delle singole query nella configurazione concreta di produzione.
- Livello di servizio necessario oltre il pilota gratuito.

### Crossref

**FATTI**

- Crossref dichiara oltre 185 milioni di record con metadati accessibili e riceve tali metadati dai propri membri ([servizio di recupero](https://www.crossref.org/services/metadata-retrieval/)). DOI, autori, date, relazioni, licenze e riferimenti sono utili, ma molti campi sono raccomandati e non obbligatori ([elementi richiesti e raccomandati](https://www.crossref.org/documentation/schema-library/required-recommended-elements/)).
- La [REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) è pubblica e gratuita; gli abstract possono essere protetti dall'autore o dall'editore. Crossref offre collegamenti per estrazione automatizzata, ma il collegamento non garantisce accesso né licenza ([testo e analisi dei dati](https://www.crossref.org/documentation/retrieve-metadata/text-and-data-mining/)).
- L'[accesso identificato](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/) usa `mailto` o un agente utente, limita le richieste simultanee a 1 nel canale pubblico e 3 in quello identificato e richiede di rispettare gli header restituiti. Un [aggiornamento operativo del 21 luglio 2026](https://community.crossref.org/t/refining-rest-api-limits-for-improved-stability-and-reliability/16137) distingue record singoli, a 5 richieste/s pubbliche o 10 identificate, da elenchi e ricerche, a 1 o 3 richieste/s; le quote sono applicate per email quando presente.
- Il servizio pubblico non espone uno SLA. La pagina di [Metadata Plus](https://www.crossref.org/documentation/metadata-plus/) pubblica un obiettivo mensile aggregato del 99,5%, da riconfermare nel contratto vigente; le [tariffe annuali](https://www.crossref.org/fees/) pubblicate vanno da 550 a 44.000 USD in base alle dimensioni dell'organizzazione.
- La [documentazione di recupero](https://www.crossref.org/documentation/retrieve-metadata/) dice che anche nell'accesso anonimo vengono registrati IP e contenuto della richiesta, che l'email identificativa non è usata per promozione o altri fini e che i registri sono eliminati dopo tre mesi. L'[informativa generale](https://www.crossref.org/operations-and-sustainability/privacy/) afferma invece che l'email delle richieste identificate non viene conservata o usata salvo stretta necessità di assistenza tecnica, mentre non fissa una durata generale per gli altri dati personali. La documentazione pubblica non chiarisce se e come `mailto` venga escluso dai registri tecnici.
- Il [servizio Cited-by](https://www.crossref.org/documentation/cited-by/) dipende dai riferimenti depositati e non misura l'intero grafo mondiale. I DOI alias possono reindirizzare verso il DOI principale ([alias DOI](https://community.crossref.org/t/adding-redirects-for-aliased-dois-in-the-rest-api/13138)).
- Le ritrattazioni provenienti da Retraction Watch sono incluse nella REST API e il relativo archivio CC0 è aggiornato ogni giorno; ciò documenta la provenienza, non la completezza assoluta dello stato di ogni opera ([fonti e licenze](https://www.crossref.org/documentation/retrieve-metadata/)).

**INFERENZE**

- Crossref è la fonte migliore per verificare o arricchire un DOI già noto, ma la completezza variabile e la ricerca bibliografica depositata lo rendono meno adatto come unica fonte di scoperta.
- Una seconda fase OpenAlex → Crossref può migliorare l'identità editoriale senza complicare il primo pilota.

**INCOGNITE**

- Percentuale dei candidati OpenAlex con campi Crossref più completi o discordanti nel campione Nous.
- Necessità economica di Metadata Plus rispetto alle quote pubbliche.

### Semantic Scholar

**FATTI**

- La [pagina API](https://www.semanticscholar.org/product/api) dichiara 214 milioni di articoli, 2,49 miliardi di citazioni e 79 milioni di autori. La [documentazione](https://api.semanticscholar.org/api-docs/graphs) espone DOI e altri ID, abstract, autori, sede, citazioni, riferimenti, contesti e collegamenti a PDF.
- La pagina API dichiara un insieme anonimo condiviso fino a 1.000 richieste/s, soggetto a ulteriore limitazione, e una frequenza iniziale di 1 richiesta/s per chiave.
- La [licenza corrente dell'API](https://api.semanticscholar.org/license/) limita la concessione ordinaria all'uso interno per addestramento/valutazione e trasformazione di dati, per legittimi fini non commerciali di ricerca o formazione. La stessa sezione impone a ogni esposizione pubblica un collegamento Semantic Scholar con `utm_source=api`, nome e logo, senza chiarire se ciò estenda la concessione oltre l'uso interno; gli altri fini, compresi quelli commerciali, richiedono una licenza estesa. L'ammissibilità di un uso pubblico non commerciale va quindi confermata con AI2.
- La stessa licenza definisce i dati di risposta come comprendenti metadati, abstract e testi, attribuisce al cliente il rispetto dei diritti di terzi, consente il monitoraggio d'uso, non offre uno SLA numerico e prevede almeno 60 giorni di preavviso per una cessazione completa senza sostituto.
- La licenza definisce separatamente dati di ingresso e dati d'uso: AI2 promette di usare gli ingressi soltanto per produrre la risposta e di non condividerli o pubblicarli, ma può monitorare l'uso e ricavarne statistiche aggregate; non indica un periodo di conservazione.

**INFERENZA:** i dati sono tecnicamente attraenti, ma la licenza standard non è una base prudente per la visualizzazione delle fonti in un prodotto pubblico. Non basta che l'API sia gratuita.

**INCOGNITE:** forma dell'autorizzazione o licenza estesa, prezzo, condizioni e tempi compatibili con la natura presente e futura di Nous; periodo di conservazione di query e dati d'uso.

### Google Scholar

**FATTI**

- La [guida ufficiale](https://scholar.google.com/intl/us/scholar/help.html) dichiara una copertura ampia ma non garantita, nega l'accesso in blocco, limita a 1.000 i risultati per ricerca e chiede ai programmi automatici di rispettare `robots.txt`.
- La stessa guida dichiara l'aggiunta di nuovi lavori più volte alla settimana, ma avverte che correzioni e aggiornamenti dei record possono richiedere da 6–9 mesi a un anno o più.
- Le [condizioni Google](https://policies.google.com/terms?hl=en-US) vietano l'accesso automatico contrario alle istruzioni leggibili dalle macchine.
- Il [Search Researcher Program](https://support.google.com/websearch/answer/16091809?hl=en) riguarda Google Search, non un'API di Google Scholar; è riservato a progetti accademici approvati con finalità pubblicabile e non commerciale.

**INFERENZA:** non esiste un percorso ufficiale e sostenibile per collegare Google Scholar al servizio lato server di Nous. Un servizio terzo che riproduce risultati di Scholar non trasforma tale accesso in un'API Google autorizzata.

### Alternative pertinenti

- **OpenAIRE — FATTI:** le [condizioni API correnti](https://graph.openaire.eu/docs/apis/terms/) permettono riuso commerciale e non commerciale dei record con CC-BY, impongono attribuzione e indicano 60 richieste/ora anonime o 7.200/ora autenticate. **INFERENZA:** è particolarmente utile per progetti, finanziamenti e repository europei, ma aggiunge un altro modello dati e un obbligo visibile di attribuzione.
- **Europe PMC — FATTI:** le [risorse per sviluppatori](https://europepmc.org/developers) espongono metadati, riferimenti, citazioni e il sottoinsieme di testi ad accesso aperto. Il [copyright](https://dev.europepmc.org/Copyright) resta articolo per articolo e lo scarico automatizzato deve usare i canali ufficiali. **INFERENZA:** è forte nelle scienze della vita, non nella copertura generale.
- **DataCite — FATTI:** i metadati sono [CC0 e pubblicamente raccoglibili](https://support.datacite.org/docs/harvesting-datacite-doi-metadata); le [quote](https://support.datacite.org/docs/rate-limit) sono esplicite. La [REST API pubblica](https://support.datacite.org/docs/rest-api) espone solo DOI nello stato `Findable`, non bozze o record soltanto registrati. **INFERENZA:** è prezioso per dati, software e altri prodotti con DOI, ma non sostituisce la scoperta bibliografica generale.
- **CORE — FATTI:** le [condizioni](https://core.ac.uk/terms) richiedono di contattare CORE per prodotti monetizzabili, destinati a gruppi ristretti o simili a ricerca/scoperta; avvertono inoltre che repository e metadati possono esporre materiale non realmente aperto. La [pagina API](https://core.ac.uk/services/api) limita l'accesso pubblico a una richiesta in blocco o cinque richieste singole ogni dieci secondi; capacità maggiori sono soggette a licenza. **INFERENZA:** è da rivalutare soltanto quando il testo integrale diventa un requisito approvato.
- **ScholarAPI — FATTI:** il commento presente nell'issue e le cifre di corpus riportate dal fornitore sono materiale promozionale, non evidenza indipendente di idoneità. Questo intermediario commerciale non documenta nelle pagine consultate un'affiliazione o autorizzazione Google: la [pagina del servizio](https://scholarapi.net/) richiede una chiave per ogni chiamata e si presenta come alternativa all'estrazione diretta. Le [condizioni](https://scholarapi.net/legal/terms) lasciano all'utente la verifica delle licenze e non garantiscono accuratezza o continuità; l'[informativa](https://scholarapi.net/legal/privacy) include nei registri parametri delle richieste, IP e tempi; il [listino](https://scholarapi.net/credits) è a crediti. **INCOGNITE:** identità societaria verificabile, catena documentata delle licenze, sede, conservazione dei dati, accordo sul trattamento e costo contrattuale.
- **Unpaywall — FATTI:** la [REST API](https://unpaywall.org/api) è gratuita, richiede un'email, chiede di non superare 100.000 chiamate al giorno e restituisce per DOI le localizzazioni ad accesso aperto, compresa quella ritenuta migliore. Non concede i diritti sul testo collegato e non è un indice generale di scoperta. OpenAlex descrive oggi Unpaywall come vista compatibile sugli stessi dati sottostanti e raccomanda OpenAlex per nuovi lavori ([panoramica dei prodotti](https://help.openalex.org/access/overview/)). **INFERENZA:** può restare un controllo specialistico successivo; non aggiunge valore sufficiente al primo pilota.
- **NCBI E-utilities / PubMed — FATTI:** l'[interfaccia ufficiale](https://www.ncbi.nlm.nih.gov/books/NBK25497/) copre PubMed e gli altri archivi Entrez, con PMID e collegamenti PMC; ammette 3 richieste/s senza chiave e 10 con chiave, richiede `tool` ed email registrati per gestire eventuali blocchi e chiede che l'avviso NCBI su responsabilità e copyright sia visibile agli utenti del programma. Abstract e contenuti possono essere protetti. **INFERENZA:** è una valida alternativa biomedica, sovrapposta in parte a Europe PMC, non un indice generale.
- **OpenCitations — FATTI:** la [guida ufficiale](https://github.com/opencitations/oc_docs/blob/main/docs/api/quickstart.md) offre senza chiave un indice di citazioni e metadati per DOI, PMID e OMID, con limite di 180 richieste/minuto per IP; i [dati sono CC0](https://opencitations.net/). **INFERENZA:** è un possibile controllo futuro del grafo citazionale, non un motore generale di scoperta.
- **Lens — FATTI:** l'[API](https://docs.api.lens.org/) unisce opere scientifiche e brevetti, richiede accesso con gettone e attribuzione; le [condizioni correnti](https://about.lens.org/lens-api-terms-of-use/) riservano il servizio a sottoscrizioni istituzionali e piani personalizzati. **INFERENZA:** è pertinente solo se Nous approverà un requisito esplicito di collegamento fra ricerca e brevetti.

## Metadati, testo integrale e diritti

| Elemento | Uso prudente nel pilota | Motivo |
| --- | --- | --- |
| Titolo, autori, anno, sede, tipo | Recuperare e conservare con provenienza | Necessari per riconoscere e citare l'opera. |
| DOI originale, chiave locale di confronto del DOI e ID OpenAlex | Recuperare e conservare separatamente | La chiave facilita il confronto ma non sostituisce il valore depositato né prova da sola che due versioni siano identiche. |
| Stato di ritrattazione | Recuperare con fornitore e data; sottoporre il trattamento all'approvazione dell'euristica proposta | È uno stato noto al fornitore, non una prova di completezza. L'esclusione automatica del record è una politica di prodotto ancora da approvare. |
| Conteggio citazioni | Conservare solo nel reperto di valutazione, con fornitore e data | Non è confrontabile tra fornitori né equivale a qualità. |
| Stato di accesso aperto | Conservare come dichiarazione del fornitore | Non prova una licenza di copia o trasformazione. |
| Licenza e versione di una localizzazione | Conservare senza inferirle quando assenti | I diritti appartengono alla singola copia/versione. |
| Abstract | Non richiedere come campo di risposta né conservare nel primo pilota | Può essere protetto; OpenAlex lo distribuisce in forma invertita per ragioni giuridiche. La ricerca testuale può comunque usarlo internamente. |
| PDF, XML o testo integrale | Non recuperare, memorizzare o inviare al modello | Disponibilità tecnica e diritto di riuso sono questioni diverse. |

Il pilota deve usare la [selezione dei campi](https://help.openalex.org/api/selecting-fields/) per richiedere soltanto i campi OpenAlex di primo livello `id`, `doi`, `display_name`, `publication_year`, `publication_date`, `type`, `is_retracted`, `authorships`, `primary_location`, `locations` e `cited_by_count`. Poiché `select` non proietta le proprietà annidate, `authorships` e `locations` arrivano completi e vanno ridotti prima di ogni persistenza. La trasformazione conservata ammette esclusivamente: fornitore, ID del record, DOI originale, chiave locale di confronto del DOI, titolo, nomi bibliografici degli autori, anno/data, sede, tipo, stato di ritrattazione con fornitore e data di recupero, conteggio citazioni con fornitore e data, URL della pagina dell'opera e, per ogni localizzazione, URL della pagina, versione, licenza e stato di accesso aperto. Deve scartare collegamenti diretti a PDF, abstract, URL di contenuti, riferimenti, opere correlate, profili, affiliazioni e ogni altro campo annidato non ammesso. Non deve chiamare i punti di accesso ai contenuti.

Per l'interfaccia futura, una citazione dovrebbe mostrare autori, anno, titolo, sede e DOI come collegamento al risolutore DOI, secondo le [linee di visualizzazione Crossref](https://www.crossref.org/display-guidelines/). La dicitura “Metadati: OpenAlex” rende comprensibile la provenienza senza confonderla con autore o editore. OpenAlex pubblica anche una [modalità di citazione consigliata](https://help.openalex.org/how-to/citing-openalex/).

## EURISTICA PROPOSTA

Questa sezione propone una regola specifica di Nous per ordinamento e deduplicazione. **Non è approvata e non deve essere implementata senza decisione esplicita del responsabile del prodotto.** Non contiene soglie quantitative: numero di candidati, frequenza, cache e livelli minimi di qualità restano decisioni aperte.

### Regola decisionale

1. Interrogare soltanto il corpus principale di OpenAlex con ricerca testuale, dichiarando esplicitamente `corpus=core` nella richiesta e usando una query breve derivata da argomento, titolo della sezione o lacuna dichiarata e priva di dati personali o testo sorgente.
2. Richiedere soltanto i campi ammessi sopra e scartare i record dichiarati ritrattati, registrando fornitore e data del controllo.
3. Conservare l'ordine di pertinenza fornito da OpenAlex, senza riordinare per numero di citazioni, data o una formula locale. Registrare che la pertinenza OpenAlex include già il numero di citazioni.
4. Conservare il DOI originale e calcolare una chiave locale di confronto rimuovendo schema, dominio `doi.org`, prefisso `doi:` e spazi e ignorando maiuscole/minuscole. Se il DOI manca, usare l'ID OpenAlex senza inventarne uno.
5. Fondere automaticamente soltanto record che OpenAlex risolve allo stesso ID canonico, anche dopo un reindirizzamento. La stessa chiave locale del DOI su ID distinti segnala un candidato duplicato da verificare, non autorizza da sola la fusione. Conservare tutte le localizzazioni e la loro provenienza.
6. Non fondere automaticamente record soltanto perché chiave locale del DOI, titolo, autori o anno coincidono o si somigliano. Non fondere preprint e versione editoriale senza una relazione esplicita del fornitore che ne conservi comunque le identità separate.
7. In modalità `learn`, lasciare al pianificatore la selezione tra candidati ammessi, mantenendo l'obbligo di usare solo URL presenti nell'evidenza. Nelle modalità documentali vale soltanto il vincolo istruzionale già presente nel prompt.

### Casi di fallimento

- DOI mancante, errato, alias non risolto o assegnato a livelli diversi, come opera e capitolo.
- Preprint e versione editoriale separati pur rappresentando sostanzialmente lo stesso lavoro, oppure fusi quando hanno contenuti diversi.
- Titoli tradotti, nomi traslitterati, consorzi autoriali e date discordanti.
- Classifica che favorisce opere vecchie o discipline ad alta densità citazionale.
- Lavori recenti con poche citazioni, metadati incompleti o non ancora aggiornati.
- Stato di ritrattazione, correzione o licenza assente o in ritardo.
- **FATTO:** la [documentazione OpenAlex](https://help.openalex.org/api/) chiede esplicitamente di trattare i campi testuali come dati non attendibili.
- **INFERENZA:** stringhe e collegamenti potrebbero essere malformati o pericolosi; schema, destinazione e testo vanno convalidati prima dell'uso.
- Due copie con licenze o versioni diverse, dove una fusione nasconde quale copia è stata effettivamente consultata.

## Riservatezza e sicurezza

**FATTI**

- OpenAlex associa alla chiave orari, endpoint, errori, prestazioni, IP e agente utente e dichiara una possibile conservazione fino a sei mesi dopo la cessazione dell'uso.
- Crossref dichiara registri con IP e contenuto della richiesta eliminati dopo tre mesi, ma descrive separatamente l'email identificativa come non conservata salvo stretta necessità di assistenza; il trattamento tecnico di `mailto` resta non chiarito.
- Semantic Scholar definisce dati di ingresso e d'uso, limita l'uso degli ingressi alla risposta, permette statistiche aggregate e non pubblica un periodo di conservazione.
- Google Scholar non offre il punto di accesso automatizzato richiesto; l'uso manuale resta soggetto alle condizioni e all'informativa Google.
- La ricerca del corso corrente invia al modello anche contesto, profilo e materiale originale; quel comportamento non deve essere copiato automaticamente verso un indice accademico.

**INFERENZA:** salvo un contratto più preciso, una futura integrazione deve presumere che una query possa comparire nei registri tecnici del fornitore e minimizzarla di conseguenza.

**Regole di sicurezza proposte per il pilota:**

- esecuzione esclusivamente lato server;
- nessuna chiave nel client o nel reperto di prova;
- solo dati pubblici e query di prova approvate;
- nessun nome progetto, profilo, valutazione, obiettivo personale, evidenziazione o testo caricato dall'utente;
- conservazione della richiesta esatta, dell'impronta della risposta transitoria e del solo record normalizzato ammesso; nessun corpo grezzo persistito e nessun dato privato nel reperto locale/versionato;
- sanificazione di ogni stringa e convalida di ogni URL prima della visualizzazione;
- autori trattati soltanto come dati bibliografici, senza profilazione.

**INCOGNITA:** una futura ricerca su un argomento raro può rivelare indirettamente un interesse personale anche senza identificatori. La comunicazione all'utente e il periodo di conservazione devono essere decisi prima della produzione.

## Disponibilità, costo e comportamento in caso di errore

- **FATTO:** le API pubbliche OpenAlex e Crossref non hanno, nelle fonti consultate, uno SLA equivalente alle offerte a pagamento. Quote e prezzi possono cambiare.
- **FATTO:** il percorso corso corrente tratta il ramo web come necessario e la ricerca YouTube può diventare non disponibile; non esiste ancora un contratto per un terzo ramo accademico.
- **INFERENZA:** il pilota separato non deve poter bloccare o modificare la generazione corrente.
- **DECISIONE NECESSARIA:** in produzione, un errore del fornitore accademico deve bloccare la ricerca, degradare verso la sola ricerca web o essere visibile all'utente? È un cambiamento di comportamento collaterale e non viene deciso qui.
- **DECISIONE NECESSARIA:** quote, numero di candidati, tentativi, attese, durata della cache e budget monetario richiedono valori approvati; questo rapporto non ne introduce.

## Pilota riproducibile proposto

Il pilota è un'attività successiva e separata. Prima di qualsiasi richiesta o persistenza, una verifica legale scritta deve confermare che l'uso dell'API e la conservazione del record normalizzato rispettino sia le condizioni del servizio sia la dichiarazione CC0; in mancanza, il pilota non parte. Dopo tale conferma deve produrre un reperto versionato, senza entrare nel percorso utente.

1. **Bloccare il contesto:** registrare commit Nous, data, versione o data della documentazione OpenAlex e URL esatti delle richieste.
2. **Preparare un insieme pubblico di prova:** il responsabile approva un file con query esatte, lingua, disciplina, tipo di risultato atteso e, per le prove a elemento noto, DOI o ID atteso. Deve includere discipline e lingue diverse, un lavoro recente, un preprint, un lavoro senza DOI e un record ritrattato. La quantità del campione va approvata prima dell'esecuzione.
3. **Eseguire senza chiave e senza costi:** usare il punto di accesso pubblico, dichiarare `corpus=core`, applicare `select` con l'elenco di campi definito sopra e non chiamare punti di accesso ai contenuti. Arrestarsi se il budget gratuito non basta; non acquistare crediti.
4. **Conservare l'evidenza:** per ogni richiesta registrare data/ora, URL, stato HTTP, header di quota pertinenti, impronta del corpo transitorio e trasformazione normalizzata ammessa. Non conservare il corpo grezzo; nessun dato privato deve apparire nel reperto.
5. **Valutare alla cieca:** un revisore confronta titolo, autori, sede, DOI, pertinenza didattica, ritrattazione, duplicati e localizzazioni con le pagine originarie, senza vedere il numero di citazioni durante il giudizio di pertinenza.
6. **Ripetere:** rieseguire lo stesso insieme in una data approvata e distinguere variazioni legittime del corpus da instabilità dell'identità o della classifica.
7. **Confrontare il percorso corrente:** sulle stesse query, confrontare le fonti OpenAlex con le fonti web già prodotte da Nous, senza modificare il corso o la lezione. Eventuali costi del modello devono essere autorizzati separatamente.

Metriche da produrre, senza fissare qui soglie di promozione: ritrovamento degli elementi noti, pertinenza giudicata, copertura DOI, completezza di autori/data/sede, duplicati prima e dopo la regola proposta, presenza di record ritrattati, variazione tra esecuzioni, tempo, errori, consumo del budget e distribuzione per lingua/disciplina.

## Criteri di accettazione

Il pilota è accettabile soltanto se tutti i cancelli binari seguenti sono soddisfatti:

- ogni record conservato porta ID OpenAlex, data di recupero e URL di origine;
- la normalizzazione dello stesso DOI produce sempre la stessa chiave locale di confronto e conserva il DOI originale; se l'euristica proposta viene approvata, non fonde automaticamente ID distinti sulla sola uguaglianza del DOI o somiglianza testuale;
- ogni controllo dello stato di ritrattazione conserva fornitore e data; soltanto se l'euristica proposta viene approvata, nessun record dichiarato ritrattato è proposto automaticamente come fonte didattica;
- nessun abstract o testo integrale viene conservato, ogni collegamento diretto al contenuto arrivato dentro un campo annidato viene scartato, nessun punto di accesso ai contenuti viene chiamato e nessun PDF viene recuperato;
- licenza, versione e accesso aperto restano proprietà della singola localizzazione e i valori assenti non vengono inventati;
- nessun dato privato o contenuto dell'utente compare nelle richieste, risposte o registri del pilota;
- gli errori o le quote OpenAlex non cambiano né bloccano la generazione corrente;
- la provenienza OpenAlex e la citazione dell'opera sono ricostruibili dal reperto;
- la verifica legale preliminare è documentata nel reperto e non sono state eseguite richieste prima della sua conferma;
- il responsabile approva le soglie numeriche delle metriche di qualità prima di decidere l'accesso alla produzione.

Se un cancello binario fallisce, l'esito è negativo. Se i cancelli passano ma le metriche non raggiungono le soglie approvate, l'esito resta negativo o richiede una nuova ricerca; non autorizza automaticamente Crossref, Semantic Scholar o il testo integrale.

## Rischi principali

| Rischio | Conseguenza | Contenimento proposto nel pilota, soggetto all'approvazione dell'euristica ove pertinente |
| --- | --- | --- |
| Pertinenza opaca e influenzata dalle citazioni | Fonti popolari ma non adatte alla progressione didattica | Se l'euristica viene approvata: conservare l'ordine del fornitore, misurarlo per disciplina e giudicare senza vedere le citazioni. |
| Identità imperfetta | Doppioni o fusione di versioni diverse | Se l'euristica viene approvata: ID OpenAlex come autorità del pilota; DOI originale e chiave locale di confronto come segnali, non fusione automatica; nessuna fusione testuale. |
| Metadati incompleti o ostili | Citazioni errate, collegamenti pericolosi, istruzioni malevole | Schema chiuso, sanificazione, URL HTTP/HTTPS e nessun campo trattato come istruzione. |
| Accesso aperto confuso con riuso | Violazione di licenze o copyright | Nessun testo nel pilota; conservare licenza/versione per localizzazione. |
| Ritrattazioni e correzioni tardive | Materiale didattico inaffidabile | Se l'euristica viene approvata: esclusione dei record marcati, provenienza e data dello stato, nuova verifica prima della pubblicazione senza assumere completezza. |
| Dipendenza dal fornitore | Interruzioni o variazioni di prezzo/classifica | Pilota separato, ID portabili, nessun blocco del percorso corrente. |
| Esposizione delle query | Rivelazione di interessi o contenuti personali | Insieme pubblico di prova e minimizzazione; politica utente prima della produzione. |
| Attribuzione insufficiente | Fonte poco verificabile o obblighi non rispettati | Citazione dell'opera, DOI, pagina originaria e provenienza dei metadati separati. |
| Divergenza fra documentazione e condizioni OpenAlex | Conservazione o riuso non autorizzati nonostante la dichiarazione CC0 | Parere legale scritto come precondizione; nessuna richiesta o persistenza prima del chiarimento. |

## Decisioni richieste prima del pilota o dell'implementazione

1. Ottenere una verifica legale scritta delle condizioni OpenAlex, della dichiarazione CC0 e della base di trattamento dei dati tecnici prima di qualsiasi richiesta o persistenza.
2. Confermare che il primo ambito sia la ricerca del corso in modalità apprendimento, non anche la ricerca puntuale della lezione.
3. Approvare o rifiutare la sezione **EURISTICA PROPOSTA**.
4. Approvare l'insieme pubblico di prova e le soglie quantitative di promozione.
5. Stabilire quali parti di argomento, obiettivo e lacuna possano essere inviate a OpenAlex e come informarne l'utente.
6. Stabilire numero di candidati, frequenza, tentativi, attese, durata della cache e budget.
7. Decidere il comportamento di produzione quando OpenAlex non è disponibile.
8. Approvare il modello minimo dei metadati e la forma della citazione nell'interfaccia.
9. Decidere se una seconda fase debba interrogare Crossref per verificare i DOI.
10. Mantenere Semantic Scholar, Google Scholar, CORE, ScholarAPI e testo integrale fuori ambito finché non esiste un'approvazione distinta.

## Conclusione

OpenAlex merita di restare il candidato al primo pilota perché può migliorare tracciabilità e qualità delle fonti senza legare Nous a testo protetto. La divergenza fra dichiarazione CC0 e condizioni del servizio impedisce però qualsiasi richiesta o persistenza prima di un chiarimento legale. Il vantaggio atteso non deriva dal sostituire la ricerca web con una classifica bibliometrica: deriva dal dare a ogni candidato identità persistente, provenienza e stato verificabili prima che il modello lo usi.

Se il chiarimento arriva, la scelta più sicura resta piccola: `corpus=core`, metadati soltanto, query pubbliche e minimizzate, nessun effetto sul prodotto, valutazione riproducibile. Crossref resta il complemento naturale dopo una prova riuscita. Tutto ciò che riguarda abstract, testo integrale, classifiche locali, quote di produzione o altri fornitori richiede una decisione successiva esplicita.
