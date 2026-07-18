export const SUPPORTED_APP_LOCALES = ['en', 'it'] as const;

export type AppLocale = (typeof SUPPORTED_APP_LOCALES)[number];

type UiMessageVariables = Record<string, number | string>;

const DEFAULT_APP_LOCALE: AppLocale = 'en';
const supportedLocales = new Set<string>(SUPPORTED_APP_LOCALES);
let renderingLocaleOverride: AppLocale | null = null;

const ENGLISH_UI_MESSAGES = {
  'Apri {videoTitle} su YouTube': 'Open {videoTitle} on YouTube',
  automatico: 'automatic',
  'Annulla creazione corso': 'Cancel course creation',
  'Argomento del nuovo corso non valido.': 'Invalid new course topic.',
  'Argomento del corso': 'Course topic',
  'Avvio nuovo corso': 'Starting new course',
  '{regenerated} di {total} cover rigenerate, {failed} non riuscite, {pending} in attesa.':
    '{regenerated} of {total} covers regenerated, {failed} failed, {pending} pending.',
  'Brief di ricerca reale': 'Actual research brief',
  'Budget token': 'Token budget',
  Candidati: 'Candidates',
  'Candidati e decisioni': 'Candidates and decisions',
  'Canale non disponibile': 'Channel unavailable',
  caratteri: 'characters',
  'Clip in produzione': 'Clips in production',
  'Anteprima video': 'Video preview',
  'Clip YouTube abilitate nella generazione': 'YouTube clips enabled in generation',
  'Intervallo di anteprima; la stesura sceglie quello definitivo':
    'Preview interval; the lesson writer chooses the final one',
  'Il modello non ha scelto una clip. Questa è l’anteprima del miglior intervallo timestampato disponibile.':
    'The model did not select a clip. This previews the best timestamped interval available.',
  'Nessun intervallo YouTube timestampato disponibile per l’anteprima.':
    'No timestamped YouTube interval is available for preview.',
  'Contesto transcript inviato': 'Transcript context sent',
  cache: 'cache',
  'Diagnostica temporanea': 'Temporary diagnostics',
  'Decisioni isolate del modello': 'Isolated model decisions',
  'Per ogni candidato mostra l’esito strutturato e la motivazione sintetica restituita dal modello.':
    'Shows the structured outcome and concise model-provided reason for every candidate.',
  'Esegue la stessa ricerca e raccolta transcript Decodo usata per una lezione. Non salva nulla.':
    'Runs the same search and Decodo transcript collection used for a lesson. Nothing is saved.',
  'Esegui il percorso reale': 'Run the actual pipeline',
  Esecuzione: 'Run',
  disponibile: 'available',
  vuoto: 'empty',
  'Laboratorio YouTube non disponibile.': 'YouTube lab is unavailable.',
  Lingua: 'Language',
  manuale: 'manual',
  'Nessun transcript è entrato nel contesto. La valutazione dei modelli non è stata eseguita per evitare due chiamate inutili.':
    'No transcript entered the context. Model evaluation was skipped to avoid two useless calls.',
  'Nessuna motivazione restituita.': 'No reason returned.',
  'Non valutabile come clip: è una playlist': 'Not eligible as a clip: this is a playlist',
  'Non valutato: il transcript non è entrato nel contesto':
    'Not evaluated: the transcript did not enter the context',
  'Non eseguito': 'Not run',
  'Non propagato nel dossier': 'Not propagated to the dossier',
  'Non interrogato: budget esaurito': 'Not queried: budget exhausted',
  'Opzionale: per esempio bordi, curve, sfumature e texture':
    'Optional: for example outlines, curves, gradients, and textures',
  Playlist: 'Playlist',
  punteggio: 'score',
  'Query reale': 'Actual query',
  'Richieste modello': 'Model requests',
  'Ricerca e transcript reali…': 'Actual search and transcripts…',
  'Scartato: espansione playlist fallita': 'Rejected: playlist expansion failed',
  'Scartato: budget transcript esaurito': 'Rejected: transcript budget exhausted',
  'Scartato: limite del contesto': 'Rejected: context limit',
  'Scartato: limite di transcript': 'Rejected: transcript limit',
  'Scartato: transcript non disponibile': 'Rejected: transcript unavailable',
  'Scartato dal modello': 'Rejected by the model',
  'Scartato: viene espansa solo la prima playlist': 'Rejected: only the first playlist is expanded',
  'Scelto come fonte video': 'Selected as a video source',
  'Anteprima diagnostica del primo intervallo timestampato. La stesura sceglierà la clip effettiva nel contesto della lezione.':
    'Diagnostic preview of the first timestamped interval. The lesson writer will choose the actual clip in context.',
  'Nessun video è stato selezionato. Questa è l’anteprima del primo intervallo timestampato disponibile.':
    'No video was selected. This is a preview of the first available timestamped interval.',
  segmenti: 'segments',
  'Tempo totale': 'Total time',
  'Richieste transcript API': 'Transcript API requests',
  'Tentativi modello': 'Model attempts',
  'Tentativi transcript': 'Transcript attempts',
  tentativi: 'attempts',
  'Titolo o obiettivo della lezione': 'Lesson title or objective',
  'Transcript incluso nel contesto': 'Transcript included in context',
  'Ricerca modello': 'Model research',
  'Strutturazione modello': 'Model structuring',
  tradotto: 'translated',
  'Valutazione con i modelli di produzione…': 'Evaluation with production models…',
  visualizzazioni: 'views',
  riservato: 'reserved',
  Residuo: 'Remaining',
  Usato: 'Used',
  'Stima conservativa: caratteri diviso 4, arrotondati per eccesso.':
    'Conservative estimate: characters divided by 4, rounded up.',
  'Ogni transcript usa al massimo metà del budget residuo; se è più lungo viene escluso senza selezioni per keyword.':
    'Each transcript uses at most half of the remaining budget; longer transcripts are excluded without keyword selection.',
  'Discovery attuale: {videos} video complessivi da {playlists} playlist. I transcript continuano finché c’è budget, con concorrenza {concurrency}.':
    'Current discovery: {videos} total videos from {playlists} playlists. Transcripts continue while budget remains, with concurrency {concurrency}.',
  'Limite noto: il web search dipende ancora dal provider attivo; questo laboratorio isola la pipeline YouTube.':
    'Known limitation: web search still depends on the active provider; this lab isolates the YouTube pipeline.',
  'Playlist espansa': 'Playlist expanded',
  'Aggiungi ai preferiti': 'Add to favorites',
  'Aggiungi {courseTitle} ai preferiti': 'Add {courseTitle} to favorites',
  'Aiutami a ripassare il corso': 'Help me review the course:',
  'Apri corso': 'Open course',
  'Apri i materiali originali dei tuoi corsi e torna subito alla fonte che ti serve.':
    'Open the original materials from your courses and quickly return to the source you need.',
  'Apro il corso...': 'Opening the course...',
  'Azioni per la cartella {folderName}': 'Actions for the {folderName} folder',
  'Azioni per {courseTitle}': 'Actions for {courseTitle}',
  'Caricamento dei corsi...': 'Loading courses...',
  'Caricamento PDF...': 'Loading PDF...',
  Cartella: 'Folder',
  'Cerca nei tuoi corsi...': 'Search your courses...',
  'Cerca nella Libreria...': 'Search the Library...',
  'Chiudi azioni cartella': 'Close folder actions',
  'Chiudi azioni corso': 'Close course actions',
  'Chiudi fonte': 'Close source',
  'Comprimi {folderName}': 'Collapse {folderName}',
  'Copertina di {courseTitle}': 'Cover for {courseTitle}',
  'Cosa vuoi': 'What do you want',
  'Crea delle flashcard di ripasso come artefatto HTML per il corso':
    'Create review flashcards as an HTML artifact for the course:',
  'Crea flashcard di ripasso': 'Create review flashcards',
  'Crea un nuovo corso o interroga i tuoi corsi per esplorare, chiarire e collegare le tue conoscenze.':
    'Create a new course or ask questions about your courses to explore, clarify, and connect your knowledge.',
  'Espandi {folderName}': 'Expand {folderName}',
  'Fai una domanda o allega una fonte...': 'Ask a question or attach a source...',
  'File originale non disponibile': 'Original file unavailable',
  Home: 'Home',
  'I tuoi corsi': 'Your courses',
  'Impara un nuovo argomento': 'Learn a new topic',
  imparare: 'to learn',
  'Learning streak': 'Learning streak',
  'Le tue fonti, tutte insieme': 'All your sources, together',
  'Lezione {lessonNumber} di {lessonCount}': 'Lesson {lessonNumber} of {lessonCount}',
  'Media completamento': 'Average completion',
  'Mostra altri filtri': 'Show more filters',
  'Mostra i filtri precedenti': 'Show previous filters',
  'Nessun corso corrisponde a questa ricerca.': 'No courses match this search.',
  'Nessuna fonte corrisponde a questa ricerca.': 'No sources match this search.',
  Nome: 'Name',
  'nome del corso': 'course name',
  'Non hai ancora aggiunto corsi ai preferiti.': 'You have not added any courses to favorites yet.',
  'oggi?': 'today?',
  Preferiti: 'Favorites',
  Progresso: 'Progress',
  'Raccolgo le fonti dei tuoi corsi...': 'Collecting sources from your courses...',
  'Rinomina cartella': 'Rename folder',
  'Rinomina corso': 'Rename course',
  'Ripassami un corso': 'Review a course',
  'Riprendi da dove eri': 'Continue where you left off',
  'Rimuovi dai preferiti': 'Remove from favorites',
  'Rimuovi {courseTitle} dai preferiti': 'Remove {courseTitle} from favorites',
  'Salvataggio...': 'Saving...',
  'Sto caricando le altre fonti...': 'Loading the remaining sources...',
  'Tempo di studio': 'Study time',
  Testo: 'Text',
  Tutte: 'All',
  Tutti: 'All',
  'Usa tema chiaro': 'Use light theme',
  'Usa tema scuro': 'Use dark theme',
  'Vedi tutti': 'View all',
  'Voglio che tu crei un corso su': 'I want you to create a course about',
  '{courseCount} corsi': '{courseCount} courses',
  '{lessonCount} lezioni · {lastOpenedDate}': '{lessonCount} lessons · {lastOpenedDate}',
  '{streakDays} giorni': '{streakDays} days',
  ', prestando particolare attenzione a ciò che ho annotato e sottolineato.':
    ', paying particular attention to what I annotated and highlighted.',
  ', prestando particolare attenzione a ciò che ho annotato e sottolineato, ai diagrammi e agli artefatti generati.':
    ', paying particular attention to what I annotated and highlighted, as well as the diagrams and generated artifacts.',
  Accedi: 'Sign in',
  Abilita: 'Enable',
  Aggiorna: 'Refresh',
  Amministrazione: 'Administration',
  Avanzamento: 'Progress',
  'Accedi al tuo spazio di studio per sincronizzare corsi, note e progressi.':
    'Sign in to your study space to sync courses, notes, and progress.',
  'Accesso alla preview': 'Preview access',
  'Accesso non riuscito.': 'Sign-in failed.',
  'Accesso tester': 'Tester access',
  'Anteprima del lettore Nous': 'Nous Reader preview',
  'Apri menu': 'Open menu',
  Annulla: 'Cancel',
  Fonti: 'Sources',
  'Analisi Volume in Corso...': 'Analyzing source material...',
  'Lezione in cottura...': 'Lesson in the works...',
  'Corso in preparazione...': 'Course in preparation...',
  Pronta: 'Ready',
  Pronto: 'Ready',
  Quiz: 'Quiz',
  Stesura: 'Drafting',
  Struttura: 'Structure',
  'Tempo trascorso': 'Elapsed time',
  'Elaborazione in corso': 'Working',
  Verifica: 'Review',
  'Apri progetto': 'Open project',
  'Apri cartella': 'Open folder',
  'Apri cartella {folderName}': 'Open {folderName} folder',
  'Apri menu account per {accountLabel}': 'Open account menu for {accountLabel}',
  Azioni: 'Actions',
  'Azioni cartella': 'Folder actions',
  'Azioni cartella {folderName}': '{folderName} folder actions',
  'Azioni corso {projectTitle}': '{projectTitle} course actions',
  'Account e sicurezza': 'Account and security',
  'Account gestito da un provider esterno': 'Account managed by an external provider',
  'Account utente': 'User account',
  Impostazioni: 'Settings',
  'Account Codex collegato': 'Codex account connected',
  'Area account': 'Account area',
  Feedback: 'Feedback',
  'Segnala un problema': 'Report a problem',
  'Segnala problema': 'Report a problem',
  'Chiudi segnalazione': 'Close feedback form',
  'Tipo di segnalazione': 'Feedback type',
  Problema: 'Problem',
  Suggerimento: 'Suggestion',
  'Issue GitHub': 'GitHub issue',
  Descrizione: 'Description',
  'Raccontaci cosa è successo o cosa renderesti migliore.':
    'Tell us what happened or what you would improve.',
  'Cosa stavi facendo? Cosa ti aspettavi? Cosa è successo invece?':
    'What were you doing? What did you expect? What happened instead?',
  'Scrivi oppure usa il microfono': 'Type or use the microphone',
  'Allega diagnostica tecnica': 'Attach technical diagnostics',
  'Include pagina e log recenti raccolti da Nous. Token, email e parametri degli URL vengono rimossi.':
    'Includes the page and recent logs collected by Nous. Tokens, emails, and URL parameters are removed.',
  'Anteprima diagnostica ({entryCount} log)': 'Diagnostics preview ({entryCount} logs)',
  'Nessun log recente disponibile.': 'No recent logs available.',
  'Aggiungi uno screenshot': 'Add a screenshot',
  'Acquisizione in corso...': 'Capturing...',
  'Facoltativo. Il browser ti chiederà quale pagina condividere.':
    'Optional. Your browser will ask which page to share.',
  'Anteprima screenshot allegato': 'Attached screenshot preview',
  'Screenshot allegato': 'Screenshot attached',
  'Controlla che non mostri informazioni che non vuoi condividere.':
    'Make sure it does not show information you do not want to share.',
  'Rimuovi screenshot': 'Remove screenshot',
  'Screenshot non acquisito. Puoi comunque inviare la segnalazione senza allegato.':
    'The screenshot was not captured. You can still send the feedback without it.',
  'Invia segnalazione': 'Send feedback',
  'Invio in corso...': 'Sending...',
  'Invio non riuscito. Controlla la connessione e riprova.':
    'Sending failed. Check your connection and try again.',
  'Segnalazione inviata': 'Feedback sent',
  'Grazie. La segnalazione è arrivata e può essere seguita dal team.':
    'Thank you. The feedback was received and can be followed up by the team.',
  'Riferimento: {feedbackId}': 'Reference: {feedbackId}',
  Segnalazioni: 'Reports',
  Configurazione: 'Configuration',
  'Sezioni amministrazione': 'Administration sections',
  'Accessi e ruoli': 'Access and roles',
  'Cerca utenti': 'Search users',
  'Cerca per email o ID': 'Search by email or ID',
  'Cerca in questa pagina per email o ID': 'Search this page by email or ID',
  'Caricamento utenti non riuscito.': 'Users could not be loaded.',
  'Nessun utente corrisponde alla ricerca.': 'No users match this search.',
  'Pagine utenti': 'User pages',
  'Pagine segnalazioni': 'Report pages',
  'Pagina precedente': 'Previous page',
  'Pagina successiva': 'Next page',
  'Pagina {currentPage}': 'Page {currentPage}',
  'Pagina {currentPage} di {pageCount}': 'Page {currentPage} of {pageCount}',
  'Motore di Nous': 'Nous engine',
  'Apri solo il provider che devi modificare. Le impostazioni restano separate e leggibili.':
    'Open only the provider you need to edit. Settings stay separate and readable.',
  'Provider attivo': 'Active provider',
  Configurato: 'Configured',
  'Voce degli utenti': 'What users are saying',
  '{feedbackCount} segnalazioni ricevute': '{feedbackCount} reports received',
  'Nessuna segnalazione': 'No reports',
  'Quando un utente invia un feedback, comparirà qui.':
    'When a user submits feedback, it will appear here.',
  'Segnalazioni non disponibili. Riprova.': 'Reports are unavailable. Try again.',
  'Sincronizza GitHub': 'Sync GitHub',
  'Sincronizzazione GitHub non riuscita. Riprova.': 'GitHub sync failed. Try again.',
  '{issueCount} issue sincronizzate da GitHub alle {syncTime}.':
    '{issueCount} GitHub issues synced at {syncTime}.',
  'Screenshot non disponibile.': 'Screenshot unavailable.',
  'Caricamento screenshot…': 'Loading screenshot…',
  'Segnalazione rimessa in coda.': 'Report queued again.',
  'Nuovo tentativo non riuscito. Riprova.': 'Retry failed. Try again.',
  'Invio fallito': 'Failed',
  'In attesa': 'Pending',
  'Invio in corso': 'Sending',
  Pubblicata: 'Published',
  'Aperta su GitHub': 'Open on GitHub',
  'Chiusa su GitHub': 'Closed on GitHub',
  'Non trovata su GitHub': 'Not found on GitHub',
  'Etichette GitHub': 'GitHub labels',
  'Utente autenticato': 'Authenticated user',
  'Riprova pubblicazione': 'Retry publishing',
  Diagnostica: 'Diagnostics',
  Pagina: 'Page',
  Versione: 'Version',
  'Screenshot della segnalazione': 'Report screenshot',
  'Log della console ({logCount})': 'Console logs ({logCount})',
  'Apri issue #{issueNumber} su GitHub': 'Open issue #{issueNumber} on GitHub',
  'Backup completo dei corsi': 'Complete course backup',
  'Backup di {courseCount} corsi esportato.': 'Backup of {courseCount} courses exported.',
  'Annullamento della connessione non riuscito. Riprova.':
    'Could not cancel the connection. Try again.',
  'Apri accesso OpenAI': 'Open OpenAI sign-in',
  'Apri la pagina OpenAI e inserisci questo codice:': 'Open the OpenAI page and enter this code:',
  'Avvia cambio email': 'Start email change',
  'Autenticazione non configurata. Imposta VITE_AUTH_MODE=supabase e collega Supabase per accedere alla libreria server.':
    'Authentication is not configured. Set VITE_AUTH_MODE=supabase and connect Supabase to access the server library.',
  'Aggiungi PDF e libri, oppure parti da una ricerca guidata.':
    'Add PDFs and books, or start from guided research.',
  Calibrazione: 'Calibration',
  'Cambia tema': 'Change theme',
  'Caricamento...': 'Loading...',
  'Preparazione fonti... {completed}/{total}': 'Preparing sources... {completed}/{total}',
  Chiudi: 'Close',
  'Chiudi accesso': 'Close access',
  'Chiudi menu': 'Close menu',
  'Chiudi conferma': 'Close confirmation',
  'Chiudi menu progetto': 'Close project menu',
  'Chiudi cartella': 'Close folder',
  'Chiudi cartella {folderName}': 'Close {folderName} folder',
  'Chiudi menu cartella': 'Close folder menu',
  'Chiudi area account': 'Close account area',
  'Chiudi menu account': 'Close account menu',
  'Chiudi spostamento': 'Close move dialog',
  'Cambio email non riuscito. Riprova.': 'Could not change the email. Try again.',
  'Cambio password non riuscito. Riprova.': 'Could not change the password. Try again.',
  'Cambia password': 'Change password',
  'Cartella creata.': 'Folder created.',
  'Cartella rinominata.': 'Folder renamed.',
  'Controlla la posta per confermare il nuovo indirizzo email.':
    'Check your inbox to confirm the new email address.',
  'Costruzione piano...': 'Building learning plan...',
  'Contenuto cartella {folderName}': '{folderName} folder contents',
  Contesto: 'Context',
  'Capire il collo di bottiglia che seleziona ciò che elaboriamo.':
    'Understand the bottleneck that selects what we process.',
  'Ciò che riceve attenzione ha più probabilità di entrare nella memoria di lavoro. Ripetere, collegare e recuperare attivamente quell’informazione rende poi più stabile la traccia nella memoria a lungo termine.':
    'What receives attention is more likely to enter working memory. Repetition, connection, and active retrieval then make that trace more stable in long-term memory.',
  'Generazione della lezione': 'Lesson generation',
  'In ogni istante arrivano più segnali di quanti il cervello possa elaborare in profondità. L’attenzione risolve questo squilibrio: **seleziona cosa riceverà risorse cognitive** e cosa resterà sullo sfondo.':
    'At every moment, more signals arrive than the brain can process in depth. Attention resolves this imbalance: it **selects what receives cognitive resources** and what remains in the background.',
  'Inserisco una pausa attiva per verificare la distinzione tra selezione e memoria.':
    'I am adding an active pause to check the distinction between selection and memory.',
  'La memoria di lavoro mantiene disponibili, per pochi secondi, le informazioni che stai usando. È lo spazio mentale in cui confronti un esempio con una regola, segui un ragionamento o componi una risposta.':
    'Working memory keeps the information you are using available for a few seconds. It is the mental space where you compare an example with a rule, follow an argument, or compose an answer.',
  'Parte 1 — Il collo di bottiglia': 'Part 1 — The bottleneck',
  'Parte 2 — Dalla selezione alla memoria': 'Part 2 — From selection to memory',
  'Qual è la funzione principale dell’attenzione in questa lezione?':
    'What is the main function of attention in this lesson?',
  'Stati del corso demo': 'Demo course states',
  'Tentare di recuperare una risposta rende la traccia più accessibile. Le domande brevi non sono un’interruzione della lezione: sono parte del processo con cui la conoscenza diventa utilizzabile.':
    'Trying to retrieve an answer makes the trace more accessible. Short questions are not an interruption to the lesson; they are part of the process that makes knowledge usable.',
  'Quando due compiti chiedono la stessa risorsa nello stesso momento, le prestazioni peggiorano. Non è mancanza di volontà: è un limite del sistema. Per questo una lezione efficace riduce le decisioni accessorie e rende evidente il prossimo passo.':
    'When two tasks need the same resource at the same time, performance drops. It is not a lack of willpower; it is a system limit. An effective lesson therefore reduces secondary decisions and makes the next step obvious.',
  Continua: 'Continue',
  Corso: 'Course',
  'Corsi che capisci davvero': 'Courses you truly understand',
  'Corso {projectTitle}': 'Course {projectTitle}',
  'Cartella {folderName}': 'Folder {folderName}',
  corsi: 'courses',
  'Chiedi a Nous': 'Ask Nous',
  'COME FUNZIONA': 'HOW IT WORKS',
  'Come funziona': 'How it works',
  'Come viaggiano i dati': 'How data travels',
  'Descrivi obiettivi, livello e come preferisci imparare…':
    'Describe your goals, current level, and how you prefer to learn…',
  Elimina: 'Delete',
  'Dal materiale a un percorso.': 'From source material to a learning path.',
  'Dal problema della comunicazione': 'The problem of communication',
  'Dalle fonti a un percorso': 'From sources to a learning path',
  'Dentro Internet': 'Inside the Internet',
  'Domande dentro il contesto': 'Questions within context',
  'Eliminare cartella': 'Delete folder',
  'Eliminare corso': 'Delete course',
  'Eliminare la cartella "{folderName}"? I corsi e le sottocartelle verranno riportati al livello superiore.':
    'Delete the folder "{folderName}"? Its courses and subfolders will be moved to the parent level.',
  'Eliminare "{projectTitle}" dalla libreria server?':
    'Delete "{projectTitle}" from the server library?',
  Esporta: 'Export',
  'Esportazione...': 'Exporting...',
  'Esportazione non riuscita. Riprova.': 'Export failed. Try again.',
  'Esportazione del backup completo non riuscita. Riprova.':
    'Complete backup export failed. Try again.',
  'Esportazione in corso...': 'Exporting...',
  'Esporta tutti i corsi': 'Export all courses',
  'Esporta tutti i corsi e le fonti in un unico file. Puoi importarlo in un altra installazione di Nous.':
    'Export every course and its sources into one file. You can import it into another Nous installation.',
  'Corso esportato. Il download è iniziato.': 'Course exported. The download has started.',
  'Dati account temporaneamente non disponibili. Riprova.':
    'Account details are temporarily unavailable. Try again.',
  'Dati e backup': 'Data and backup',
  'Disconnetti Codex': 'Disconnect Codex',
  'Disconnessione da Codex non riuscita. Riprova.': 'Could not disconnect from Codex. Try again.',
  'Email attuale': 'Current email',
  'Email per invito o accesso': 'Email for invitation or sign-in',
  'Email nuovo account': 'New account email',
  'Email di recupero inviata.': 'Recovery email sent.',
  'Email e password si gestiscono presso il provider usato per accedere. Nous non mostra azioni non applicabili a questo account.':
    'Email and password are managed by the provider used to sign in. Nous does not show actions that do not apply to this account.',
  'Email non disponibile': 'Email unavailable',
  'Elemento spostato.': 'Item moved.',
  Evidenzia: 'Highlight',
  'Fai domande, ottieni spiegazioni e verifica la tua comprensione.':
    'Ask questions, get explanations, and check your understanding.',
  'Email per la waitlist': 'Waitlist email',
  'Entra nella waitlist': 'Join the waitlist',
  Importa: 'Import',
  'Importa tutti i corsi': 'Import all courses',
  'Importazione del backup completo non riuscita. Controlla il file e riprova.':
    'Complete backup import failed. Check the file and try again.',
  'Importazione in corso...': 'Importing...',
  'Codice assistenza: {correlationId}.': 'Support code: {correlationId}.',
  'Il problema della comunicazione': 'The problem of communication',
  'Il protocollo è un accordo: stabilisce forma, ordine e significato dei messaggi.':
    'A protocol is an agreement: it defines the form, order, and meaning of messages.',
  'Impara un argomento intero, un passo alla volta.': 'Learn a whole subject, one step at a time.',
  'Impara a modo tuo': 'Learn your way',
  'Impara senza perdere il filo': 'Learn without losing the thread',
  'Imparare un soggetto intero, senza perdere il filo.':
    'Learn a whole subject without losing the thread.',
  'Indice del corso': 'Course outline',
  'Inserisci un indirizzo email valido.': 'Enter a valid email address.',
  'Imposta password ed entra': 'Set password and continue',
  'Non è stato possibile salvare la password. Riprova; se il link è scaduto, richiedine uno nuovo.':
    'Could not save the password. Try again; if the link expired, request a new one.',
  'Non è stato possibile salvare la password. Riprova tra poco.':
    'Could not save the password. Try again shortly.',
  'Invio in corso…': 'Sending…',
  'Importa backup Nous (.nous.zip, formato legacy o JSON legacy)':
    'Import Nous backup (.nous.zip, legacy format, or legacy JSON)',
  Invia: 'Send',
  'Invia email': 'Send email',
  'Inserisci una password.': 'Enter a password.',
  "Invio dell'email di accesso non riuscito.": 'Could not send the access email.',
  'Invio magic link non riuscito.': 'Could not send the magic link.',
  'Invia link di accesso': 'Send sign-in link',
  'Invia link di accesso a {userEmail}': 'Send sign-in link to {userEmail}',
  'Invia link per completare l’account': 'Send account setup link',
  'Invia link per completare l’account a {userEmail}': 'Send account setup link to {userEmail}',
  'Invia email di recupero': 'Send recovery email',
  'Invio email di recupero non riuscito. Riprova.': 'Could not send the recovery email. Try again.',
  'Interroga e verifica': 'Ask and check your understanding',
  'La richiesta non è disponibile in questo momento. Riprova più tardi.':
    'The request is unavailable right now. Try again later.',
  'La password è troppo debole. Scegline una più lunga e difficile.':
    'The password is too weak. Choose a longer, harder-to-guess password.',
  'La tua email': 'Your email',
  'Le password non coincidono.': 'Passwords do not match.',
  lezioni: 'lessons',
  Libreria: 'Library',
  Logout: 'Sign out',
  'Logout in corso...': 'Signing out...',
  'Logout non riuscito. Riprova.': 'Could not sign out. Try again.',
  'Menu account': 'Account menu',
  'Metodo di accesso: {providers}': 'Sign-in method: {providers}',
  'Nuova password': 'New password',
  'Conferma password': 'Confirm password',
  'Nuovo indirizzo email': 'New email address',
  'Operazione non riuscita. Riprova.': 'The operation failed. Try again.',
  'Operazione in corso…': 'Working…',
  'Password aggiornata.': 'Password updated.',
  'Password dimenticata?': 'Forgot password?',
  'Password nuovo account': 'New account password',
  'Seleziona backup completo Nous': 'Select a complete Nous backup',
  '{courseCount} corsi importati.': '{courseCount} courses imported.',
  'Spostamento in corso...': 'Moving...',
  'non disponibile': 'unavailable',
  'Magic link inviato. Controlla la tua email.': 'Magic link sent. Check your email.',
  'Completa il tuo account': 'Complete your account',
  'Scegli una nuova password': 'Choose a new password',
  'Salva la nuova password': 'Save the new password',
  'Salvataggio…': 'Saving…',
  'Il link ha confermato il tuo indirizzo email. Scegli una password per completare l’account e continuare.':
    'The link confirmed your email address. Choose a password to complete the account and continue.',
  'Il link di recupero ti ha autenticato. La password cambierà solo quando confermi quella nuova.':
    'The recovery link signed you in. Your password changes only after you confirm the new one.',
  'Il link non è valido o è scaduto. Richiedine uno nuovo.':
    'The link is invalid or has expired. Request a new one.',
  'Richiesta di recupero non riuscita. Riprova.': 'Could not request password recovery. Try again.',
  'Se esiste un account per questa email, riceverai un link per scegliere una nuova password.':
    'If an account exists for this email, you will receive a link to choose a new password.',
  'Se esiste un account per questa email, riceverai un link di accesso.':
    'If an account exists for this email, you will receive a sign-in link.',
  'Invita o invia accesso': 'Invite or send sign-in link',
  'Un nuovo indirizzo riceve un link per completare l’account. Un account ancora in attesa riceve di nuovo il completamento; un account completo riceve un link di accesso.':
    'A new address receives an account setup link. A pending account receives setup again; a completed account receives a sign-in link.',
  'Invito inviato a {userEmail}. Dovrà scegliere una password prima di entrare.':
    'Invitation sent to {userEmail}. They must choose a password before continuing.',
  'Link di accesso inviato a {userEmail}. La password esistente non è stata modificata.':
    'Sign-in link sent to {userEmail}. The existing password was not changed.',
  'Link per completare l’account inviato a {userEmail}. Dovrà scegliere una password prima di entrare.':
    'Account setup link sent to {userEmail}. They must choose a password before continuing.',
  'Navigazione principale': 'Main navigation',
  'Non un riassunto. Non una chat generica.': 'Not a summary. Not a generic chat.',
  'Non sono riuscito a generare l’audio. Riprova tra poco.':
    'I could not generate the audio. Try again shortly.',
  'Nous costruisce il percorso': 'Nous builds the learning path',
  'Nous è un ambiente di apprendimento: conserva la struttura del soggetto, il punto in cui sei e le domande che ti hanno fatto avanzare.':
    'Nous is a learning environment: it preserves the structure of the subject, where you are, and the questions that helped you move forward.',
  'Nous mette ordine prima che tu debba farlo da solo.':
    'Nous creates order before you have to do it yourself.',
  'Nous Reader, torna all’inizio': 'Nous Reader, back to the beginning',
  'Nome cartella...': 'Folder name...',
  'Nuova password per {userName}': 'New password for {userName}',
  'Nuova cartella': 'New folder',
  'Nuova sottocartella': 'New subfolder',
  'Nessun corso salvato da organizzare.': 'No saved courses to organize.',
  'Parla del tuo livello reale, non di quello ideale.':
    'Describe your actual level, not your ideal one.',
  'Parte 1 di 12': 'Part 1 of 12',
  'PARTE 01 · FONDAMENTI': 'PART 01 · FOUNDATIONS',
  'PDF, libri e ricerca diventano corsi leggibili, interrogabili e continui.':
    'PDFs, books, and research become readable, explorable, continuous courses.',
  'PER CHI VUOLE CAPIRE': 'FOR PEOPLE WHO WANT TO UNDERSTAND',
  'PERCHÉ NOUS': 'WHY NOUS',
  'Perché Nous': 'Why Nous',
  'Per chi studia da fonti diverse, perde il filo tra una sessione e l’altra o ha bisogno di vedere un argomento diventare una sequenza affrontabile.':
    'For people who study from different sources, lose the thread between sessions, or need to see a subject become a manageable sequence.',
  'Porta il materiale': 'Bring your source material',
  'Porta un argomento. Noi gli diamo una direzione.': 'Bring a subject. We give it direction.',
  'Preview a inviti. Niente rumore, solo aggiornamenti utili.':
    'Invite-only preview. No noise, only useful updates.',
  'PREVIEW PRIVATA': 'PRIVATE PREVIEW',
  'Se vuoi esempi, codice o analogie, dillo subito.':
    'Say up front if you want examples, code, or analogies.',
  'Radice libreria': 'Library root',
  Rinomina: 'Rename',
  'Rinomina cartella...': 'Rename folder...',
  Salva: 'Save',
  'Salva modelli': 'Save models',
  'Dimostrazione video: {sourceTitle}': 'Video demonstration: {sourceTitle}',
  'Riproduci la dimostrazione ({timeRange})': 'Play the demonstration ({timeRange})',
  'Salva password': 'Save password',
  'Scegli la destinazione': 'Choose destination',
  'Senza cartella': 'No folder',
  Sposta: 'Move',
  'Sposta elemento': 'Move item',
  'Sposta nella radice libreria': 'Move to library root',
  'Albero corsi': 'Course tree',
  'Scrivi cosa vuoi saper fare alla fine del percorso.':
    'Write what you want to be able to do by the end of the course.',
  'Scopri come funziona': 'See how it works',
  'Sei nella lista. Ti scriveremo quando si libera un posto.':
    'You are on the list. We will write when a place opens up.',
  'SOLO SU INVITO': 'INVITE ONLY',
  'STUDIARE UN ARGOMENTO, DAVVERO': 'TRULY STUDY A SUBJECT',
  'Strutturazione semantica del piano di studi...': 'Structuring the learning plan semantically...',
  'Strumenti di studio': 'Study tools',
  'Continuità tra le sessioni': 'Continuity between sessions',
  'I vantaggi di Nous': 'The benefits of Nous',
  'Hai inviato troppe richieste. Riprova tra qualche minuto.':
    'You sent too many requests. Try again in a few minutes.',
  'Le fonti diventano parti ordinate, leggibili e collegate tra loro.':
    'Sources become ordered, readable sections connected to each other.',
  'Leggi, fai domande, annota e riprendi sempre dal punto giusto.':
    'Read, ask questions, take notes, and always resume in the right place.',
  'Leggi, ascolta, evidenzia, visualizza. Rimani concentrato e fai progressi.':
    'Read, listen, highlight, and visualize. Stay focused and make progress.',
  'Progressi e contesto che continuano tra una sessione e l’altra.':
    'Progress and context that continue between sessions.',
  'Risposte ancorate a ciò che stai studiando.': 'Answers anchored to what you are studying.',
  'Trasforma qualsiasi testo complesso in lezioni chiare, passo dopo passo.':
    'Turn complex material into clear lessons, step by step.',
  'Un percorso, non una cartella di file.': 'A learning path, not a folder of files.',
  'Una rete nasce da una domanda semplice: come facciamo a scambiare informazioni senza perdere il significato lungo il percorso?':
    'A network begins with a simple question: how can we exchange information without losing its meaning along the way?',
  'Quando il materiale è tanto, il percorso deve restare semplice.':
    'When there is a lot of material, the path must stay simple.',
  'Apri {artifactTitle}': 'Open {artifactTitle}',
  'Artefatto scartato.': 'Artifact discarded.',
  'Artefatto sostituito.': 'Artifact replaced.',
  'Avvia dettatura': 'Start dictation',
  'Chiudi avviso microfono': 'Dismiss microphone alert',
  'Chiudi anteprima artefatto': 'Close artifact preview',
  'Chiudi artefatto': 'Close artifact',
  'Conferma rigenerazione': 'Confirm regeneration',
  'Ferma e trascrivi': 'Stop and transcribe',
  'Generazione artefatto in corso...': 'Generating artifact...',
  'Immagine generata': 'Generated image',
  'Immagine non disponibile': 'Image unavailable',
  'Immagine PDF': 'PDF image',
  Immagini: 'Images',
  'Immagini (Codex/OpenAI)': 'Images (Codex/OpenAI)',
  'Immagini OpenRouter': 'OpenRouter images',
  Interattivo: 'Interactive',
  'Istruzioni rigenerazione': 'Regeneration instructions',
  'La registrazione audio non è supportata da questo browser.':
    'Audio recording is not supported by this browser.',
  'La registrazione si è interrotta. Riprova.': 'Recording stopped unexpectedly. Try again.',
  'Nessun microfono disponibile.': 'No microphone is available.',
  'Il microfono è occupato o non è temporaneamente disponibile. Riprova.':
    'The microphone is busy or temporarily unavailable. Try again.',
  'Il microfono richiede una connessione sicura (HTTPS o localhost).':
    'The microphone requires a secure connection (HTTPS or localhost).',
  'Non ho rilevato audio. Riprova.': 'No audio was detected. Try again.',
  'Non riesco ad accedere al microfono. Riprova.': 'I cannot access the microphone. Try again.',
  'Operazione ancora in corso, non e un blocco.': 'Still working; the app is not stuck.',
  'Permesso microfono negato. Abilitalo nelle impostazioni del browser.':
    'Microphone permission was denied. Enable it in your browser settings.',
  'Registrazione in corso.': 'Recording in progress.',
  'Avvio della rigenerazione cover non riuscito.': 'Could not start course cover regeneration.',
  'Cover dei corsi': 'Course covers',
  'La rigenerazione cover non è partita.': 'Course cover regeneration did not start.',
  'Nessuna rigenerazione cover avviata.': 'No course cover regeneration has been started.',
  Rigenera: 'Regenerate',
  'Rigenera artefatto': 'Regenerate artifact',
  'Rigenera bozza': 'Regenerate draft',
  'Rigenera cover': 'Regenerate covers',
  'Rigenera in background le cover dei tuoi corsi con il prompt corrente. Le cover esistenti restano disponibili fino al completamento.':
    'Regenerate your course covers in the background with the current prompt. Existing covers remain available until completion.',
  'Rigenerazione...': 'Regenerating...',
  'Rigenerazione in corso': 'Regeneration in progress',
  'Rigenerazione fallita. La bozza precedente non e stata modificata.':
    'Regeneration failed. The previous draft was not changed.',
  'Rigenerazione richiesta.': 'Regeneration requested.',
  'Stato della rigenerazione cover non disponibile.':
    'Course cover regeneration status is unavailable.',
  '{completed} di {total} cover completate.': '{completed} of {total} covers completed.',
  '{regenerated} cover rigenerate, {skipped} saltate e {failed} non riuscite.':
    '{regenerated} covers regenerated, {skipped} skipped, and {failed} failed.',
  'Salva artefatto nelle note': 'Save artifact to notes',
  'Salva artefatto nella lezione': 'Save artifact to lesson',
  'Salvando...': 'Saving...',
  'Salvato.': 'Saved.',
  Scarta: 'Discard',
  'Scarta artefatto': 'Discard artifact',
  'Spiega cosa cambiare nella nuova bozza...': 'Describe what should change in the new draft...',
  'Sto ancora lavorando: per corsi lunghi puo volerci qualche minuto.':
    'Still working: long courses can take a few minutes.',
  'Sto trascrivendo la registrazione.': 'Transcribing the recording.',
  Sostituisci: 'Replace',
  'Sostituisci artefatto': 'Replace artifact',
  'Trascrizione in corso': 'Transcribing',
  'Trascrizione non riuscita. Riprova.': 'Transcription failed. Try again.',
  Visuale: 'Visual',
  'Account creato.': 'Account created.',
  'Aggiornamento utente non riuscito.': 'Could not update the user.',
  attivo: 'active',
  Base: 'Standard',
  'Crea account': 'Create account',
  Crea: 'Create',
  'Creazione account non riuscita.': 'Could not create the account.',
  disabilitato: 'disabled',
  Disabilita: 'Disable',
  Lezioni: 'Lessons',
  'Modelli aggiornati.': 'Models updated.',
  'Modelli globali': 'Global models',
  'Modello {modelSlot}': '{modelSlot} model',
  'Modello {modelSlot} per {provider}': '{modelSlot} model for {provider}',
  'Pannello admin non disponibile.': 'The admin panel is unavailable.',
  'Salvataggio modelli non riuscito.': 'Could not save the models.',
  Utenti: 'Users',
  Voce: 'Voice',
  'Pianificazione esercizi completata.': 'Exercise planning completed.',
  'Non sono riuscito a pianificare gli esercizi.': 'I could not plan the exercises.',
  'Non sono riuscito a salvare la consegna.': 'I could not save the submission.',
  'Non sono riuscito a rimuovere il file.': 'I could not remove the file.',
  'Non sono riuscito ad allegare il file.': 'I could not attach the file.',
  'Non sono riuscito a valutare la consegna. Riprova.':
    'I could not assess the submission. Try again.',
  'Aggiungi una consegna e richiedi un riscontro.': 'Add a submission and request feedback.',
  'Come vuoi che siano le lezioni di "{courseTitle}"?':
    'What should the lessons in "{courseTitle}" be like?',
  'Completa e Prosegui': 'Complete and continue',
  'Conferma rigenerazione contenuto': 'Confirm content regeneration',
  'Es. Sono a disagio con la matematica. Quando introduci una formula, spiega ogni simbolo e fai un esempio numerico prima di andare avanti.':
    'For example: I struggle with math. When you introduce a formula, explain every symbol and give a numerical example before moving on.',
  'Genera senza note': 'Generate without notes',
  'Hai completato tutte le pause attive di questa lezione.':
    'You completed all active pauses in this lesson.',
  'Invia messaggio': 'Send message',
  'La traccia verrà riscritta e gli allegati correnti potrebbero non essere più coerenti con la nuova consegna.':
    'The assignment will be rewritten, and the current attachments may no longer match the new version.',
  'Manca 1 pausa attiva: rispondi a quella evidenziata nella lezione.':
    '1 active pause remains: answer the one highlighted in the lesson.',
  'Mancano {count} pause attive: completa quelle ancora senza risposta.':
    '{count} active pauses remain: complete the unanswered ones.',
  'Nessuna valutazione disponibile.': 'No assessment is available.',
  'Potrai modificare queste note in qualsiasi momento dalle impostazioni del corso.':
    'You can edit these notes at any time in the course settings.',
  'Prima di generare la prima lezione, puoi dare al professore delle indicazioni specifiche per questo corso: tono, livello di dettaglio, cose da evitare, cose da spiegare con più calma. Queste note hanno priorita sullo stile di default.':
    'Before generating the first lesson, you can give the teacher course-specific guidance: tone, level of detail, what to avoid, and what to explain more carefully. These notes override the default style.',
  Prosegui: 'Continue',
  'Puoi andare avanti subito oppure completare prima le pause attive per segnare la lezione come completata.':
    'You can continue now or complete the active pauses first to mark the lesson as completed.',
  'Questo progetto e stato importato senza file sorgente. Ricollega il PDF o lo ZIP per generare nuove lezioni.':
    'This project was imported without its source file. Reconnect the PDF or ZIP to generate new lessons.',
  'Il PDF originale di questo corso non e disponibile. Ricaricalo per generare o rigenerare le lezioni senza perdere il corso.':
    'The original PDF for this course is unavailable. Upload it again to generate or regenerate lessons without losing the course.',
  'Ricarica PDF': 'Upload PDF again',
  'Ricollega sorgente': 'Reconnect source',
  'Rigenerare {demonstrative} {subjectLabel}?': 'Regenerate {demonstrative} {subjectLabel}?',
  "Rispondi all'ultima pausa attiva per completare la lezione.":
    'Answer the final active pause to complete the lesson.',
  'Rispondi alle {count} pause attive rimanenti per completare la lezione.':
    'Answer the remaining {count} active pauses to complete the lesson.',
  'Salva note e genera': 'Save notes and generate',
  'Verrà ricreata la lezione corrente a partire dal materiale sorgente e potresti perdere il contenuto attuale.':
    'The current lesson will be recreated from the source material, and you may lose its current content.',
  'Azioni debug lezione': 'Lesson debug actions',
  'Chiudi elenco lezioni': 'Close lesson list',
  'Copia markdown lezione': 'Copy lesson markdown',
  'Debug temporaneo: copia il markdown salvato prima del rendering.':
    'Temporary debug tool: copy the stored Markdown before rendering.',
  'Esercizio applicativo attivo': 'Active application exercise',
  'Esercizio applicativo pianificato': 'Planned application exercise',
  'Esercizio applicativo pronto': 'Application exercise ready',
  'Esercizio completato': 'Exercise completed',
  'Esercizio completato: {score}/100': 'Exercise completed: {score}/100',
  'Esercizio con feedback da aggiornare': 'Exercise with outdated feedback',
  'Generazione lezione in corso…': 'Generating lesson…',
  'Lezione attiva': 'Active lesson',
  'Lezione completata': 'Completed lesson',
  'Lezione già generata': 'Generated lesson',
  'Lezione non ancora generata': 'Lesson not generated yet',
  'Markdown copiato': 'Markdown copied',
  'Nascondi Menu (Focus Mode)': 'Hide menu (Focus mode)',
  'Percorso di Studio': 'Learning path',
  'Pianificazione esercizi...': 'Planning exercises...',
  "Una parte interattiva dell'artefatto ha avuto un errore. Puoi rigenerarlo o sostituirlo.":
    'An interactive part of the artifact encountered an error. You can regenerate or replace it.',
  'Questo artefatto interattivo non e riuscito a caricarsi. Puoi rigenerarlo o sostituirlo.':
    'This interactive artifact failed to load. You can regenerate or replace it.',
  'Errore nello script del visuale.': 'Error in the visual script.',
  'Script esterno non caricato.': 'External script failed to load.',
  Ambiente: 'Ambient',
  'Annulla selezione dal testo': 'Cancel text selection',
  'Apri menu audio': 'Open audio menu',
  Aggiungi: 'Add',
  'Aggiungi concetto chiave': 'Add key concept',
  'Aggiungi un concetto chiave': 'Add a key concept',
  'Aggiungi quello che vuoi ricordare': 'Add what you want to remember',
  'Apri concetti chiave, {itemCount}': 'Open key concepts, {itemCount}',
  'Chiudi concetti chiave': 'Close key concepts',
  'Apri concetti chiave': 'Open key concepts',
  'Chiudi concetti chiave dallo sfondo': 'Close key concepts from the backdrop',
  'Chiudi menu audio': 'Close audio menu',
  'Comprimi concetti chiave': 'Collapse key concepts',
  'Comprimi {learningAidTitle}': 'Collapse {learningAidTitle}',
  'Concetti chiave': 'Key concepts',
  Contenuto: 'Content',
  Definizione: 'Definition',
  Formula: 'Formula',
  Analogia: 'Analogy',
  Simbolo: 'Symbol',
  'Espandi concetti chiave': 'Expand key concepts',
  'Espandi {learningAidTitle}': 'Expand {learningAidTitle}',
  'Modifica concetto chiave': 'Edit key concept',
  'Modifica {learningAidTitle}': 'Edit {learningAidTitle}',
  'Non ci sono ancora concetti chiave. Aggiungi quello che vuoi ricordare.':
    'There are no key concepts yet. Add what you want to remember.',
  'Non sono riuscito a salvare i concetti chiave. Riprova.':
    'I could not save the key concepts. Try again.',
  'Nuovo concetto chiave': 'New key concept',
  'Supporti contestuali della lezione': 'Contextual lesson aids',
  'Rimuovi {learningAidTitle}': 'Remove {learningAidTitle}',
  Tipo: 'Type',
  'Tipo concetto chiave': 'Key concept type',
  Titolo: 'Title',
  'Titolo e contenuto sono obbligatori.': 'Title and content are required.',
  'Vicino a {heading}': 'Near {heading}',
  '1 elemento': '1 item',
  '{count} elementi': '{count} items',
  'In caricamento': 'Loading',
  'incolla link YouTube...': 'paste a YouTube link...',
  'Link non valido o video limitato da YouTube. Prova un altro link.':
    'Invalid link or YouTube-restricted video. Try another link.',
  'Menu audio': 'Audio menu',
  'Modalità audio': 'Audio mode',
  'Parte da leggere': 'Section to read',
  'Parte {current} di {total}': 'Part {current} of {total}',
  Pausa: 'Pause',
  'Pausa musica ambiente': 'Pause ambient music',
  'Passa sul testo e clicca la parte da leggere':
    'Move over the text and click the section you want to read',
  'Riproduci musica ambiente': 'Play ambient music',
  'Riprova a caricare': 'Try loading again',
  'Scegli dal testo': 'Choose from text',
  'TTS non disponibile': 'TTS unavailable',
  'TTS non disponibile. Carica una lezione per iniziare.':
    'TTS is unavailable. Load a lesson to begin.',
  Velocita: 'Speed',
  'Apri elenco lezioni': 'Open lesson list',
  'Apri impostazioni lettura': 'Open reading settings',
  'Apri una lezione per rigenerarla': 'Open a lesson to regenerate it',
  'Cambia Tema': 'Change theme',
  Errore: 'Error',
  'Errore di salvataggio': 'Saving error',
  Lezione: 'Lesson',
  'Mostra Menu': 'Show menu',
  Percorso: 'Learning path',
  'Rigenera la lezione corrente': 'Regenerate the current lesson',
  'Rigenerare questa lezione?': 'Regenerate this lesson?',
  Salvataggio: 'Saving',
  'Salvataggio in corso...': 'Saving...',
  'Torna alla libreria': 'Back to library',
  'Aggiorna riscontro': 'Update feedback',
  'Anteprima vuota': 'Empty preview',
  'Apri anteprima': 'Open preview',
  'Archivio pronto per la valutazione. Il sistema leggerà solo file testuali supportati.':
    'Archive ready for assessment. The system will read only supported text files.',
  'Area di lettura': 'Reading area',
  Artefatti: 'Artifacts',
  'Artefatti della lezione': 'Lesson artifacts',
  'Blocco codice': 'Code block',
  'Carica file': 'Upload files',
  codice: 'code',
  Consegna: 'Submission',
  'Correzione AI': 'AI assessment',
  'Da migliorare': 'Improvements',
  'Esercizio applicativo': 'Application exercise',
  'File testuale pronto per la valutazione.': 'Text file ready for assessment.',
  'Fonte originale: {sourcePageRangeLabel}': 'Original source: {sourcePageRangeLabel}',
  'Fonti della lezione': 'Lesson sources',
  'Fonti della sezione': 'Section sources',
  'Alcune fonti non sono state usate: {sourceNames}. Il corso continua con le altre.':
    'Some sources were not used: {sourceNames}. The course will continue with the others.',
  'Generazione consegna...': 'Generating assignment...',
  'Generazione lezione...': 'Generating lesson...',
  Grassetto: 'Bold',
  'Inserisci heading': 'Insert heading',
  Lista: 'List',
  'La consegna del laboratorio usa le lezioni gia scritte. Mancano ancora:':
    'The lab assignment uses the lessons already written. Still missing:',
  'La consegna non contiene testo leggibile.': 'The submission contains no readable text.',
  'Limiti della valutazione': 'Assessment limitations',
  'Nascondi suggerimento selezione testo': 'Hide text-selection hint',
  'Parte {partNumber}': 'Part {partNumber}',
  'Parte {partNumber} evidenziata. Fai clic per sceglierla.':
    'Part {partNumber} highlighted. Click to choose it.',
  'Prima genera le lezioni precedenti': 'Generate the previous lessons first',
  'Punti di forza': 'Strengths',
  'Richiedi riscontro': 'Request feedback',
  'Rimuovi allegato': 'Remove attachment',
  'Riscontro datato.': 'Feedback is outdated.',
  'Risposta per {exerciseTitle}': 'Response for {exerciseTitle}',
  'Salvataggio automatico': 'Autosave',
  'Scrivi qui la tua consegna in Markdown o testo libero.':
    'Write your submission here in Markdown or plain text.',
  'Scrivi una nota Markdown oppure carica file testuali o archivi ZIP. Tutto cio che produci qui resta una consegna persistente e verra usato nella valutazione.':
    'Write a Markdown note or upload text files or ZIP archives. Everything you add here remains part of the saved submission and will be used for assessment.',
  'Seleziona un passaggio e fai click destro per chiedere spiegazioni, aggiungere una nota o creare una lezione di approfondimento.':
    'Select a passage and right-click to ask for an explanation, add a note, or create a follow-up lesson.',
  'Selezione dal testo attiva. Passa su una parte e fai clic per sceglierla.':
    'Text selection is active. Move over a section and click to choose it.',
  'Apri il menu lezioni per scegliere cosa leggere.':
    'Open the lessons menu to choose what to read.',
  'Seleziona una sezione dal piano di studi per iniziare.':
    'Select a section from the learning plan to begin.',
  testo: 'text',
  'Titolo sezione': 'Section title',
  Traccia: 'Assignment',
  'Valutazione in corso...': 'Assessment in progress...',
  'Valuto la consegna…': 'Assessing the submission…',
  'Questo laboratorio è pianificato. Aprilo di nuovo per generare la consegna.':
    'This lab is planned. Open it again to generate the assignment.',
  'voce lista': 'list item',
  'Aggiungi o modifica una nota su questo passaggio': 'Add or edit a note on this passage',
  'Aggiungi una nota a questo passaggio': 'Add a note to this passage',
  'Aggiungi una nota alla lezione': 'Add a note to the lesson',
  'Allega {artifactTitle} alla nota': 'Attach {artifactTitle} to the note',
  'Allega dagli artefatti': 'Attach from artifacts',
  Chiedi: 'Ask',
  'Chiedi a Nous o aggiungi istruzioni': 'Ask Nous or add instructions',
  'Chiedi su tutta la lezione': 'Ask about the whole lesson',
  'Crea lezione': 'Create lesson',
  'Crea una nuova lezione dedicata a questo punto': 'Create a lesson about this point',
  'Crea una nuova lezione dedicata a questo punto nel menu a sinistra':
    'Create a lesson about this point in the left menu',
  'Evidenzia il testo selezionato': 'Highlight the selected text',
  'Evidenzia selezione': 'Highlight selection',
  'Inserisci una domanda': 'Enter a question',
  'Invia domanda': 'Send question',
  Istruzioni: 'Instructions',
  'Nessuna istruzione aggiuntiva: verrà usata solo la selezione corrente.':
    'No additional instructions: only the current selection will be used.',
  Nota: 'Note',
  'Nota associata al passaggio': 'Note attached to this passage',
  Procedi: 'Continue',
  Rimuovi: 'Remove',
  'Rimuovi evidenziazione': 'Remove highlight',
  'Salva nota': 'Save note',
  'Scrivi la nota che vuoi lasciare su questo passaggio...':
    'Write the note you want to leave on this passage...',
  'Scrivi, aggiorna o svuota la nota...': 'Write, update, or clear the note...',
  'Vuoi creare una nuova lezione da questa selezione?':
    'Do you want to create a new lesson from this selection?',
  Assessment: 'Assessment',
  'Chiudi anteprima': 'Close preview',
  Modifica: 'Edit',
  TTS: 'TTS',
  'Accetta o rifiuta la nota proposta per continuare...':
    'Accept or decline the proposed note to continue...',
  'Aggiungi alle note': 'Add to notes',
  'Aggiorna nota': 'Update note',
  Annota: 'Annotate',
  'Annota attivo': 'Annotation enabled',
  'Apri strumenti conversazione': 'Open conversation tools',
  'Artefatti visuali attivi': 'Visual artifacts enabled',
  'Cerca sul web': 'Search the web',
  'Cerca sul web attivo': 'Web search enabled',
  'Chiedi un follow-up su questa risposta...': 'Ask a follow-up about this answer...',
  'Crea automaticamente mappe, grafici, diagrammi e widget per visualizzare i concetti del follow-up.':
    'Automatically create maps, charts, diagrams, and widgets to visualize concepts in the follow-up.',
  'Dai priorita a grounding e verifica con fonti esterne quando servono informazioni aggiornate o non presenti nel testo.':
    'Prioritize grounding and verify with external sources when current information or details absent from the text are needed.',
  'Genera artefatti visuali': 'Generate visual artifacts',
  'Modifica l artefatto "{artifactTitle}".': 'Edit the artifact "{artifactTitle}".',
  'No grazie': 'No thanks',
  'Non ho abbastanza contesto per generare un artefatto su questa lezione.':
    'I do not have enough context to generate an artifact for this lesson.',
  'Non ho trovato un artefatto generato modificabile da usare come sorgente.':
    'I could not find an editable generated artifact to use as the source.',
  'Non sono riuscito ad aggiornare la nota.': 'I could not update the note.',
  'Non sono riuscito a salvare la nota.': 'I could not save the note.',
  'Nota aggiornata.': 'Note updated.',
  'Nota proposta': 'Proposed note',
  'Nota salvata.': 'Note saved.',
  'Nuova versione della nota': 'New note version',
  'Passaggio proposto': 'Proposed passage',
  'Richiesta rifiutata, la conversazione continua senza salvare.':
    'Request declined. The conversation will continue without saving.',
  'Ridimensiona pannello risposta': 'Resize answer panel',
  'Segnala con forza che vuoi trasformare il chiarimento in una nota o aggiornare quella già collegata al passaggio.':
    'Clearly signal that you want to turn the explanation into a note or update the note already attached to the passage.',
  'Sto caricando i dettagli della nota proposta...': 'Loading the proposed note details...',
  'Sto continuando a rispondere...': 'Continuing the answer...',
  'Sto preparando il suggerimento da salvare nelle note.':
    'Preparing the suggestion to save in your notes.',
  'Suggerimento non disponibile. Puoi riprovare.': 'Suggestion unavailable. You can try again.',
  'Vuoi aggiungerlo alle note?': 'Do you want to add it to your notes?',
  'Vuoi aggiornare la nota collegata?': 'Do you want to update the attached note?',
  '1 corso': '1 course',
  '1 lezione': '1 lesson',
  '{count} corsi': '{count} courses',
  '{count} corsi inclusi': '{count} courses included',
  '{count} lezioni': '{count} lessons',
  '{count} fonti selezionate': '{count} sources selected',
  '{completed}/{total} lezioni completate': '{completed}/{total} lessons completed',
  'Aggiunge grounding esterno quando servono confronti, suggerimenti di corsi o dati aggiornati.':
    'Adds external grounding when comparisons, course suggestions, or current data are needed.',
  'Aggiungi dettagli o requisiti...': 'Add details or requirements...',
  'Allega contesto': 'Attach context',
  'Allega un file sorgente (PDF, ZIP, testo)': 'Attach a source file (PDF, ZIP, text)',
  'Apri esploratore contesto libreria': 'Open the library context browser',
  "Apri l'esploratore contesto senza rischi di clipping laterale.":
    'Open the context browser without side clipping.',
  'Apri strumenti libreria': 'Open library tools',
  'Artefatti lezioni': 'Lesson artifacts',
  'Bastano poche righe: obiettivo, livello di partenza, scadenza e materiale disponibile.':
    'A few lines are enough: goal, starting level, deadline, and available material.',
  'Caricamento libreria...': 'Loading library...',
  'Cerca sul web attiva': 'Web search enabled',
  'Chiedi progressi, riassunti, note o confronti tra corsi...':
    'Ask about progress, summaries, notes, or comparisons across courses...',
  'Chiedi riassunti, progresso, note, highlight o confronti tra corsi.':
    'Ask for summaries, progress, notes, highlights, or comparisons across courses.',
  'Chiudi selettore contesto': 'Close context selector',
  'Consulta la tua libreria': 'Explore your library',
  'Consulta libreria': 'Explore library',
  'Contesto libreria': 'Library context',
  'Cosa vorresti imparare?': 'What would you like to learn?',
  'Crea mappe, grafici e diagrammi per visualizzare i concetti insieme alle risposte.':
    'Create maps, charts, and diagrams to visualize concepts alongside the answers.',
  'Crea automaticamente mappe, grafici, diagrammi e widget per visualizzare i concetti trattati.':
    'Automatically create maps, charts, diagrams, and widgets to visualize the concepts discussed.',
  'Da usare insieme ai dati della libreria quando vuoi confronti o suggerimenti oltre la libreria.':
    'Use it with library data when you want comparisons or suggestions beyond your library.',
  "Descrivi l'obiettivo del corso o allega un file: cosa prepari, livello attuale, scadenza...":
    'Describe the course goal or attach a file: what you are preparing for, your current level, deadline...',
  "Descrivi l'obiettivo del corso oppure allega un materiale sorgente e dimmi dove vuoi arrivare.":
    'Describe the course goal or attach source material and tell me what you want to achieve.',
  'Dettagli lezioni': 'Lesson details',
  'Genera artefatto': 'Generate artifact',
  'Ho raccolto tutte le informazioni necessarie. Vuoi generare il corso?':
    'I have gathered all the necessary information. Do you want to generate the course?',
  'Imposta un nuovo corso': 'Set up a new course',
  Indietro: 'Back',
  'Indice libreria': 'Library index',
  'Interroga corsi, lezioni, note e highlight della libreria.':
    'Ask about courses, lessons, notes, and highlights in your library.',
  'Interroga la tua libreria': 'Ask your library',
  'Invia domanda libreria': 'Send library question',
  Inizia: 'Start',
  'Modalità home chat': 'Home chat mode',
  'Multi-selezione mista con cartelle annidate e corsi singoli.':
    'Mixed selection of nested folders and individual courses.',
  'Nessun corso disponibile da allegare.': 'No courses are available to attach.',
  'No, voglio aggiungere...': 'No, I want to add...',
  'Nuovo corso': 'New course',
  'Panoramica corsi': 'Course overviews',
  'Prepara la nota di lezione con gli artefatti allegati.':
    'Prepare the lesson note with the attached artifacts.',
  'Preparo la nota di lezione con gli artefatti allegati.':
    'I am preparing the lesson note with the attached artifacts.',
  'Preferenze risposta': 'Answer preferences',
  'Pulisci questa chat': 'Clear this chat',
  'Ricerca contenuti': 'Content search',
  'Ricerca web': 'Web search',
  'Richiesta rifiutata.': 'Request declined.',
  'Rimuovi {referenceLabel}': 'Remove {referenceLabel}',
  'Scegli corsi o cartelle': 'Choose courses or folders',
  'Scegli il contesto': 'Choose context',
  'Seleziona cartelle e corsi da allegare.': 'Select folders and courses to attach.',
  'Sì, genera il corso': 'Yes, generate the course',
  'Strumenti libreria': 'Library tools',
  'Struttura corsi': 'Course structures',
  Tool: 'Tool',
  'Vuoi salvarlo nelle note della lezione?': 'Do you want to save it to the lesson notes?',
  'Il salvataggio delle note non e disponibile in questo contesto.':
    'Saving notes is unavailable in this context.',
  'La sezione attiva non e disponibile.': 'The active section is unavailable.',
  'La lezione rigenerata non e stata salvata. Riprova.':
    'The regenerated lesson was not saved. Try again.',
  'Non ho trovato l artefatto da sostituire.': 'I could not find the artifact to replace.',
  'Non ho trovato la lezione target.': 'I could not find the target lesson.',
  'Non ho trovato la lezione target in questo corso.':
    'I could not find the target lesson in this course.',
  'Non ho trovato la sezione corrente.': 'I could not find the current section.',
  'Non ho trovato una nota esistente collegata a questo passaggio da aggiornare.':
    'I could not find an existing note attached to this passage to update.',
  'Non sono riuscito a generare un artefatto visuale utile.':
    'I could not generate a useful visual artifact.',
  'Non sono riuscito a ritrovare il passaggio da annotare nella lezione corrente.':
    'I could not find the passage to annotate in the current lesson.',
  'Non sono riuscito ad aggiornare la nota esistente.': 'I could not update the existing note.',
  'Target lezione o richiesta non validi.': 'Invalid target lesson or request.',
  'Non ho trovato questa annotazione. Riprova dopo aver ricaricato la sezione.':
    'I could not find this annotation. Try again after reloading the section.',
  'Non ho trovato questo allegato nella nota. Riprova dopo aver ricaricato la sezione.':
    'I could not find this attachment in the note. Try again after reloading the section.',
  'Non sono riuscito a associare la nota a questa selezione. Prova a selezionare un frammento un po più preciso.':
    'I could not attach the note to this selection. Try selecting a slightly more precise passage.',
  'Non sono riuscito a evidenziare questa selezione in modo affidabile. Prova con una selezione leggermente piu corta.':
    'I could not highlight this selection reliably. Try a slightly shorter selection.',
  'Non sono riuscito a rimuovere questo highlight. Riprova.':
    'I could not remove this highlight. Try again.',
  'Allineamento lezioni con il PDF...': 'Aligning lessons with the PDF...',
  'Analisi contenuti...': 'Analyzing content...',
  'Analisi contesto...': 'Analyzing context...',
  'Apertura progetto...': 'Opening project...',
  'Associazione chunk alla nuova lezione...': 'Linking source chunks to the new lesson...',
  'Avvio conversazione...': 'Starting conversation...',
  'Avvio domande valutazione...': 'Starting assessment questions...',
  'Avvio Profilazione...': 'Starting profile setup...',
  'Avvio Valutazione...': 'Starting assessment...',
  'Controllo le lezioni precedenti...': 'Checking previous lessons...',
  'Creazione approfondimento...': 'Creating follow-up lesson...',
  'Creazione Piano Studi...': 'Creating learning plan...',
  'Importazione backup...': 'Importing backup...',
  'Importazione progetto...': 'Importing project...',
  'Indicizzazione capitoli del PDF...': 'Indexing PDF chapters...',
  "Il corso aperto è stato eliminato in un'altra sessione.":
    'The open course was deleted in another session.',
  'Preparazione sorgente...': 'Preparing source...',
  'Rigenerazione lezione...': 'Regenerating lesson...',
  'Salvataggio progresso...': 'Saving progress...',
  'Scelgo dove inserire gli esercizi...': 'Choosing where to place exercises...',
  'Valutazione risposta...': 'Assessing answer...',
  'Verifica testo PDF...': 'Checking PDF text...',
  Corretta: 'Correct',
  'Da rivedere': 'Review',
  'La tua scelta': 'Your choice',
  'Non sono riuscito a generare un artefatto visuale utile per questa richiesta.':
    'I could not generate a useful visual artifact for this request.',
  'Pausa attiva {questionNumber} - {exerciseLabel}':
    'Active pause {questionNumber} - {exerciseLabel}',
  'Risposta corretta': 'Correct answer',
  'Rimuovi {artifactTitle} dalla nota': 'Remove {artifactTitle} from the note',
  'Rimuovi dalla nota': 'Remove from note',
  'Es. Quando introduci una formula, spiega ogni simbolo e fai un esempio numerico.':
    'For example: when you introduce a formula, explain every symbol and give a numerical example.',
  'Impostazioni lettura': 'Reading settings',
  'Istruzioni personalizzate': 'Custom instructions',
  'Tono, livello, cose da evitare o ripetere.': 'Tone, level, and things to avoid or reinforce.',
  'Analizza, organizza, poi insegna.': 'Analyze, organize, then teach.',
  'Applicazione lampo': 'Quick application',
  'Capisci un argomento intero. Senza perdere il filo.':
    'Understand a whole subject without losing the thread.',
  'COME ACCEDI': 'HOW TO GET ACCESS',
  'Contesto e progressi che restano': 'Context and progress that carry over',
  'Continua da dove avevi lasciato.': 'Continue where you left off.',
  'Costruzione del corso': 'Course construction',
  'Dentro Nous, il prossimo passo è già pronto.': 'Inside Nous, your next step is already ready.',
  'Apri la libreria, segui la costruzione del corso e continua dalla lezione che stavi studiando.':
    'Open your library, follow the course as it is built, and continue from the lesson you were studying.',
  '4 lezioni · 1 in corso': '4 lessons · 1 in progress',
  '25% completato': '25% complete',
  'Lezione 1 di 4': 'Lesson 1 of 4',
  'Libreria dei corsi': 'Course library',
  'Piano del corso': 'Course plan',
  'Sto preparando “Perché l’attenzione è limitata”': 'Preparing “Why attention is limited”',
  'Ultimo accesso: oggi': 'Last opened: today',
  Classificazione: 'Classification',
  Confronto: 'Compare and contrast',
  'Controllo concettuale': 'Concept check',
  'Controlla il piano': 'Review the plan',
  'COSA FA': 'WHAT IT DOES',
  'Cosa offre Nous': 'What Nous offers',
  'Costruisce un corso, non un riassunto.': 'It builds a course, not a summary.',
  'Dal materiale a un corso vero.': 'From source material to a real course.',
  'DALLE FONTI A UN PERCORSO COMPLETO': 'FROM SOURCES TO A COMPLETE LEARNING PATH',
  'Dà all’argomento una struttura completa e una sequenza affrontabile.':
    'It gives the subject a complete structure and a manageable sequence.',
  'Entra in waitlist; se sei già tester, usa Accedi in alto.':
    'Join the waitlist; if you are already a tester, use Sign in above.',
  'Entra quando si libera un posto.': 'Join when a place becomes available.',
  'Diagnosi errore': 'Error diagnosis',
  'Forza di ragionamento': 'Reasoning effort',
  'Genera e studia una lezione': 'Generate and study one lesson',
  High: 'High',
  'Il prodotto': 'The product',
  'IL PROSSIMO CORSO PUÒ PARTIRE DA QUI': 'YOUR NEXT COURSE CAN START HERE',
  'La forza di ragionamento è condivisa per funzione; i modelli restano separati per provider. TTS e immagini non usano reasoning.':
    'Reasoning effort is shared by workload; models remain separate by provider. TTS and images do not use reasoning.',
  'Provider AI attivo': 'Active AI provider',
  'Provider AI': 'AI provider',
  'Provider AI nuovo account': 'AI provider for new account',
  'Provider AI per {userName}': 'AI provider for {userName}',
  'Predefinito globale': 'Global default',
  'Codex è disponibile solo quando il backend locale abilita app-server.':
    'Codex is available only when the local backend enables app-server.',
  'Codex gestisce direttamente accesso, token e rinnovo. Nous non legge né salva le credenziali.':
    'Codex manages sign-in, tokens, and renewal directly. Nous neither reads nor stores credentials.',
  'Collega Codex': 'Connect Codex',
  'Connessione a Codex non riuscita. Riprova.': 'Could not connect to Codex. Try again.',
  'Stato del provider AI non disponibile. Riprova.':
    'AI provider status is unavailable. Try again.',
  'La struttura viene prima del testo, così sai sempre dove stai andando.':
    'Structure comes before prose, so you always know where you are going.',
  'Leggi, ascolta, verifica e continua quando sei pronto.':
    'Read, listen, check your understanding, and continue when you are ready.',
  Low: 'Low',
  Medium: 'Medium',
  'Micro-sintesi': 'Micro-synthesis',
  Generazione: 'Generation',
  Minimal: 'Minimal',
  None: 'None',
  'Revisione visiva degli artefatti': 'Artifact visual review',
  'Artefatti visuali': 'Visual artifacts',
  'Artefatti interattivi': 'Interactive artifacts',
  'Richiesta ricevuta. Sto rigenerando l artefatto...':
    'Request received. Regenerating the artifact...',
  'Round massimi di revisione': 'Maximum review rounds',
  'Aggiunge un secondo passaggio di controllo dopo la prima generazione.':
    'Adds a second review pass after the initial generation.',
  Nessuno: 'None',
  'Nuova bozza pronta.': 'New draft ready.',
  'Nous propone moduli e lezioni; tu sai sempre cosa verrà costruito.':
    'Nous proposes modules and lessons, so you always know what will be built.',
  'Porta un argomento. Nous costruisce il percorso.':
    'Bring a subject. Nous builds the learning path.',
  Piano: 'Plan',
  Previsione: 'Prediction',
  'Preview su invito, accesso dal browser.': 'Invite-only preview, available in your browser.',
  'Prima prepara il piano; poi genera soltanto la lezione che stai studiando.':
    'It prepares the plan first, then generates only the lesson you are studying.',
  'Ragionamento {modelSlot}': '{modelSlot} reasoning',
  'Ragionamento {modelSlot} per {provider}': '{modelSlot} reasoning for {provider}',
  'Imposta ruolo {role} per {userName}': 'Set {userName} role to {role}',
  Ruolo: 'Role',
  'Ruolo per {userName}': 'Role for {userName}',
  '{action} {userName}': '{action} {userName}',
  'Imposta password per {userName}': 'Set password for {userName}',
  Ricerca: 'Research',
  'Ruolo nuovo account': 'New account role',
  'Stiamo aprendo Nous a piccoli gruppi per osservare come viene usato su corsi veri.':
    'We are opening Nous to small groups to observe how it is used on real courses.',
  'Trasforma PDF, libri e ricerca in un corso ordinato che puoi leggere, ascoltare e interrogare.':
    'Turn PDFs, books, and research into an organized course you can read, listen to, and question.',
  Sequenza: 'Sequence',
  'Un piano prima della generazione': 'A plan before generation',
  'Una lezione alla volta': 'One lesson at a time',
  'ACCESSO ANTICIPATO': 'EARLY ACCESS',
  'Campo di ricerca': 'Research field',
  'Carica il materiale che devi padroneggiare. Nous prepara il piano, genera lezioni ordinate con audio e domande, e alla sessione successiva riapre il punto esatto.':
    'Upload the material you need to master. Nous prepares the plan, generates ordered lessons with audio and questions, and reopens the exact point next time.',
  'Chat AI': 'AI chat',
  'ChatGPT ti dà una risposta. Nous ti dà il prossimo passo del corso.':
    'ChatGPT gives you an answer. Nous gives you the next step in the course.',
  'Confronto tra chat AI e Nous': 'Comparison between AI chat and Nous',
  'DAL TUO MATERIALE A UN CORSO CONTINUO': 'FROM YOUR MATERIAL TO A CONTINUOUS COURSE',
  'Decidi ogni volta cosa chiedere': 'Decide what to ask every time',
  Demo: 'Demo',
  'Esame universitario': 'University exam',
  'Esempi di utilizzo': 'Use cases',
  'Fonti, note e progressi restano nel corso': 'Sources, notes, and progress stay in the course',
  'Hai già il materiale. Ora dagli una direzione.':
    'You already have the material. Now give it a direction.',
  'Dai una direzione al tuo materiale.': 'Give your material a direction.',
  'Il contesto resta nella conversazione': 'Context stays in the conversation',
  'LA DIFFERENZA È LA CONTINUITÀ': 'THE DIFFERENCE IS CONTINUITY',
  'La domanda singola è utile. Per padroneggiare un soggetto servono anche ordine, memoria e una direzione che sopravviva alla sessione.':
    'A single question is useful. Mastering a subject also takes order, memory, and direction that survives the session.',
  'La lezione giusta dentro un piano': 'The right lesson inside a plan',
  'Link nel footer': 'Footer links',
  'Manuale professionale': 'Professional manual',
  'Nella demo: una dispensa di psicologia cognitiva diventa un percorso di 4 lezioni, dalla selezione attentiva alla metacognizione.':
    'In the demo, cognitive psychology notes become a four-lesson path from selective attention to metacognition.',
  'Riapri e trovi già il prossimo passo': 'Reopen it and find the next step ready',
  'Richiedi accesso': 'Request access',
  'Richiedi l’accesso alla preview. Se sei già tester, usa Accedi.':
    'Request preview access. If you are already a tester, use Sign in.',
  'Studia un corso reale con Nous.': 'Study a real course with Nous.',
  'Prova Nous sul tuo corso.': 'Try Nous with your course.',
  'Trasforma i tuoi PDF in un corso che ricorda dove eri.':
    'Turn your PDFs into a course that remembers where you left off.',
  'Un argomento intero. Un passo alla volta.': 'One whole subject. One step at a time.',
  'Il prossimo passo è già pronto.': 'Your next step is already ready.',
  'Una risposta non è un percorso.': 'An answer is not a learning path.',
  'Una risposta isolata': 'An isolated answer',
} as const;

