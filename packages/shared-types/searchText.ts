const SEARCH_KEYWORD_STOP_WORDS = new Set([
  'about',
  'agli',
  'alla',
  'alle',
  'anche',
  'avere',
  'bene',
  'che',
  'come',
  'con',
  'core',
  'dall',
  'dalla',
  'dalle',
  'degli',
  'della',
  'delle',
  'dello',
  'dopo',
  'dove',
  'ecco',
  'fare',
  'figura',
  'figure',
  'from',
  'have',
  'into',
  'lesson',
  'lezione',
  'line',
  'nelle',
  'nella',
  'nello',
  'niente',
  'only',
  'oppure',
  'over',
  'pero',
  'perche',
  'prima',
  'quale',
  'quali',
  'quando',
  'questa',
  'queste',
  'questi',
  'questo',
  'sara',
  'same',
  'section',
  'sempre',
  'senza',
  'sono',
  'solo',
  'sotto',
  'sugli',
  'sulla',
  'sulle',
  'that',
  'them',
  'they',
  'through',
  'titolo',
  'tutto',
  'with',
  'your',
]);

export const normalizeSearchText = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/[^a-z0-9\s]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

export const getSearchKeywords = (text: string): string[] =>
  normalizeSearchText(text)
    .split(' ')
    .filter(word => word.length >= 4 && !SEARCH_KEYWORD_STOP_WORDS.has(word));
