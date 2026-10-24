// ISO 639-3 languages accepted by aeneas. Intl supplies canonical tags and localized names.
const AENEAS_LANGUAGES =
  'afr amh ara arg asm aze ben bos bul cat ces cmn cym dan deu ell eng epo est eus fas fin fra gla gle glg grc grn guj heb hin hrv hun hye ina ind isl ita jbo jpn kal kan kat kir kor kur lat lav lfn lit mal mar mkd mlt msa mya nah nep nld nor ori orm pan pap pol por ron rus sin slk slv spa sqi srp swa swe tam tat tel tha tsn tur ukr urd vie yue zho'.split(
    ' '
  );

const normalize = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase('und');
const languages = new Map<string, string>();
for (const code of AENEAS_LANGUAGES) {
  const tag = new Intl.Locale(code).language;
  for (const name of [
    code,
    tag,
    ...['en', 'it', tag].map(locale =>
      new Intl.DisplayNames([locale], { type: 'language' }).of(tag)
    ),
  ]) {
    if (name) languages.set(normalize(name), code);
  }
}

/** Resolve explicit course language metadata; unknown names must not select unrelated phonetics. */
export function alignmentLanguage(language: string): string {
  const name = normalize(language);
  const named = languages.get(name);
  if (named) return named;
  try {
    const code = languages.get(new Intl.Locale(name).language);
    if (code) return code;
  } catch {
    // Free-form course names need not be valid BCP 47 tags.
  }
  throw new Error('Unsupported recording alignment language.');
}
