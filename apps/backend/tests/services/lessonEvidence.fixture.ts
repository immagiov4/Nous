import type { ResearchSource } from '../../src/services/lessonGenerationSources.js';
import type { LessonContentDraft } from '../../src/services/lessonGenerationTypes.js';

// Authored, non-personal simulated lecture material. The observations below are
// stored independently from the selector and verifier responses in the tests.
const lectures = [
  {
    title: 'Eventi e orologi nei sistemi distribuiti',
    segments: [
      'Benvenuti al corso di sistemi distribuiti. Nella prima parte abbiamo discusso come suddividere un servizio fra più macchine, quali componenti comunicano sulla rete e perché il risultato di una richiesta dipenda dal lavoro di processi diversi. Oggi passeremo dal disegno della rete alla descrizione degli eventi. Prima della spiegazione ricordate che il materiale amministrativo, il calendario degli esami e il modulo di iscrizione al laboratorio si trovano nella pagina del corso.',
      'Un processo esegue una successione di eventi locali. Un evento può essere un calcolo, la spedizione di un messaggio o la ricezione di un messaggio. Per parlare di dipendenze senza presupporre un orologio comune definiamo la relazione happened-before, che indichiamo con una freccia. Se due eventi appartengono allo stesso processo e il primo precede il secondo nell’esecuzione locale, il primo precede causalmente il secondo. Se un evento è l’invio di un messaggio e un altro è la ricezione di quel medesimo messaggio, l’invio precede causalmente la ricezione.',
      'La relazione è transitiva. Se a precede causalmente b e b precede causalmente c, allora a precede causalmente c. Questa regola permette di seguire una catena che attraversa processi diversi. Disegniamo tre linee verticali: sul processo P un evento a prepara un messaggio, Q lo riceve in b e poi spedisce un secondo messaggio a R, che lo riceve in c. La catena locale e i due invii mostrano come l’informazione possa andare da a a c. Non è necessario assegnare ai tre processi la stessa ora fisica.',
      'Due eventi sono concorrenti quando nessuno dei due precede causalmente l’altro. Concorrente, in questa definizione, non significa necessariamente simultaneo secondo un orologio fisico. Significa che la relazione descritta non impone un ordine causale fra gli eventi. Dal disegno possiamo aggiungere un evento d su un processo che non partecipa alla catena. Senza altre dipendenze, confrontare l’orario scritto vicino a d con quello di a non costruisce un arco causale.',
      'Un orologio logico scalare assegna numeri agli eventi in modo da rispettare una condizione: se a precede causalmente b, allora il numero di a è minore del numero di b. Il contrario non è garantito. Due numeri diversi possono essere assegnati anche a eventi concorrenti. Perciò leggere C(a) minore di C(b) non basta a concludere che a abbia causato o preceduto causalmente b. Questa distinzione è essenziale quando si interpreta un registro di esecuzione.',
      'Nella dimostrazione il processo P incrementa il proprio contatore prima di inviare il messaggio. Il messaggio porta quel valore. Q, alla ricezione, porta il proprio contatore oltre sia il valore locale sia quello ricevuto. Così il numero della ricezione supera quello dell’invio. Se Q aveva già un valore maggiore, il contatore continua comunque ad avanzare. Stiamo mostrando la condizione dell’orologio logico, non una misura della durata del viaggio del messaggio.',
      'Per costruire un ordinamento totale degli eventi si può aggiungere una regola deterministica di spareggio fra identificatori dei processi quando i contatori coincidono. Un ordine totale così costruito può essere utile per coordinare decisioni, ma ordina anche coppie che non avevano un ordine causale. Non bisogna confondere la comodità operativa della lista risultante con informazioni ulteriori su quali eventi dipendessero da altri.',
      'Passiamo alla gestione del laboratorio. Ogni gruppo avrà tre contenitori e un’interfaccia per inserire ritardi artificiali. I comandi di installazione sono nel documento di esercitazione. Le immagini dei contenitori devono essere scaricate prima della sessione per evitare che la connessione dell’aula diventi il collo di bottiglia. La macchina di un partecipante può ospitare tutti e tre i contenitori, purché i processi rimangano distinguibili nei registri.',
      'Il registro degli eventi del laboratorio viene scritto in un file locale per processo. Per unire questi file dobbiamo decidere quali campi esportare, come codificare le stringhe e come segnalare una riga incompleta. Useremo un formato strutturato con un identificatore della richiesta. La scelta del formato di serializzazione facilita l’analisi, ma non aggiunge da sola garanzie di consegna o ordine ai messaggi trasportati dalla rete.',
      'Nella prossima lezione introdurremo gli orologi vettoriali. Conserveremo una componente per processo e useremo il confronto componente per componente. Il costo della rappresentazione crescerà con il numero delle componenti mantenute. In sistemi con partecipanti dinamici ci saranno ulteriori problemi di gestione degli identificatori e dello stato. Per oggi è sufficiente riconoscere perché un unico numero non descrive tutte le relazioni di dipendenza.',
    ],
  },
  {
    title: 'Una catena di messaggi fra tre processi',
    segments: [
      'Questa esercitazione usa una simulazione di una chat. Non studiamo il protocollo completo della chat, né vogliamo valutare quale interfaccia sia migliore. I rettangoli rappresentano processi e le frecce rappresentano messaggi. Il colore aiuta a seguire un messaggio da una riga all’altra, mentre il nome del processo distingue chi esegue l’evento. Fermate il video quando serve per ricostruire il percorso con carta e penna.',
      'Alice scrive una domanda nel processo P. P spedisce il messaggio a Q. Il processo Q riceve la domanda e soltanto dopo produce una risposta che invia a R. R riceve quella risposta. La domanda precede la sua ricezione, la ricezione precede la risposta nell’ordine locale di Q, e l’invio della risposta precede la ricezione su R. Per transitività, l’evento iniziale sul processo P precede causalmente la ricezione finale sul processo R.',
      'Ora aggiungiamo sul processo S un evento che cambia il colore di un indicatore, senza scambiare messaggi con gli altri processi. Il fatto che nell’animazione appaia più in alto o più in basso non basta a stabilire una dipendenza. Se nessuna catena di eventi locali e messaggi collega due eventi, essi possono essere concorrenti nel modello, anche se una registrazione video li mostra in momenti diversi.',
      'Il punto da osservare è la catena di frecce, non la velocità dell’animazione. In questa prova rallentiamo il messaggio fra Q e R, mentre lasciamo invariato quello fra P e Q. Il ritardo cambia la durata dell’esecuzione, ma non elimina la dipendenza: R riceve sempre un messaggio che Q ha potuto costruire dopo la domanda iniziale. La relazione causale segue l’informazione, non il numero di fotogrammi trascorsi.',
      'Per rendere leggibile la dimostrazione abbiamo distanziato le linee e semplificato le etichette. In un registro reale gli eventi possono essere molto più numerosi e intercalati. Una richiesta può generare più messaggi e uno stesso processo può gestire molte richieste. Gli identificatori di correlazione aiutano a ricostruire una specifica catena, ma bisogna anche considerare gli eventi locali che collegano ricezioni e invii.',
      'La finestra a destra contiene le impostazioni dell’animazione. Il primo cursore regola il ritardo, il secondo il numero di messaggi e il terzo il fattore di scala. Un valore più alto del fattore di scala rende il disegno più grande sullo schermo. Se un’etichetta esce dall’area visibile, riportate il fattore al valore precedente. Questi comandi servono alla presentazione e non fanno parte del modello causale.',
      'Una perdita di messaggio richiederebbe un esperimento diverso. Potremmo scegliere di ritrasmettere, oppure di restituire un errore al mittente dopo una scadenza. Queste strategie hanno costi e conseguenze diverse, e una ritrasmissione può creare duplicati. Non le aggiungiamo alla dimostrazione di oggi, che osserva soltanto messaggi effettivamente inviati e ricevuti.',
      'Il materiale del laboratorio comprende una traccia vuota da completare. Provate prima a segnare gli ordini locali, poi gli archi di comunicazione e infine le conseguenze della transitività. Discuteremo le soluzioni nel prossimo incontro. Se volete proporre una variante della simulazione, consegnate un disegno con i nomi dei processi e una descrizione degli eventi che avete aggiunto.',
    ],
  },
  {
    title: 'Orologi logici: ripasso prima degli esami',
    segments: [
      'Ripassiamo alcune domande tipiche dell’esame. La prima riguarda la differenza fra osservare due valori in un registro e dimostrare una dipendenza. Il registro è una rappresentazione prodotta dal sistema. Per usarlo correttamente dobbiamo sapere come sono assegnati i valori e quali proprietà garantisce l’algoritmo. Una colonna numerica ordinata non descrive automaticamente una storia causale completa.',
      'La condizione degli orologi scalari dice che a prima di b nella relazione causale implica C(a) minore di C(b). Non si può invertire l’implicazione. C(a) minore di C(b) è compatibile anche con due eventi concorrenti. Per provare una dipendenza bisogna tornare all’ordine locale e ai messaggi, oppure usare una rappresentazione che consenta il confronto causale richiesto.',
      'Ricordiamo anche la transitività della relazione. Quando un processo riceve una richiesta e in seguito invia una risposta, la risposta è collegata alla ricezione dall’ordine degli eventi locali. La ricezione era collegata all’invio originario dal messaggio. Componendo questi archi otteniamo la dipendenza fra l’invio originario e la risposta. Scrivere tutti gli archi prima di semplificare il disegno evita di saltare un passaggio.',
      'Nella parte restante del ripasso parliamo di replica dei dati. La replica può migliorare disponibilità e tempi di accesso in alcune situazioni, ma richiede un protocollo per coordinare o riconciliare gli aggiornamenti. La scelta dipende dalle operazioni ammesse, dagli errori previsti e dalle proprietà richieste dall’applicazione. Due copie non diventano coerenti per il solo fatto di contenere inizialmente gli stessi dati.',
      'Una cache conserva risultati per riusarli e ridurre lavoro successivo. Per usarla occorre definire quando un risultato è valido e quando deve essere aggiornato. Un valore ottenuto da una replica può essere vecchio rispetto a un aggiornamento già accettato altrove. La durata di conservazione è una decisione della specifica applicazione e non si deduce dagli orologi logici senza conoscere il protocollo.',
      'Parliamo infine di bilanciamento del carico. Una politica può assegnare richieste a nodi diversi sulla base dello stato osservato, ma lo stato può cambiare mentre la decisione viene comunicata. Misurare soltanto il numero di richieste non descrive sempre il costo del lavoro, perché richieste diverse possono richiedere quantità diverse di risorse. Le prove devono dichiarare il carico e il comportamento che stanno misurando.',
    ],
  },
  {
    title: 'Storia degli strumenti di programmazione',
    segments: [
      'In questa conferenza seguiamo l’evoluzione degli strumenti usati per scrivere programmi. Una prima distinzione riguarda il supporto materiale con cui il testo veniva preparato e consegnato alla macchina. Le procedure di lavoro dipendevano dalla disponibilità delle apparecchiature e dal modo in cui venivano organizzati i turni. Non possiamo descrivere tutte le epoche con l’immagine del personal computer sulla scrivania.',
      'Gli editor interattivi hanno cambiato il modo di correggere un programma. Poter spostare un cursore, inserire una riga e salvare una versione rende alcune operazioni immediate. Il beneficio concreto dipende però anche dal linguaggio, dagli strumenti di compilazione e dalla disponibilità di messaggi di errore comprensibili. L’editor è una parte dell’ambiente di lavoro, non l’intero processo di sviluppo.',
      'La compilazione trasforma una rappresentazione del programma in un’altra secondo regole definite. Alcuni errori si possono rilevare durante questa trasformazione, altri compaiono soltanto quando il programma viene eseguito con dati specifici. Un messaggio di compilazione utile deve indicare dove il compilatore ha incontrato un problema e quale aspettativa è stata violata, evitando di confondere la causa con gli errori successivi che ne derivano.',
      'I sistemi di controllo delle versioni conservano la storia delle modifiche. Un gruppo può usarli per confrontare due versioni, recuperare una modifica precedente e coordinare il lavoro su parti diverse di un progetto. La qualità della collaborazione dipende anche dalle convenzioni del gruppo: una descrizione chiara della modifica aiuta chi dovrà leggerla in seguito, mentre una modifica enorme rende il confronto più faticoso.',
      'La documentazione di un’interfaccia deve chiarire quali operazioni sono disponibili e quali condizioni richiedono. Gli esempi possono mostrare un percorso d’uso, ma non sostituiscono tutte le informazioni sulle precondizioni e sui risultati. Una documentazione che descrive soltanto i nomi dei parametri costringe il lettore a ricostruire il comportamento dal codice o da esperimenti.',
      'Concludiamo la conferenza con una visita alla collezione di terminali. Le fotografie mostrano differenze nelle tastiere, nei caratteri visualizzati e nel collegamento alle macchine centrali. Alcuni esemplari sono ancora funzionanti, altri sono stati conservati per il loro valore storico. La scheda di ogni oggetto indica provenienza e interventi di restauro documentati dal museo.',
    ],
  },
];

