/**
 * Deduplica, ordina e filtra un array di numeri di pagina, restituendo solo
 * interi positivi unici. Se l'array risultante è vuoto restituisce undefined.
 *
 * Versione canonica condivisa tra frontend e backend.
 */
export const sanitizePartialPages = (partialPages: number[] | undefined): number[] | undefined => {
  if (!Array.isArray(partialPages) || partialPages.length === 0) {
    return undefined;
  }

  const cleaned = Array.from(
    new Set(
      partialPages.filter(page => Number.isInteger(page) && page > 0).map(page => Math.trunc(page))
    )
  ).sort((left, right) => left - right);

  return cleaned.length > 0 ? cleaned : undefined;
};
