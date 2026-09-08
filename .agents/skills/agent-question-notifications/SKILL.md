---
name: agent-question-notifications
description: Mostra un post-it persistente quando un lavoro agentico lungo richiede una risposta dell'utente, comprese domande da revisioni di PR, agenti locali o autorevisioni. La risposta rimane nella conversazione originale.
---

# Avvisi per le domande degli agenti

Quando serve una decisione durante un lavoro lungo, pubblica la domanda nella
conversazione dove l'utente deve rispondere e mostrane un post-it sul computer.
Usalo per domande reali, non per aggiornamenti ordinari o decisioni già ricevute.

## Invio

1. Usa il programma incluso [scripts/questions.py](scripts/questions.py), oppure
   `AGENT_QUESTIONS_SCRIPT` se configurato. Richiede Python 3.11 o successivo con Tk;
   su Linux può servire il pacchetto `python3-tk` e una sessione grafica locale.
2. Scrivi un file JSON UTF-8 con quattro campi:
   - `id`: identificatore stabile per progetto, attività e decisione, ad esempio
     `nous-pr164-review-storage-1`;
   - `source`: agente e attività;
   - `context`: progetto, titolo della conversazione dove rispondere e riferimento
     alla PR o al documento, se presente;
   - `question`: domanda completa con il contesto decisionale e le alternative
     necessarie a comprenderla senza leggere altri sotto-thread.
3. Esegui `python <percorso-programma> notify <file-json>` con percorsi quotati.
   Mantieni i testi nel file, fuori dalle interpolazioni di shell.
4. Controlla l'esito. Il salvataggio non prova che la finestra sia visibile:
   se manca una sessione grafica o l'avvio fallisce, segnala il limite nella
   conversazione. Consulta `window.log` in `~/.agent-questions`, oppure nella cartella
   indicata da `AGENT_QUESTIONS_HOME`. Evita tentativi ripetuti senza nuove evidenze.

Riusa ID e contenuto nei tentativi della stessa domanda. Sono deduplicati anche
i post-it già chiusi. Una domanda cambiata richiede un nuovo ID.
Nelle deleghe assegna un proprietario e un ID alla domanda: l'agente o
l'orchestratore invia l'avviso, senza duplicarlo tra i due.

## Decisione

«Ho letto» chiude soltanto il post-it: non è una risposta o un'approvazione.
Leggi la risposta nella conversazione originale e inoltrala all'agente interessato
quando necessario. Prosegui il lavoro indipendente già autorizzato mentre aspetti.

Per valutare le osservazioni prima di decidere se occorre una domanda, usa
[receiving-pr-reviews](../receiving-pr-reviews/SKILL.md).
