import type { PlaybackSpokenMath } from '@shared/lessonPlayback';

// Original Italian examples: notation is shared with standard discrete-mathematics courses.
export const discreteMathCases: readonly {
  name: string;
  markdown: string;
  spokenMath: readonly PlaybackSpokenMath[];
}[] = [
  {
    name: 'logic and repeated occurrences',
    // Bun escapes non-ASCII narration in tagged templates during direct provider runs.
    // eslint-disable-next-line unicorn/prefer-string-raw
    markdown: `Per ogni elemento scriviamo $\\forall x\\in A\\;\\exists y\\in B: R(x,y)$. La negazione è $\\neg P$, la congiunzione $P\\land Q$ e la disgiunzione $P\\lor Q$. Confrontiamo $P\\Rightarrow Q$ con $P\\iff Q$. Ripetiamo $P\\land Q$ nello stesso ragionamento.`,
    spokenMath: [
      {
        formula: String.raw`$\forall x\in A\;\exists y\in B: R(x,y)$`,
        spoken:
          'per ogni ics appartenente ad A esiste ipsilon appartenente a B tale che erre di ics e ipsilon',
      },
      { formula: String.raw`$\neg P$`, spoken: 'non pi' },
      { formula: String.raw`$P\land Q$`, spoken: 'pi e cu' },
      { formula: String.raw`$P\lor Q$`, spoken: 'pi oppure cu' },
      { formula: String.raw`$P\Rightarrow Q$`, spoken: 'pi implica cu' },
      { formula: String.raw`$P\iff Q$`, spoken: 'pi se e solo se cu' },
      { formula: String.raw`$P\land Q$`, spoken: 'pi congiunto con cu' },
    ],
  },
  {
    name: 'sets and functions',
    // Bun escapes non-ASCII narration in tagged templates during direct provider runs.
    // eslint-disable-next-line unicorn/prefer-string-raw
    markdown: `Consideriamo $A\\subseteq B$, poi $A\\cup B$ e $A\\cap B$. L'insieme senza elementi è $\\emptyset$. Descriviamo $C=\\{x\\mid x\\in A\\land x>2\\}$. Confrontiamo $|A|$ e $\\mathcal{P}(A)$. Una funzione si scrive $f: A\\to B$.`,
    spokenMath: [
      { formula: String.raw`$A\subseteq B$`, spoken: 'A incluso o uguale a B' },
      { formula: String.raw`$A\cup B$`, spoken: 'A unione B' },
      { formula: String.raw`$A\cap B$`, spoken: 'A intersezione B' },
      { formula: String.raw`$\emptyset$`, spoken: 'insieme vuoto' },
      {
        formula: String.raw`$C=\{x\mid x\in A\land x>2\}$`,
        spoken:
          'C uguale all’insieme degli ics tali che ics appartiene ad A e ics è maggiore di due',
      },
      { formula: '$|A|$', spoken: 'cardinalità di A' },
      { formula: String.raw`$\mathcal{P}(A)$`, spoken: 'insieme delle parti di A' },
      { formula: String.raw`$f: A\to B$`, spoken: 'effe da A a B' },
    ],
  },
  {
    name: 'counting and congruences',
    // Bun escapes non-ASCII narration in tagged templates during direct provider runs.
    // eslint-disable-next-line unicorn/prefer-string-raw
    markdown: `Per contare le scelte usiamo $\\binom{n}{k}$ e $n!$. La congruenza è $a\\equiv b\\pmod{n}$. Confrontiamo $\\lfloor n/2\\rfloor$ con $\\sum_{i=1}^{n}i$. Ritroviamo $\\binom{n}{k}$ nel conteggio finale.`,
    spokenMath: [
      { formula: String.raw`$\binom{n}{k}$`, spoken: 'coefficiente binomiale enne su cappa' },
      { formula: '$n!$', spoken: 'enne fattoriale' },
      { formula: String.raw`$a\equiv b\pmod{n}$`, spoken: 'a congruo a b modulo enne' },
      {
        formula: String.raw`$\lfloor n/2\rfloor$`,
        spoken: 'parte intera inferiore di enne diviso due',
      },
      { formula: String.raw`$\sum_{i=1}^{n}i$`, spoken: 'somma di i per i da uno a enne' },
      { formula: String.raw`$\binom{n}{k}$`, spoken: 'enne su cappa' },
    ],
  },
];
