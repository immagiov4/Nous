import type { ProjectSnapshot } from '../../apps/backend/src/projects/types';

export function syntheticCourse(
  kind: 'synthetic-short' | 'synthetic-law-short' = 'synthetic-short'
): ProjectSnapshot {
  const law = kind === 'synthetic-law-short';
  const markdown = law
    ? '## La validità del contratto\n\nUn contratto richiede accordo, causa, oggetto e, quando la legge la impone per la validità, una forma specifica. La nullità riguarda difetti come la mancanza di un requisito essenziale o una causa illecita: il contratto nullo è invalido fin dall’origine. Per esempio, un accordo che promette un compenso per commettere un reato ha una causa illecita.\n\nL’annullabilità protegge invece una parte in situazioni come l’incapacità legale o un consenso viziato da errore, violenza o dolo, alle condizioni previste dalla legge. Il contratto annullabile produce effetti finché viene annullato. Per esempio, una persona indotta a firmare con una minaccia può chiedere l’annullamento.\n\nPer distinguere le due figure, chiediti quale difetto colpisce il contratto e chi viene protetto. **Domanda:** perché la minaccia dell’esempio porta all’annullabilità?'
    : '## Il ciclo dell’acqua\n\nIl Sole scalda l’acqua e provoca evaporazione. Il vapore si raffredda e forma le nuvole per condensazione. Le precipitazioni riportano l’acqua al suolo.\n\n**Domanda:** quali sono le tre fasi principali?';
  const lesson = {
    content: markdown,
    contentBlocks: [{ markdown, type: 'markdown' as const }],
    description: law
      ? 'Una breve lezione introduttiva di diritto privato.'
      : 'Una breve lezione di scienze.',
    generatedVisuals: [],
    id: law ? 'lesson-contract' : 'lesson-water',
    imageRefs: [],
    isCompleted: true,
    kind: 'lesson' as const,
    learningAids: [],
    quiz: [],
    title: law ? 'La validità del contratto' : 'Il ciclo dell’acqua',
    type: 'core' as const,
  };
  const date = new Date().toISOString();
  return {
    activeSectionId: lesson.id,
    createdAt: date,
    id: crypto.randomUUID(),
    isLearnMode: false,
    lastOpenedAt: date,
    learningPlan: {
      applicationExercisePlanningStatus: 'not-run',
      modules: [
        {
          children: [lesson],
          id: law ? 'module-law' : 'module-water',
          title: law ? 'Il contratto' : 'Acqua e ambiente',
        },
      ],
      title: law ? 'Diritto privato: la validità del contratto' : 'Scienze: il ciclo dell’acqua',
    },
    source: null,
    sourceKind: 'document',
    state: 'READING',
    syllabus: [],
    updatedAt: date,
    userProfile: null,
    version: '4.1',
  };
}
