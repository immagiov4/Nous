// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import DiagnosticFlow from '../../../components/library/diagnostic/DiagnosticFlow.tsx';
import { createDiagnosticDemoAdapter } from '../../../components/library/diagnostic/diagnosticDemoAdapter.ts';
import type {
  DiagnosticAdapter,
  DiagnosticStage,
  DiagnosticSubmission,
} from '../../../components/library/diagnostic/diagnosticFlow.ts';
import { DiagnosticStoppedError } from '../../../components/library/diagnostic/diagnosticFlow.ts';

const round: DiagnosticStage = {
  kind: 'round',
  id: 'r1',
  title: 'Due problemi',
  questions: [
    { id: 'a', topic: 'Equivalenza', prompt: 'Risolvi mostrando i passaggi.', format: 'text' },
    {
      id: 'b',
      topic: 'Equivalenza',
      prompt: 'Quale trasformazione conserva la soluzione?',
      format: 'choice',
      options: [
        { id: 'same', text: 'Sottrarre due da entrambi i membri.' },
        { id: 'one', text: 'Sottrarre due solo a sinistra.' },
      ],
    },
  ],
};
const complete: DiagnosticStage = {
  kind: 'complete',
  id: 'done',
  title: 'Da dove partire',
  feedback: 'Riprendiamo le trasformazioni equivalenti.',
};

let resizeDescription: () => void = () => undefined;
// Layout measurements are supplied explicitly for the scroll anchoring assertion.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeDescription = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
  Object.defineProperty(document, 'scrollingElement', {
    configurable: true,
    value: document.documentElement,
  });
  Object.defineProperty(document.documentElement, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'scrollingElement');
  Reflect.deleteProperty(document.documentElement, 'scrollTo');
});

