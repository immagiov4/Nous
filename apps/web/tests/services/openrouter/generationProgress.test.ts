import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const callOpenRouterMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/openrouter/client.ts', () => ({
  callOpenRouter: callOpenRouterMock,
}));

const { createGenerationProgressObserver } = await import(
  '../../../services/openrouter/generationProgress.ts'
);

describe('generation progress observer', () => {
  beforeEach(() => {
    callOpenRouterMock.mockReset();
    callOpenRouterMock.mockResolvedValue(
      JSON.stringify({
        sections: ['Introduzione', 'Introduzione', 'Applicazioni'],
      })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('summarizes only after a bounded threshold and validates the generated payload', async () => {
    const updates: Array<{ sections: string[] }> = [];
    const observer = createGenerationProgressObserver({
      operation: 'lesson',
      revealIntervalMs: 0,
      subject: 'Memoria',
      onUpdate: update => updates.push(update),
    });

    observer.push('a'.repeat(599));
    expect(callOpenRouterMock).not.toHaveBeenCalled();

    observer.push(`a${'b'.repeat(6_000)}`);
    await observer.finish();

    expect(callOpenRouterMock).toHaveBeenCalledTimes(1);
    expect(callOpenRouterMock.mock.calls[0]?.[0]).toMatchObject({
      modelSlot: 'progress',
      reasoning: { effort: 'low' },
    });
    expect(updates.at(-1)?.sections).toEqual([
      'Preparo il materiale della lezione.',
      'Introduzione',
      'Applicazioni',
    ]);
    const prompt = callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[1]?.content as string;
    expect(prompt.length).toBeLessThan(5_500);
  });

  test('uses real status events for deterministic stages', () => {
    const updates: Array<{ stage: string }> = [];
    const observer = createGenerationProgressObserver({
      operation: 'lesson',
      revealIntervalMs: 0,
      subject: 'Memoria',
      onUpdate: update => updates.push(update),
    });

    observer.updateStatus('Verifica finale della lezione...');
    observer.complete();

    expect(updates.some(update => update.stage === 'verification')).toBe(true);
    expect(updates.at(-1)?.stage).toBe('ready');
  });

  test('never regresses a stage when a late status describes earlier work', () => {
    const updates: Array<{ stage: string }> = [];
    const observer = createGenerationProgressObserver({
      operation: 'lesson',
      revealIntervalMs: 0,
      subject: 'Memoria',
      onUpdate: update => updates.push(update),
    });

    observer.updateStatus('Strutturazione della lezione...');
    observer.push('Inizio della stesura');
    observer.updateStatus('Scrittura della lezione...');
    observer.updateStatus('Analisi immagini... trovate 3');
    observer.updateStatus('Organizzazione quiz...');
    observer.updateStatus('Verifica finale...');

    const stageSequence = updates
      .map(update => update.stage)
      .filter((stage, index, stages) => stage !== stages[index - 1]);
    expect(stageSequence).toEqual(['sources', 'structure', 'drafting', 'quiz', 'verification']);
  });

  test('appends new points and keeps absolute numbering while the visible window advances', async () => {
    callOpenRouterMock
      .mockResolvedValueOnce(
        JSON.stringify({
          sections: ['Primo punto', 'Secondo punto', 'Terzo punto'],
        })
      )
      .mockResolvedValueOnce(JSON.stringify({ sections: ['Sesto punto'] }));
    const updates: Array<{ sections: string[]; stepOffset: number }> = [];
    const observer = createGenerationProgressObserver({
      operation: 'lesson',
      revealIntervalMs: 0,
      subject: 'Memoria',
      onUpdate: update => updates.push(update),
    });

    const firstStream = 'a'.repeat(600);
    observer.push(firstStream);
    await observer.finish();
    observer.push(`${firstStream}${'b'.repeat(600)}`);
    await observer.finish();

    expect(updates.at(-1)?.sections).toEqual(['Secondo punto', 'Terzo punto', 'Sesto punto']);
    expect(updates.at(-1)?.stepOffset).toBe(2);
  });

  test('reveals a multi-point batch one item at a time', async () => {
    vi.useFakeTimers();
    callOpenRouterMock.mockResolvedValue(
      JSON.stringify({
        sections: ['Primo dettaglio', 'Secondo dettaglio', 'Terzo dettaglio'],
      })
    );
    const updates: Array<{ sections: string[] }> = [];
    const observer = createGenerationProgressObserver({
      operation: 'lesson',
      subject: 'Memoria',
      onUpdate: update => updates.push(update),
    });

    observer.push('a'.repeat(600));
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.at(-1)?.sections.at(-1)).toBe('Primo dettaglio');

    await vi.advanceTimersByTimeAsync(2_499);
    expect(updates.at(-1)?.sections.at(-1)).toBe('Primo dettaglio');
    await vi.advanceTimersByTimeAsync(1);
    expect(updates.at(-1)?.sections.at(-1)).toBe('Secondo dettaglio');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(updates.at(-1)?.sections.at(-1)).toBe('Terzo dettaglio');
    await observer.finish();
  });

  test('uses a fresh observer budget after the pipeline changes phase', async () => {
    callOpenRouterMock.mockImplementation(async () =>
      JSON.stringify({
        sections: [`Dettaglio ${callOpenRouterMock.mock.calls.length}`],
      })
    );
    const observer = createGenerationProgressObserver({
      operation: 'lesson',
      revealIntervalMs: 0,
      subject: 'Memoria',
      onUpdate: vi.fn(),
    });
    let stream = '';

    for (let index = 0; index < 4; index += 1) {
      stream += String(index).repeat(600);
      observer.push(stream);
      await observer.finish();
    }
    expect(callOpenRouterMock).toHaveBeenCalledTimes(3);

    observer.updateStatus('Organizzazione quiz...');
    stream += 'q'.repeat(600);
    observer.push(stream);
    await observer.finish();
    expect(callOpenRouterMock).toHaveBeenCalledTimes(4);
  });

  test('rejects observer text that does not use the selected language', async () => {
    callOpenRouterMock.mockResolvedValue(
      JSON.stringify({
        sections: ['Handling JSON and LaTeX', 'Clarifying terms and definitions'],
      })
    );
    const updates: Array<{ sections: string[] }> = [];
    const observer = createGenerationProgressObserver({
      language: 'Italiano',
      operation: 'lesson',
      revealIntervalMs: 0,
      subject: 'Reti',
      onUpdate: update => updates.push(update),
    });

    observer.push('a'.repeat(600));
    await observer.finish();

    expect(updates.at(-1)?.sections).toEqual(['Preparo il materiale della lezione.']);
  });

  test('classifies reasoning inside the current structure stage', async () => {
    const updates: Array<{ sections: string[]; stage: string }> = [];
    const observer = createGenerationProgressObserver({
      operation: 'lesson',
      revealIntervalMs: 0,
      subject: 'Memoria',
      onUpdate: update => updates.push(update),
    });

    observer.updateStatus('Strutturazione della lezione...');
    observer.push('a'.repeat(600));
    await observer.finish();

    expect(updates.at(-1)?.stage).toBe('structure');
    expect(updates.at(-1)?.sections).toContain('Introduzione');
  });
});
