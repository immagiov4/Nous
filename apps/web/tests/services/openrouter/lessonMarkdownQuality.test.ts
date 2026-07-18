import { describe, expect, it } from 'vitest';
import {
  hasBrokenDisplayMathBracketBlock,
  hasSplitTextPseudocodeFence,
  stripMarkdownForSimilarity,
} from '../../../services/openrouter/lessonMarkdownQuality/markdownHeuristics.ts';
import { sanitizeLessonMarkdownContent } from '../../../services/openrouter/lessonMarkdownQuality/quality.ts';
import { parseQuizPayload } from '../../../services/openrouter/lessonMarkdownQuality/quiz.ts';

describe('lessonMarkdownQuality markdown heuristics', () => {
  it('strips markdown links, images, html, and PDF image tokens for similarity checks', () => {
    const normalized = stripMarkdownForSimilarity(
      'Intro [link](https://example.com) ![alt](img.png) {{PDF_IMAGE:abc}} <img src="x" /> fine'
    );

    expect(normalized).toBe('Intro fine');
  });

  it('detects broken display math bracket blocks', () => {
    expect(hasBrokenDisplayMathBracketBlock('Prima riga\n[\nx + y\n]\nUltima riga')).toBe(true);
    expect(hasBrokenDisplayMathBracketBlock('Formula inline [x+y] ok')).toBe(false);
  });

  it('detects pseudocode split across multiple text fences', () => {
    const broken = ['```text', 'IF x > 0', '```', '  RETURN x', '```text', 'ENDIF', '```'].join(
      '\n'
    );

    expect(hasSplitTextPseudocodeFence(broken)).toBe(true);
    expect(hasSplitTextPseudocodeFence('```text\nsolo testo descrittivo\n```')).toBe(false);
  });

  it('unwraps whole-quiz code fences and inline code without changing plain text', () => {
    expect(
      parseQuizPayload([
        {
          correctIndex: 0,
          exerciseType: 'recall',
          options: ['`prima`', '```text\nseconda\n```', 'terza', 'quarta'],
          question: '```json\nDomanda con\npiu righe\n```',
        },
      ])
    ).toEqual([
      {
        correctIndex: 0,
        exerciseType: 'concept-check',
        options: ['prima', 'seconda', 'terza', 'quarta'],
        question: 'Domanda con piu righe',
      },
    ]);
  });

  it('adds heading spacing and trims trailing line whitespace without regex-only formatting', () => {
    const normalized = sanitizeLessonMarkdownContent(
      'Prima frase utile   \n## Titolo\nTesto sotto heading   '
    );

    expect(normalized).toContain('Prima frase utile\n\n## Titolo');
    expect(normalized).not.toContain('   \n');
  });
});
