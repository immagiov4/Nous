import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../../..');
const UI_SOURCE_ROOTS = [
  resolve(WORKSPACE_ROOT, 'apps/web/app'),
  resolve(WORKSPACE_ROOT, 'apps/web/components'),
];
const EXCLUDED_FILES = new Set([
  resolve(WORKSPACE_ROOT, 'apps/web/components/dev/StylePreviewLab.tsx'),
]);
const ITALIAN_UI_MARKER =
  /\b(?:abilita|accedi|aggiungi|aggiorna|allega|ambiente|amministrazione|annulla|apri|artefatti|avvio|caricamento|cartella|cerca|chiudi|completa|conferma|consegna|consulta|contenuto|contesto|correzione|corso|corsi|descrivi|disabilita|elimina|errore|esercizio|esporta|evidenzia|genera|generazione|immagine|imposta|importa|indietro|interroga|invia|lezione|lezioni|libreria|modelli|modifica|mostra|nascondi|nessun|nota|nuova|parte|pausa|percorso|preferenze|procedi|profilazione|progetto|pulisci|richiesta|rinomina|riproduci|riprova|riscontro|risposta|rimuovi|salva|scegli|seleziona|sincronizzazione|sorgente|sostituisci|sposta|strumenti|traccia|utenti|valutazione|velocita|voce)\b/i;

const collectTypeScriptFiles = (directory: string): string[] => {
  const result = ts.sys.readDirectory(directory, ['.ts', '.tsx'], undefined, undefined);
  return result.filter(filePath => !EXCLUDED_FILES.has(resolve(filePath)));
};

const isTranslationCall = (node: ts.Node): boolean => {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
      return current.expression.text === 't' || current.expression.text === 'translateUiMessage';
    }
    current = current.parent;
  }
  return false;
};

const isLocaleConditionalLiteral = (node: ts.Node): boolean => {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isConditionalExpression(current)) {
      return current.condition.getText() === 'isItalian';
    }
    if (ts.isStatement(current)) {
      return false;
    }
    current = current.parent;
  }
  return false;
};

const isInternalIdentifierLiteral = (node: ts.Node): boolean => {
  const parent = node.parent;
  if (
    ts.isLiteralTypeNode(parent) ||
    ts.isBindingElement(parent) ||
    ts.isParameter(parent) ||
    (ts.isBinaryExpression(parent) && (parent.left === node || parent.right === node))
  ) {
    return true;
  }

  if (
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    parent.expression.expression.getText() === 'console'
  ) {
    return true;
  }

  if (!ts.isCallExpression(parent) || !ts.isIdentifier(parent.expression)) {
    return false;
  }

  return /^(?:on|set)[A-Z]/.test(parent.expression.text);
};

const getCandidateText = (node: ts.Node): string | null => {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    ts.isJsxText(node)
  ) {
    return node
      .getText()
      .replaceAll(/^['"`]|['"`]$/g, '')
      .trim();
  }
  return null;
};

const findUnlocalizedUiText = (filePath: string): string[] => {
  const sourceText = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const findings: string[] = [];

  const visit = (node: ts.Node) => {
    const text = getCandidateText(node);
    if (
      text &&
      ITALIAN_UI_MARKER.test(text) &&
      !isTranslationCall(node) &&
      !isLocaleConditionalLiteral(node) &&
      !isInternalIdentifierLiteral(node)
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      findings.push(`${relative(WORKSPACE_ROOT, filePath)}:${line} — ${text.slice(0, 100)}`);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
};

describe('UI localization coverage', () => {
  test('keeps Italian interface copy behind the automatic translator', () => {
    const findings = UI_SOURCE_ROOTS.flatMap(collectTypeScriptFiles).flatMap(findUnlocalizedUiText);

    expect(findings, findings.join('\n')).toEqual([]);
  });
});
