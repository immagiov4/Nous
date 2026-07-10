import { getAppLocale, translateUiMessage, type UiMessage } from './uiMessages.ts';

const ENGLISH_MARKETING_MESSAGES = {
  'IL CORSO CHE MANCAVA AI TUOI MATERIALI': 'THE COURSE YOUR MATERIALS WERE MISSING',
  'Un corso intero. Un passo alla volta.': 'A whole course. One step at a time.',
  'Slide sopravvissute a tre versioni di PowerPoint? Un libro che spiega tutto, tranne quello che chiederà all’esame?':
    'Slides that survived three versions of PowerPoint? A book that explains everything except what will be on the exam?',
  'Carica un PDF o un archivio di materiali. Nous costruisce lezioni leggibili, domande, note e audio, sempre dal punto in cui eri rimasto.':
    'Upload a PDF or an archive of materials. Nous builds readable lessons, questions, notes, and audio, always from where you left off.',
  'Le slide del professore sembrano sopravvissute a tre versioni di PowerPoint? Il libro spiega tutto, tranne quello che chiederà all’esame?':
    'Do your professor’s slides look like they survived three versions of PowerPoint? Does the book explain everything except what will be on the exam?',
  'Metti insieme slide, dispense e libri. Nous li trasforma nel corso che avresti voluto ricevere: lezioni leggibili, domande, note e audio, sempre dal punto in cui eri rimasto.':
    'Bring your slides, course notes, and books together. Nous turns them into the course you wish you had received: readable lessons, questions, notes, and audio, always from where you left off.',
  'Richiedi l’accesso alla preview': 'Request preview access',
  'Sei già tester? Usa Accedi in alto.': 'Already a tester? Use Sign in above.',
  'Materiali di studio disordinati': 'Disorganized study materials',
  'Architetture di rete': 'Network architectures',
  'dispense_finale_v7.pdf': 'course_notes_final_v7.pdf',
  '“Importante per l’esame”': '“Important for the exam”',
  'Libro · 684 pagine': 'Book · 684 pages',
  'Il tuo corso': 'Your course',
  'Reti e Internet': 'Networks and the Internet',
  '2 lezioni completate · riprendi dalla 3': '2 lessons complete · resume from 3',
  'Il materiale non dovrebbe essere un secondo esame.':
    'The material should not feel like a second exam.',
  'Finalmente il materiale diventa studiabile.':
    'Finally, the material becomes something you can study.',
  'Non sei tu che devi ricostruire il filo tra slide, libro, appunti e cinque chat diverse.':
    'You should not have to reconstruct the thread between slides, the book, notes, and five different chats.',
  'Dal caos al corso': 'From chaos to course',
  'Scorri. Guarda il materiale diventare studiabile.':
    'Scroll. Watch the material become something you can study.',
  'Metti tutto sul tavolo.': 'Put everything on the table.',
  'Carica il PDF del corso oppure uno ZIP con più file. Nous parte dal materiale che devi davvero studiare.':
    'Upload the course PDF or a ZIP containing multiple files. Nous starts from the material you actually have to study.',
  'PDF, testi e archivi ZIP': 'PDFs, text files, and ZIP archives',
  'Le fonti restano collegate al corso': 'Sources stay connected to the course',
  'Il libro, le slide vecchie, le dispense del corso. Non devi scegliere una fonte perfetta: Nous parte da quello che devi davvero studiare.':
    'The book, the old slides, the course notes. You do not need to choose one perfect source: Nous starts from what you actually have to study.',
  'Nous ricostruisce il filo.': 'Nous reconstructs the thread.',
  'Prima prepara il piano. Poi genera una lezione alla volta, abbastanza chiara da farti orientare senza riscrivere il libro.':
    'First it prepares the plan. Then it generates one lesson at a time, clear enough to guide you without rewriting the book.',
  'Moduli, lezioni e attività': 'Modules, lessons, and activities',
  'Il progresso viene salvato': 'Progress is saved',
  'Prima crea il piano. Poi trasforma le fonti in moduli e lezioni che spiegano abbastanza da permetterti di orientarti nell’argomento.':
    'First it creates the plan. Then it turns the sources into modules and lessons that explain enough for you to find your way through the subject.',
  'Studi senza uscire dal contesto.': 'Study without leaving the context.',
  'Se un passaggio non è chiaro, chiedi lì. La risposta conosce la lezione e le fonti: niente copia e incolla in un’altra chat.':
    'If a passage is unclear, ask right there. The answer knows the lesson and its sources: no copying and pasting into another chat.',
  'Salva note, esempi e sottolezioni': 'Save notes, examples, and follow-up lessons',
  'Se un passaggio non è chiaro, chiedi lì. Puoi salvare una nota, ottenere un esempio visivo o aprire una sottolezione senza ricominciare da zero in un’altra chat.':
    'If a passage is unclear, ask right there. Save a note, get a visual example, or open a follow-up lesson without starting over in another chat.',
  'Chiudi. Torna. Riparti da lì.': 'Close it. Come back. Pick up there.',
  'Lezioni, evidenziazioni e note restano insieme. Puoi riprendere dal computer o dal telefono, leggendo oppure ascoltando.':
    'Lessons, highlights, and notes stay together. Continue on your computer or phone, reading or listening.',
  'Testo, audio e musica per concentrarti': 'Text, audio, and music to help you focus',
  'Tutto disponibile sui tuoi dispositivi': 'Everything available across your devices',
  'Progressi, evidenziazioni, note e lezioni restano insieme. Dal computer o dal telefono, il prossimo passo è già pronto.':
    'Progress, highlights, notes, and lessons stay together. On your computer or phone, the next step is already ready.',
  'Un solo posto per studiare': 'One place to study',
  'Non devi più fare il regista del tuo studio.':
    'You no longer have to direct your own study workflow.',
  'Chiedi nel punto esatto': 'Ask at the exact point',
  'La risposta conosce la lezione e le fonti del corso. Niente copia e incolla, niente contesto da ricostruire.':
    'The answer knows the lesson and the course sources. No copying and pasting, no context to rebuild.',
  'Trasforma i dubbi in materiale utile': 'Turn doubts into useful material',
  'Salva note ed esempi, oppure crea una sottolezione quando ti manca una base. Rimane tutto accanto a ciò che stavi leggendo.':
    'Save notes and examples, or create a follow-up lesson when you are missing a foundation. It all stays beside what you were reading.',
  'Leggi oppure ascolta': 'Read or listen',
  'Usa il TTS, associa la musica con cui ti concentri e continua anche dal telefono, senza passarti file da un dispositivo all’altro.':
    'Use text to speech, add the music that helps you focus, and continue on your phone without passing files between devices.',
  'Ripassa ciò che conta davvero': 'Review what actually matters',
  'Domande, attività, definizioni e parti evidenziate restano recuperabili quando arriva il momento di preparare l’esame.':
    'Questions, activities, definitions, and highlights remain available when it is time to prepare for the exam.',
  'L’ho costruito perché mi serviva.': 'I built it because I needed it.',
  'Volevo studiare senza spendere metà dell’energia a sistemare materiali, cambiare app e ricordarmi dove avevo lasciato ogni cosa.':
    'I wanted to study without spending half my energy organizing materials, switching apps, and remembering where I left everything.',
  'Volevo studiare seriamente senza spendere metà dell’energia a sistemare materiali, cambiare app e ricordarmi dove avevo lasciato ogni cosa. Nous nasce da quella frustrazione.':
    'I wanted to study seriously without spending half my energy organizing materials, switching apps, and remembering where I left everything. Nous grew out of that frustration.',
  'Porta il materiale. Ritrova il corso.': 'Bring the material. Find the course.',
  'Porta il materiale. Al corso pensa Nous.': 'Bring the material. Nous takes care of the course.',
  'Richiedi l’accesso alla preview di Nous Reader.': 'Request access to the Nous Reader preview.',
  'Sei già tester? Accedi': 'Already a tester? Sign in',
  'Chiedi alla lezione': 'Ask this lesson',
  'Perché due compiti insieme peggiorano la prestazione?':
    'Why does performance drop when doing two tasks at once?',
  'Perché competono per la stessa risorsa cognitiva limitata.':
    'Because they compete for the same limited cognitive resource.',
  'Preparazione del corso': 'Course preparation',
  '2 fonti collegate': '2 connected sources',
  'Piano del corso': 'Course plan',
  'Prepara il piano': 'Prepare the plan',
  'Dal problema della comunicazione a Internet': 'From the communication problem to the Internet',
  'Come viaggiano i dati': 'How data travels',
  'Reti locali, VLAN e instradamento': 'Local networks, VLANs, and routing',
  '186 pagine': '186 pages',
  '24 file': '24 files',
  '4 lezioni': '4 lessons',
  '5 lezioni': '5 lessons',
  '6 lezioni': '6 lessons',
} as const;

type MarketingMessage = keyof typeof ENGLISH_MARKETING_MESSAGES;

export const translateMarketingMessage = (message: MarketingMessage | UiMessage): string => {
  if (getAppLocale() === 'it') {
    return message;
  }

  const marketingTranslation = (ENGLISH_MARKETING_MESSAGES as Record<string, string>)[message];
  return marketingTranslation ?? translateUiMessage(message as UiMessage);
};