export type UiMessage = keyof typeof ENGLISH_UI_MESSAGES;

const getBrowserLanguagePreferences = (): readonly string[] => {
  if (typeof navigator === 'undefined') {
    return [];
  }

  const languages = Array.isArray(navigator.languages) ? navigator.languages : [];
  if (languages.length > 0) {
    return languages;
  }

  return typeof navigator.language === 'string' && navigator.language ? [navigator.language] : [];
};

export const resolveAppLocale = (languages: readonly string[]): AppLocale => {
  for (const language of languages) {
    const locale = language.trim().toLowerCase().split(/[-_]/)[0];
    if (supportedLocales.has(locale)) {
      return locale as AppLocale;
    }
  }

  return DEFAULT_APP_LOCALE;
};

export const setRenderingLocaleOverride = (locale: AppLocale | null): void => {
  renderingLocaleOverride = locale;
};

export const getAppLocale = (): AppLocale =>
  renderingLocaleOverride ?? resolveAppLocale(getBrowserLanguagePreferences());

const interpolateMessage = (message: string, variables?: UiMessageVariables): string =>
  message.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (placeholder, variableName: string) => {
    const value = variables?.[variableName];
    return value === undefined ? placeholder : String(value);
  });

export const translateUiMessage = (
  message: UiMessage,
  variables?: UiMessageVariables,
  locale = getAppLocale()
): string => {
  const localizedMessage = locale === 'it' ? message : ENGLISH_UI_MESSAGES[message];
  return interpolateMessage(localizedMessage, variables);
};

export const initializeDocumentLanguage = (
  languages = getBrowserLanguagePreferences()
): AppLocale => {
  const locale = resolveAppLocale(languages);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
  return locale;
};
