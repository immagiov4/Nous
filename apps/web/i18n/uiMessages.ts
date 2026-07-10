export const SUPPORTED_APP_LOCALES = ['en', 'it'] as const;

export type AppLocale = (typeof SUPPORTED_APP_LOCALES)[number];

type UiMessageVariables = Record<string, number | string>;

const DEFAULT_APP_LOCALE: AppLocale = 'en';
const supportedLocales = new Set<string>(SUPPORTED_APP_LOCALES);

const ENGLISH_UI_MESSAGES = {
  Accedi: 'Sign in',
  Abilita: 'Enable',
  Aggiorna: 'Refresh',
  Amministrazione: 'Administration',
  'Accedi al tuo spazio di studio per sincronizzare corsi, note e progressi.':
    'Sign in to your study space to sync courses, notes, and progress.',
  'Accesso alla preview': 'Preview access',
  'Accesso non riuscito.': 'Sign-in failed.',
  'Accesso tester': 'Tester access',
  'Anteprima del lettore Nous': 'Nous Reader preview',
  'Apri menu': 'Open menu',
  Annulla: 'Cancel',
  'Analisi Volume in Corso...': 'Analyzing source material...',
  'Apri progetto': 'Open project',
  'Apri cartella': 'Open folder',
  Azioni: 'Actions',
  'Azioni cartella': 'Folder actions',
  'Autenticazione non configurata. Imposta VITE_AUTH_MODE=supabase e collega Supabase per accedere alla libreria server.':
    'Authentication is not configured. Set VITE_AUTH_MODE=supabase and connect Supabase to access the server library.',
  'Aggiungi PDF e libri, oppure parti da una ricerca guidata.':
    'Add PDFs and books, or start from guided research.',
  Calibrazione: 'Calibration',
  'Cambia tema': 'Change theme',
  'Caricamento...': 'Loading...',
  Chiudi: 'Close',
  'Chiudi accesso': 'Close access',
  'Chiudi menu': 'Close menu',
  'Chiudi conferma': 'Close confirmation',
  'Chiudi menu progetto': 'Close project menu',
  'Chiudi cartella': 'Close folder',
  'Chiudi menu cartella': 'Close folder menu',
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
  Evidenzia: 'Highlight',
  'Fai domande, ottieni spiegazioni e verifica la tua comprensione.':
    'Ask questions, get explanations, and check your understanding.',
  'Email per la waitlist': 'Waitlist email',
  'Entra nella waitlist': 'Join the waitlist',
  Importa: 'Import',
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
  'Invio in corso…': 'Sending…',
  'Importa backup Nous (.nous.zip, formato legacy o JSON legacy)':
    'Import Nous backup (.nous.zip, legacy format, or legacy JSON)',
  Invia: 'Send',
  'Inserisci una password.': 'Enter a password.',
  'Invio magic link non riuscito.': 'Could not send the magic link.',
  'Interroga e verifica': 'Ask and check your understanding',
  'La richiesta non è disponibile in questo momento. Riprova più tardi.':
    'The request is unavailable right now. Try again later.',
  'La tua email': 'Your email',
  lezioni: 'lessons',
  Libreria: 'Library',
  'Magic link inviato. Controlla la tua email.': 'Magic link sent. Check your email.',
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
  'Reti e Internet': 'Networks and the Internet',
  Rinomina: 'Rename',
  'Rinomina cartella...': 'Rename folder...',
  Salva: 'Save',
  'Salva modelli': 'Save models',
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
  'Chiudi anteprima artefatto': 'Close artifact preview',
  'Chiudi artefatto': 'Close artifact',
  'Conferma rigenerazione': 'Confirm regeneration',
  'Ferma e trascrivi': 'Stop and transcribe',
  'Generazione artefatto in corso...': 'Generating artifact...',
  'Immagine generata': 'Generated image',
  'Immagine non disponibile': 'Image unavailable',
  'Immagine PDF': 'PDF image',
  Interattivo: 'Interactive',
  'Istruzioni rigenerazione': 'Regeneration instructions',
  'La registrazione audio non è supportata da questo browser.':
    'Audio recording is not supported by this browser.',
  'La registrazione si è interrotta. Riprova.': 'Recording stopped unexpectedly. Try again.',
  'Nessun microfono disponibile.': 'No microphone is available.',
  'Non ho rilevato audio. Riprova.': 'No audio was detected. Try again.',
  'Non riesco ad accedere al microfono. Riprova.': 'I cannot access the microphone. Try again.',
  'Operazione ancora in corso, non e un blocco.': 'Still working; the app is not stuck.',
  'Permesso microfono negato. Abilitalo nelle impostazioni del browser.':
    'Microphone permission was denied. Enable it in your browser settings.',
  'Registrazione in corso.': 'Recording in progress.',
  Rigenera: 'Regenerate',
  'Rigenera artefatto': 'Regenerate artifact',
  'Rigenera bozza': 'Regenerate draft',
  'Rigenerazione...': 'Regenerating...',
  'Rigenerazione fallita. La bozza precedente non e stata modificata.':
    'Regeneration failed. The previous draft was not changed.',
  'Rigenerazione richiesta.': 'Regeneration requested.',
  'Salva artefatto nelle note': 'Save artifact to notes',
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
  'Pannello admin non disponibile.': 'The admin panel is unavailable.',
  'Password aggiornata.': 'Password updated.',
  'Salvataggio modelli non riuscito.': 'Could not save the models.',
  Utenti: 'Users',
  Voce: 'Voice',
  'Pianificazione esercizi completata.': 'Exercise planning completed.',
  'Non sono riuscito a pianificare gli esercizi.': 'I could not plan the exercises.',
  'Non sono riuscito a salvare la consegna.': 'I could not save the submission.',
  'Non sono riuscito a rimuovere il file.': 'I could not remove the file.',
  'Non sono riuscito ad allegare il file.': 'I could not attach the file.',
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
  'Apri concetti chiave, {itemCount}': 'Open key concepts, {itemCount}',
  'Chiudi concetti chiave': 'Close key concepts',
  'Chiudi concetti chiave dallo sfondo': 'Close key concepts from the backdrop',
  'Chiudi menu audio': 'Close audio menu',
  'Comprimi concetti chiave': 'Collapse key concepts',
  'Concetti chiave': 'Key concepts',
  Definizione: 'Definition',
  Formula: 'Formula',
  Analogia: 'Analogy',
  Simbolo: 'Symbol',
  'Espandi concetti chiave': 'Expand key concepts',
  'Supporti contestuali della lezione': 'Contextual lesson aids',
  'Rimuovi {learningAidTitle}': 'Remove {learningAidTitle}',
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
  'Esercizio applicativo': 'Application exercise',
  'File testuale pronto per la valutazione.': 'Text file ready for assessment.',
  'Fonte originale: {sourcePageRangeLabel}': 'Original source: {sourcePageRangeLabel}',
  'Generazione consegna...': 'Generating assignment...',
  'Generazione lezione...': 'Generating lesson...',
  Grassetto: 'Bold',
  'Inserisci heading': 'Insert heading',
  Lista: 'List',
  'La consegna del laboratorio usa le lezioni gia scritte. Mancano ancora:':
    'The lab assignment uses the lessons already written. Still missing:',
  'Nascondi suggerimento selezione testo': 'Hide text-selection hint',
  'Parte {partNumber}': 'Part {partNumber}',
  'Parte {partNumber} evidenziata. Fai clic per sceglierla.':
    'Part {partNumber} highlighted. Click to choose it.',
  'Prima genera le lezioni precedenti': 'Generate the previous lessons first',
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
  'Il TTS genera audio e non usa una forza di ragionamento.':
    'TTS generates audio and does not use reasoning effort.',
  'La struttura viene prima del testo, così sai sempre dove stai andando.':
    'Structure comes before prose, so you always know where you are going.',
  'Leggi, ascolta, verifica e continua quando sei pronto.':
    'Read, listen, check your understanding, and continue when you are ready.',
  Low: 'Low',
  Medium: 'Medium',
  'Micro-sintesi': 'Micro-synthesis',
  Generazione: 'Generation',
  'Nessuno / non supportato': 'None / unsupported',
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

export const getAppLocale = (): AppLocale => resolveAppLocale(getBrowserLanguagePreferences());

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