export const evidenceSources: ResearchSource[] = [
  {
    title: 'Appunti del corso',
    sourceId: 'course-notes',
    pageStart: 12,
    pageEnd: 14,
    chunkIds: ['causality'],
  },
  ...lectures.map((lecture, index) => ({
    title: lecture.title,
    url: `https://www.youtube.com/watch?v=fixture-${index}`,
    sourceId: `lecture-${index}`,
    youtubeTranscript: {
      segments: lecture.segments.map((text, segmentIndex) => ({
        text,
        startSeconds: segmentIndex * 45 + 0.25,
        endSeconds: (segmentIndex + 1) * 45 + 0.5,
      })),
    },
  })),
];

export const evidencePrimaryContext = [
  'SOURCE course-notes | CHUNK causality | PAGES 12-14',
  'Un evento è un passo di un processo. L’ordine locale di un processo e il collegamento fra invio e ricezione dello stesso messaggio definiscono la relazione di precedenza causale, insieme alla transitività.',
  'Se a precede causalmente b e b precede causalmente c, allora a precede causalmente c. Se nessuno dei due eventi precede causalmente l’altro, gli eventi sono concorrenti. Concorrenza non equivale necessariamente a simultaneità fisica.',
  'Gli orologi scalari rispettano la condizione: a precede causalmente b implica C(a) < C(b). L’implicazione inversa non vale. Valori ordinati non bastano a provare una dipendenza.',
  'Il modulo successivo studia la replica dei dati, le operazioni concorrenti e la riconciliazione degli aggiornamenti. Questi argomenti richiedono un contratto sulle operazioni del servizio e sul comportamento in caso di errore.',
].join('\n');

