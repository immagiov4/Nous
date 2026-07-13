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
        stage: 'sources',
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

    observer.push('a'.repeat(159));
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

  test('generates a language-aware generic step after a silent interval', async () => {
    vi.useFakeTimers();
    callOpenRouterMock.mockResolvedValue(
      JSON.stringify({ sections: ['Metto a fuoco i concetti centrali'] })
    );
    const updates: Array<{ sections: string[] }> = [];
    const observer = createGenerationProgressObserver({
      idleObservationDelayMs: 12_000,
      language: 'Italiano',
      operation: 'lesson',
      revealIntervalMs: 0,
      subject: 'Generics in TypeScript',
      onUpdate: update => updates.push(update),
    });

    await vi.advanceTimersByTimeAsync(11_999);
    expect(callOpenRouterMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await observer.finish();

    expect(callOpenRouterMock).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)?.sections).toContain('Metto a fuoco i concetti centrali');
    const request = callOpenRouterMock.mock.calls[0]?.[0];
    expect(request.messages[0].content).toContain('exactly one plausible but generic');
    expect(request.messages[0].content).toContain('Every returned string MUST be in Italian');
    expect(request.messages[1].content).toContain('SUBJECT: Generics in TypeScript');
    expect(request.messages[1].content).toContain(
      'PREVIOUS_POINTS:\n- Preparo il materiale della lezione.'
    );
    expect(request.messages[1].content).toContain('STREAM_DATA: not available yet');
  });

  test('resets the silent interval when partial reasoning arrives', async () => {
    vi.useFakeTimers();
    const observer = createGenerationProgressObserver({
      idleObservationDelayMs: 12_000,
      operation: 'plan',
      revealIntervalMs: 0,
      subject: 'Storia della filosofia',
      onUpdate: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(10_000);
    observer.push('Inizio a ordinare i temi');
    await vi.advanceTimersByTimeAsync(11_999);
    expect(callOpenRouterMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await observer.finish();

    expect(callOpenRouterMock).toHaveBeenCalledTimes(1);
    expect(callOpenRouterMock.mock.calls[0]?.[0]?.messages[1].content).toContain(
      'Inizio a ordinare i temi'
    );
    expect(callOpenRouterMock.mock.calls[0]?.[0]?.messages[1].content).not.toContain(
      'not available yet'
    );
  });

  test('only the orchestrator changes the macro stage', async () => {
    callOpenRouterMock.mockResolvedValue(JSON.stringify({ sections: ['Controllo coerenza'] }));
    const updates: Array<{ stage: string }> = [];
    const observer = createGenerationProgressObserver({
      operation: 'lesson',
      revealIntervalMs: 0,
      subject: 'Memoria',
      onUpdate: update => updates.push(update),
    });

    observer.updateStatus('Verifica finale della lezione...');
    await observer.finish();
    expect(updates.at(-1)?.stage).toBe('sources');

    observer.setStage('verification');

    expect(updates.some(update => update.stage === 'verification')).toBe(true);
  });

  test('applies orchestrator stages monotonically and ignores regressions', () => {
    const updates: Array<{ stage: string }> = [];
    const observer = createGenerationProgressObserver({
      operation: 'lesson',
      revealIntervalMs: 0,
      subject: 'Memoria',
      onUpdate: update => updates.push(update),
    });

    observer.setStage('structure');
    observer.setStage('drafting');
    observer.setStage('sources');
    observer.setStage('quiz');
    observer.setStage('verification');

    const stageSequence = updates
      .map(update => update.stage)
      .filter((stage, index, stages) => stage !== stages[index - 1]);
    expect(stageSequence).toEqual(['sources', 'structure', 'drafting', 'quiz', 'verification']);
  });

  test('appends new points and keeps absolute numbering while the visible window advances', async () => {
    callOpenRouterMock
      .mockResolvedValueOnce(
        JSON.stringify({
          stage: 'sources',
          sections: ['Primo punto', 'Secondo punto', 'Terzo punto'],
        })
      )
      .mockResolvedValueOnce(JSON.stringify({ stage: 'sources', sections: ['Sesto punto'] }));
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
        stage: 'sources',
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
      JSON.stringify({ sections: [`Dettaglio ${callOpenRouterMock.mock.calls.length}`] })
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

    observer.setStage('quiz');
    observer.updateStatus('Organizzazione quiz...');
    stream += 'q'.repeat(600);
    observer.push(stream);
    await observer.finish();
    expect(callOpenRouterMock).toHaveBeenCalledTimes(5);
  });

  test('rejects a payload without usable progress points', async () => {
    callOpenRouterMock.mockResolvedValue(
      JSON.stringify({
        sections: [null, '', 42],
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

  test('summarizes reasoning inside the stage selected by the orchestrator', async () => {
    callOpenRouterMock.mockResolvedValue(JSON.stringify({ sections: ['Introduzione'] }));
    const updates: Array<{ sections: string[]; stage: string }> = [];
    const observer = createGenerationProgressObserver({
      operation: 'lesson',
      revealIntervalMs: 0,
      subject: 'Memoria',
      onUpdate: update => updates.push(update),
    });

    observer.setStage('structure');
    observer.updateStatus('Strutturazione della lezione...');
    observer.push('a'.repeat(600));
    await observer.finish();

    expect(updates.at(-1)?.stage).toBe('structure');
    expect(updates.at(-1)?.sections).toContain('Introduzione');
  });

  test('processes an authoritative status queued while the observer is busy', async () => {
    let resolveFirstRequest: ((value: string) => void) | undefined;
    callOpenRouterMock
      .mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            resolveFirstRequest = resolve;
          })
      )
      .mockResolvedValueOnce(JSON.stringify({ sections: ['Secondo stato'] }));
    const observer = createGenerationProgressObserver({
      operation: 'lesson',
      revealIntervalMs: 0,
      subject: 'Memoria',
      onUpdate: vi.fn(),
    });

    observer.updateStatus('Primo stato');
    observer.updateStatus('Secondo stato');
    expect(callOpenRouterMock).toHaveBeenCalledTimes(1);

    resolveFirstRequest?.(JSON.stringify({ sections: ['Primo stato'] }));
    await observer.finish();

    expect(callOpenRouterMock).toHaveBeenCalledTimes(2);
  });
});