describe('diagnostic collection interface', () => {
  test('retains answers and stops offering submission retries after terminal failure', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockRejectedValue(new DiagnosticStoppedError());
    render(
      <DiagnosticFlow
        adapter={{
          collectionId: 'stopped',
          initial: {
            kind: 'round',
            id: 'round',
            title: 'Ragioniamo',
            questions: [{ id: 'q', topic: 'Tema', prompt: 'Spiega.', format: 'text' }],
          },
          submit,
        }}
      />
    );
    await user.type(screen.getByRole('textbox'), 'Risposta raccolta');
    await user.click(screen.getByRole('button', { name: 'Invia le risposte' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('textbox')).toHaveValue('Risposta raccolta');
    expect(screen.getByRole('button', { name: 'Invia le risposte' })).toBeDisabled();
    expect(submit).toHaveBeenCalledTimes(1);
  });
  test('keeps the uncertain stop after release and the trailing native range change', () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    render(<DiagnosticFlow adapter={createDiagnosticDemoAdapter()} />);
    const slider = screen.getByRole('slider', { name: 'Marketing' });
    const uncertain = screen.getByRole('button', { name: 'Non so valutarmi' });
    Object.defineProperty(slider, 'setPointerCapture', { value: vi.fn() });
    const bounds = vi.spyOn(uncertain, 'getBoundingClientRect');
    bounds.mockReturnValue({ left: 300, top: 100, bottom: 148 } as DOMRect);
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '3' } });
    fireEvent.pointerMove(slider, { clientX: 320, clientY: 120 });
    expect(slider).toHaveAttribute('aria-valuetext', 'Non so valutarmi');
    bounds.mockReturnValue({ left: 300, top: 40, bottom: 88 } as DOMRect);
    fireEvent.pointerMove(slider, { clientX: 320, clientY: 120 });
    fireEvent.pointerUp(slider, { clientX: 320, clientY: 120 });
    fireEvent.change(slider, { target: { value: '3' } });
    expect(uncertain).toHaveAttribute('aria-pressed', 'true');
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '2' } });
    fireEvent.pointerUp(slider);
    expect(slider).toHaveAttribute('aria-valuetext', 'Ne conosco le basi');
  });
  test('selects the first stop from empty or uncertain without a native change event', async () => {
    const user = userEvent.setup();
    const initial: DiagnosticStage = {
      kind: 'self-assessment',
      id: 'tree',
      title: 'Argomenti',
      topics: [{ id: 'a', title: 'Equazioni', children: [] }],
    };
    render(<DiagnosticFlow adapter={{ collectionId: 'c', initial, submit: vi.fn() }} />);
    const slider = screen.getByRole('slider', { name: 'Equazioni' });
    expect(slider).toHaveAttribute('aria-valuetext', 'Nessuna risposta');
    fireEvent.pointerUp(slider);
    expect(slider).toHaveAttribute('aria-valuetext', 'Non lo conosco');
    await user.click(screen.getByRole('button', { name: 'Non so valutarmi' }));
    expect(slider).toHaveAttribute('aria-valuetext', 'Non so valutarmi');
    fireEvent.pointerUp(slider);
    expect(slider).toHaveAttribute('aria-valuetext', 'Non lo conosco');
    await user.click(screen.getByRole('button', { name: 'Non so valutarmi' }));
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider).toHaveAttribute('aria-valuetext', 'Non lo conosco');
  });
  test('keeps drafts across navigation, submits missing answers, discloses feedback only on acceptance', async () => {
    const user = userEvent.setup();
    let accept: (next: DiagnosticStage) => void = () => undefined;
    const submit = vi.fn(
      () =>
        new Promise<DiagnosticStage>(resolve => {
          accept = resolve;
        })
    );
    render(<DiagnosticFlow adapter={{ collectionId: 'c1', initial: round, submit }} />);
    await user.type(screen.getByRole('textbox'), 'x = 4{Enter}Verifico la soluzione.');
    await user.click(screen.getByRole('button', { name: 'Successiva' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Precedente' }));
    expect(screen.getByRole('textbox')).toHaveValue('x = 4\nVerifico la soluzione.');
    await user.click(screen.getByRole('button', { name: 'Successiva' }));
    await user.click(screen.getByRole('button', { name: 'Invia le risposte' }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]).toEqual([
      expect.objectContaining({
        stageId: 'r1',
        answers: [
          { itemId: 'a', response: { kind: 'text', text: 'x = 4\nVerifico la soluzione.' } },
          { itemId: 'b', response: { kind: 'not-submitted' } },
        ],
      }),
    ]);
    expect(screen.getByRole('button', { name: 'Invia le risposte' })).toBeDisabled();
    expect(screen.queryByText(complete.feedback)).not.toBeInTheDocument();
    accept(complete);
    await screen.findByText(complete.feedback);
  });

  test('retries the same immutable request after failure and allows editing with a new request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    const submit = vi
      .fn<DiagnosticAdapter['submit']>()
      .mockRejectedValue(new Error('private detail'));
    render(<DiagnosticFlow adapter={{ collectionId: 'c1', initial: round, submit }} />);
    await user.type(screen.getByRole('textbox'), 'Prima risposta');
    await user.click(screen.getByRole('button', { name: 'Successiva' }));
    await user.click(screen.getByRole('button', { name: 'Invia le risposte' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private detail');
    await user.click(screen.getByRole('button', { name: 'Invia le risposte' }));
    expect(submit.mock.calls[0][0]).toBe(submit.mock.calls[1][0]);
    await user.click(screen.getByRole('button', { name: 'Precedente' }));
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('textbox')).toHaveValue('Prima risposta');
    await user.click(screen.getByRole('button', { name: 'Successiva' }));
    await user.click(screen.getByRole('button', { name: 'Invia le risposte' }));
    expect(submit.mock.calls[2][0]).toBe(submit.mock.calls[0][0]);
    expect(submit.mock.calls[0][0].answers[0].response).toEqual({
      kind: 'text',
      text: 'Prima risposta',
    });
  });

  test('collects the tree and successive rounds with separate identities and no inherited answers', async () => {
    const user = userEvent.setup();
    const fixture = createDiagnosticDemoAdapter();
    const submissions: DiagnosticSubmission[] = [];
    const adapter: DiagnosticAdapter = {
      ...fixture,
      async submit(value) {
        submissions.push(value);
        return fixture.submit(value);
      },
    };
    render(<DiagnosticFlow adapter={adapter} />);
    fireEvent.change(screen.getByRole('slider', { name: 'Marketing' }), { target: { value: '1' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Pubblico' }), { target: { value: '1' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Bisogni' }), { target: { value: '2' } });
    await user.click(screen.getByRole('button', { name: /^Pubblico/ }));
    await user.click(screen.getByRole('button', { name: /^Pubblico/ }));
    expect(screen.getByRole('slider', { name: 'Bisogni' })).toHaveAttribute(
      'aria-valuetext',
      'Ne conosco le basi'
    );
    await user.click(screen.getByRole('button', { name: 'Continua' }));
    await screen.findByRole('textbox');
    await user.type(screen.getByRole('textbox'), 'Parlo con i lettori del quartiere.');
    await user.click(screen.getByRole('button', { name: 'Successiva' }));
    await user.click(screen.getByRole('button', { name: 'Invia le risposte' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
    expect(screen.queryByText('Da dove partire')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Invia le risposte' }));
    await screen.findByText('Da dove partire');
    expect(submissions.map(value => value.stageId)).toEqual(['topics', 'round-a', 'round-b']);
    expect(submissions[0].answers.find(answer => answer.itemId === 'needs')?.response).toEqual({
      kind: 'self-report',
      value: 'basics',
    });
    expect(
      submissions[0].answers.find(answer => answer.itemId === 'positioning')?.response
    ).toEqual({
      kind: 'not-submitted',
    });
  });

  test('reveals children progressively, keeps completed branches open and shows only the active description', async () => {
    const user = userEvent.setup();
    render(<DiagnosticFlow adapter={createDiagnosticDemoAdapter()} />);
    expect(screen.getAllByRole('slider')).toHaveLength(1);
    fireEvent.change(screen.getByRole('slider', { name: 'Marketing' }), { target: { value: '2' } });
    expect(screen.getByRole('slider', { name: 'Pubblico' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Posizionamento' })).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Bisogni' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('slider', { name: 'Pubblico' }), { target: { value: '2' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Bisogni' }), { target: { value: '1' } });
    fireEvent.pointerUp(screen.getByRole('slider', { name: 'Bisogni' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Segmentazione' }), {
      target: { value: '2' },
    });
    expect(screen.getByRole('slider', { name: 'Segmentazione' })).toBeInTheDocument();
    fireEvent.pointerUp(screen.getByRole('slider', { name: 'Segmentazione' }));
    const completedBranch = screen.getByRole('button', { name: /^Pubblico/ });
    expect(completedBranch).toHaveAccessibleName(/Completato/);
    expect(completedBranch).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('slider', { name: 'Bisogni' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Posizionamento' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Pubblico/ }));
    await user.click(screen.getByRole('button', { name: /^Pubblico/ }));
    expect(screen.getByRole('slider', { name: 'Bisogni' })).toHaveAttribute(
      'aria-valuetext',
      'Ne ho sentito parlare'
    );
    fireEvent.change(screen.getByRole('slider', { name: 'Segmentazione' }), {
      target: { value: '3' },
    });
    fireEvent.pointerUp(screen.getByRole('slider', { name: 'Segmentazione' }));
    expect(screen.getByRole('slider', { name: 'Segmentazione' })).toHaveAttribute(
      'aria-valuetext',
      'Mi sento autonomo'
    );
    const needs = screen.getByRole('slider', { name: 'Bisogni' });
    const segments = screen.getByRole('slider', { name: 'Segmentazione' });
    fireEvent.focus(needs);
    expect(needs.closest('fieldset')?.querySelector('.diagnostic-selection')).toHaveAttribute(
      'aria-hidden',
      'false'
    );
    const control = segments.closest('fieldset');
    if (!control) throw new Error('Expected slider fieldset');
    const bounds = vi.spyOn(control, 'getBoundingClientRect');
    bounds.mockReturnValue({ top: 300 } as DOMRect);
    fireEvent.focus(segments);
    expect(needs.closest('fieldset')?.querySelector('.diagnostic-selection')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
    expect(control.querySelector('.diagnostic-selection')).toHaveAttribute('aria-hidden', 'false');
    document.documentElement.scrollTop = 100;
    bounds.mockReturnValue({ top: 280 } as DOMRect);
    act(() => resizeDescription());
    expect(document.documentElement.scrollTo).toHaveBeenLastCalledWith({
      top: 80,
      behavior: 'instant',
    });
    const description = control.querySelector('.diagnostic-selection');
    if (!description) throw new Error('Expected selection description');
    vi.spyOn(description, 'getBoundingClientRect').mockReturnValue({ height: 40 } as DOMRect);
    act(() => resizeDescription());
    expect(document.documentElement.scrollTo).toHaveBeenLastCalledWith({
      top: 120,
      behavior: 'instant',
    });
    fireEvent.focus(needs);
    expect(needs.closest('fieldset')?.querySelector('.diagnostic-selection')).toHaveAttribute(
      'aria-hidden',
      'false'
    );
  });
});