export const evidenceResearch = {
  factualSummary:
    'La precedenza causale deriva da ordine locale, messaggi e transitività. Gli orologi scalari rispettano la relazione ma non ne provano il contrario.',
  keyExamples: [
    'Una domanda attraversa P, Q e R; la risposta su R dipende dall’invio originario su P.',
  ],
  difficultSteps: ['Distinguere concorrenza da simultaneità e un’implicazione dalla sua inversa.'],
  avoidOversimplifying: ['Non dedurre causalità da valori scalari ordinati.'],
  controversies: [],
  recentDevelopments: [],
  sources: [],
  youtubeCandidateDecisions: lectures.map((_, index) => ({
    url: `https://www.youtube.com/watch?v=fixture-${index}`,
    decision: 'selected-source' as const,
    reason: 'Da ispezionare rispetto alla lezione.',
  })),
};

export const evidenceLesson: LessonContentDraft = {
  contentBlocks: [
    {
      type: 'markdown',
      markdown:
        '## Seguire una dipendenza\n\nUn evento è un passo compiuto da un processo, per esempio inviare o ricevere un messaggio. Per capire quali eventi dipendono da altri seguiamo prima l’ordine locale di ogni processo e poi i messaggi fra processi. L’invio di un messaggio precede la ricezione dello stesso messaggio.\n\nPossiamo unire questi collegamenti grazie alla transitività: se a precede causalmente b e b precede causalmente c, allora a precede causalmente c. Immaginiamo che P spedisca una domanda a Q, che Q la riceva e poi invii una risposta a R. L’invio iniziale su P precede causalmente la ricezione finale su R. Nel video segui la domanda e la risposta lungo le frecce: il ritardo dell’animazione cambia la durata, ma non elimina la dipendenza.',
    },
    {
      type: 'youtube-clips',
      clips: [
        {
          sourceIndex: 2,
          startSeconds: 45.25,
          endSeconds: 180.5,
          title: 'La domanda da P a Q e la risposta a R',
        },
      ],
    },
    {
      type: 'markdown',
      markdown:
        '## Due eventi senza un ordine causale\n\nSe nessuno dei due eventi precede causalmente l’altro, li chiamiamo concorrenti. Questo non richiede che avvengano nello stesso istante fisico. Per stabilire una dipendenza occorre una catena nel modello.\n\nUn orologio logico scalare assegna numeri che rispettano la precedenza: se a precede causalmente b, allora C(a) < C(b). Il verso inverso non è garantito. Anche eventi concorrenti possono avere numeri diversi, perciò un numero più piccolo non prova da solo una precedenza causale.',
    },
    {
      type: 'inline-quiz',
      quiz: {
        exerciseType: 'concept-check',
        question:
          'Nel registro C(a) < C(b). Che cosa puoi concludere usando soltanto questi due valori?',
        options: [
          'Non basta per dimostrare che a precede causalmente b.',
          'a precede sicuramente causalmente b.',
          'b precede sicuramente causalmente a.',
          'I due eventi sono avvenuti nello stesso istante fisico.',
        ],
        correctIndex: 0,
        explanation:
          'L’orologio scalare garantisce che la precedenza causale implica valori crescenti, ma non il contrario. I soli valori non dimostrano la precedenza di a su b, non dimostrano una precedenza inversa e non stabiliscono simultaneità fisica.',
      },
    },
  ],
  generatedVisuals: [],
  imageRefs: [],
};
