// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { HeaderLearningAids } from '../../../../components/workspace/shell/LessonLearningAids.tsx';
import type { LessonLearningAid } from '../../../../types.ts';

const EXISTING_AID: LessonLearningAid = {
  id: 'learning-aid-vlan',
  kind: 'definition',
  title: 'VLAN',
  content: 'Una rete locale separata logicamente.',
};

function LearningAidsHarness({
  initialAids = [],
  onPersist,
}: {
  initialAids?: LessonLearningAid[];
  onPersist: (learningAids: LessonLearningAid[]) => Promise<boolean>;
}) {
  const [learningAids, setLearningAids] = useState(initialAids);

  return (
    <HeaderLearningAids
      isDarkMode={false}
      learningAids={learningAids}
      onSaveLearningAids={async nextLearningAids => {
        const didPersist = await onPersist(nextLearningAids);
        if (didPersist) {
          setLearningAids(nextLearningAids);
        }
        return didPersist;
      }}
    />
  );
}

describe('LessonLearningAids editing', () => {
  test('opens a new key concept editor below the existing list', async () => {
    const user = userEvent.setup();
    render(
      <LearningAidsHarness initialAids={[EXISTING_AID]} onPersist={vi.fn(async () => true)} />
    );

    await user.click(screen.getByRole('button', { name: 'Apri concetti chiave' }));
    await user.click(screen.getByRole('button', { name: 'Aggiungi concetto chiave' }));

    const list = screen.getByRole('list');
    const editor = screen.getByRole('group', { name: 'Nuovo concetto chiave' });

    expect(list.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  test('creates and then edits a key concept through explicit saves', async () => {
    const user = userEvent.setup();
    const onPersist = vi.fn(async () => true);
    render(<LearningAidsHarness onPersist={onPersist} />);

    await user.click(screen.getByRole('button', { name: 'Apri concetti chiave' }));
    await user.click(screen.getByRole('button', { name: 'Aggiungi concetto chiave' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Tipo concetto chiave' }),
      'analogy'
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Titolo' }), {
      target: { value: 'Ponte logico' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Contenuto' }), {
      target: {
        value: 'Collega due idee mostrando il passaggio che le rende compatibili.',
      },
    });
    await user.click(screen.getByRole('button', { name: 'Salva' }));

    expect(
      await screen.findByRole('button', { name: 'Comprimi Ponte logico' })
    ).toBeInTheDocument();
    expect(onPersist).toHaveBeenLastCalledWith([
      expect.objectContaining({
        kind: 'analogy',
        title: 'Ponte logico',
        content: 'Collega due idee mostrando il passaggio che le rende compatibili.',
      }),
    ]);

    await user.click(screen.getByRole('button', { name: 'Modifica Ponte logico' }));
    const titleInput = screen.getByRole('textbox', { name: 'Titolo' });
    fireEvent.change(titleInput, { target: { value: 'Passaggio logico' } });
    await user.click(screen.getByRole('button', { name: 'Salva' }));

    expect(
      await screen.findByRole('button', { name: 'Comprimi Passaggio logico' })
    ).toBeInTheDocument();
    expect(onPersist).toHaveBeenCalledTimes(2);
  });

  test('cancels an edit without changing the saved concept and can remove it', async () => {
    const user = userEvent.setup();
    const onPersist = vi.fn(async () => true);
    render(<LearningAidsHarness initialAids={[EXISTING_AID]} onPersist={onPersist} />);

    await user.click(screen.getByRole('button', { name: 'Apri concetti chiave' }));
    await user.click(screen.getByRole('button', { name: 'Modifica VLAN' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Titolo' }), {
      target: { value: 'Titolo non salvato' },
    });
    await user.click(screen.getByRole('button', { name: 'Annulla' }));

    expect(screen.getByRole('button', { name: 'Espandi VLAN' })).toBeInTheDocument();
    expect(screen.queryByText('Titolo non salvato')).not.toBeInTheDocument();
    expect(onPersist).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Rimuovi VLAN' }));
    await waitFor(() => expect(onPersist).toHaveBeenCalledWith([]));
    expect(screen.queryByRole('button', { name: 'Espandi VLAN' })).not.toBeInTheDocument();
  });

  test('keeps the previous concept visible when persistence fails', async () => {
    const user = userEvent.setup();
    const onPersist = vi.fn(async () => false);
    render(<LearningAidsHarness initialAids={[EXISTING_AID]} onPersist={onPersist} />);

    await user.click(screen.getByRole('button', { name: 'Apri concetti chiave' }));
    await user.click(screen.getByRole('button', { name: 'Rimuovi VLAN' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Non sono riuscito a salvare i concetti chiave. Riprova.'
    );
    expect(screen.getByRole('button', { name: 'Espandi VLAN' })).toBeInTheDocument();
  });
});
