import { INTERNAL_FAST_TASK_INSTRUCTION } from '@shared/aiPromptInstructions';
import type { LessonScene, LessonSceneIconSlot } from '@shared/lessonScene';
import * as z from 'zod';

import type { GlobalModelConfig } from '../../config/modelConfig.js';
import { generateStructuredOutput } from '../structuredGeneration.js';
import {
  describeTablerIcon,
  embedTexts,
  loadIconIndex,
  nearestIcons,
  type TablerIcon,
} from './lessonSceneIcons.js';

/**
 * Approved icon preselection (issue #242): four queries per entry (object, action, and concept
 * phrases plus the entry text), the 12 nearest icons for each, at most 48 unique candidates; the
 * chooser sees each candidate's category and tags and may not reuse an icon for different meanings.
 */
const CANDIDATES_PER_QUERY = 12;
const MAX_CHOICE_ATTEMPTS = 3;
// Diagram entries and decorative fallbacks use a neutral glyph when no icon slot can be filled.
const FALLBACK_ICON = 'point';

export interface SceneIconQueries {
  readonly action: string;
  readonly concept: string;
  readonly object: string;
}

export interface SceneIconEntry {
  readonly queries: SceneIconQueries;
  readonly slot: LessonSceneIconSlot;
  readonly text: string;
}

interface CandidateEntry extends SceneIconEntry {
  readonly candidates: readonly TablerIcon[];
  readonly id: string;
}

const IconChoicesSchema = z.strictObject({
  // A blank concept would make every entry share one meaning and bypass distinct icons.
  choices: z.array(
    z.strictObject({ slot: z.string(), concept: z.string().trim().min(1), icon: z.string() })
  ),
});

type IconChoice = z.infer<typeof IconChoicesSchema>['choices'][number];

const { $schema: _dialect, ...ICON_CHOICE_SCHEMA } = z.toJSONSchema(IconChoicesSchema) as Record<
  string,
  unknown
>;

const ICON_POLICY = `Choose one icon for each scene entry, ONLY among that entry's candidates. The text in square brackets gives each candidate's category and tags: it states what the icon actually depicts. Discard candidates whose real meaning does not match the entry, even when the name looks close.
- Identify the subject and the action of each entry and prefer what a reader recognises visually with the least ambiguity. A relevant concrete object is often clearer than an abstract verb; a recognisable action beats an abstract concept. Never match an isolated word while ignoring the sentence.
- Then consider the whole scene: the same icon may repeat for the same meaning, but never use one icon for two entries with different meanings; prefer an equally clear alternative.
- When an entry negates or excludes something, depict the negation or absence, for example with a crossed-out "-off" variant, never the negated action.
- Prefer common symbols anyone recognises. Discard icons whose meaning requires knowing a technical name, such as specialised charts or programming terms, unless the entry is about that technical object.
- A check mark means done or correct: avoid it while the text still asks to verify. Do not use success or failure icons to hint at a quiz answer.
For each entry return {slot, concept, icon}: concept is the meaning in a few words, in the lesson language.`;

const slotId = (slot: LessonSceneIconSlot): string =>
  slot.kind === 'item' ? `items.${slot.item}` : `groups.${slot.group}.items.${slot.entry}`;

const untilAborted = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
};

const retrieveCandidates = async (
  config: GlobalModelConfig,
  entries: readonly SceneIconEntry[],
  signal: AbortSignal
): Promise<CandidateEntry[]> => {
  // The index build is shared across scenes, so a cancelled scene stops waiting without
  // cancelling the build other scenes may need.
  const index = await untilAborted(loadIconIndex(config.embeddingModel), signal);
  const queries = entries.flatMap(entry => [
    entry.queries.object,
    entry.queries.action,
    entry.queries.concept,
    entry.text,
  ]);
  const vectors = await embedTexts(config.embeddingModel, queries, signal);
  const queriesPerEntry = queries.length / Math.max(entries.length, 1);
  return entries.map((entry, entryIndex) => {
    const own = vectors.slice(entryIndex * queriesPerEntry, (entryIndex + 1) * queriesPerEntry);
    const candidates = new Map<string, TablerIcon>();
    for (const vector of own) {
      for (const icon of nearestIcons(index, vector, CANDIDATES_PER_QUERY)) {
        candidates.set(icon.name, icon);
      }
    }
    return { ...entry, candidates: [...candidates.values()], id: slotId(entry.slot) };
  });
};

const requestChoices = async (input: {
  config: GlobalModelConfig;
  entries: readonly CandidateEntry[];
  feedback: string;
  scene: LessonScene;
  signal: AbortSignal;
}): Promise<IconChoice[]> => {
  const response = await generateStructuredOutput<unknown>({
    config: input.config,
    output: { name: 'lesson_scene_icons', schema: ICON_CHOICE_SCHEMA },
    prompt: `Scene: ${JSON.stringify({ body: input.scene.body, title: input.scene.title, type: input.scene.type })}
Entries and candidates: ${JSON.stringify(
      input.entries.map(entry => ({
        candidates: entry.candidates.map(describeTablerIcon),
        slot: entry.id,
        text: entry.text,
      }))
    )}${input.feedback}`,
    signal: input.signal,
    slot: 'sceneIcon',
    system: `${ICON_POLICY}\n\n${INTERNAL_FAST_TASK_INSTRUCTION}`,
  });
  // A malformed answer chooses nothing, so every entry is reported as missing on the next attempt.
  return IconChoicesSchema.safeParse(response).data?.choices ?? [];
};

const normalizedConcept = (choice: IconChoice): string => choice.concept.trim().toLowerCase();

const reusedIcons = (choices: readonly IconChoice[]): string[] => [
  ...new Set(
    choices
      .filter(choice =>
        choices.some(
          other =>
            other !== choice &&
            other.icon === choice.icon &&
            normalizedConcept(other) !== normalizedConcept(choice)
        )
      )
      .map(choice => choice.icon)
  ),
];

/**
 * Enforces distinct icons for distinct entries after the last attempt: an icon already given to
 * an earlier entry falls back to the neutral glyph, like a missing choice.
 */
const withoutReusedIcons = (
  accepted: ReadonlyMap<string, IconChoice>,
  entries: readonly CandidateEntry[]
): Map<string, string> => {
  const conceptByIcon = new Map<string, string>();
  const distinct = new Map<string, string>();
  for (const entry of entries) {
    const choice = accepted.get(entry.id);
    if (!choice) continue;
    const owner = conceptByIcon.get(choice.icon);
    if (owner !== undefined && owner !== normalizedConcept(choice)) continue;
    conceptByIcon.set(choice.icon, normalizedConcept(choice));
    distinct.set(entry.id, choice.icon);
  }
  return distinct;
};

const applyIcons = (scene: LessonScene, icons: ReadonlyMap<string, string>): LessonScene => ({
  ...scene,
  groups: scene.groups.map((group, groupIndex) => ({
    ...group,
    icons: group.items.map(
      (_, entry) => icons.get(slotId({ entry, group: groupIndex, kind: 'group' })) ?? FALLBACK_ICON
    ),
  })),
  items: scene.items.map((item, index) => ({
    ...item,
    icon: icons.get(slotId({ item: index, kind: 'item' })) ?? FALLBACK_ICON,
  })),
});

interface IconChoiceInput {
  readonly config: GlobalModelConfig;
  readonly entries: readonly SceneIconEntry[];
  readonly scene: LessonScene;
  readonly signal: AbortSignal;
}

/**
 * Approved attempt policy (issue #242 review): each attempt scores its missing slots plus icons
 * reused for different meanings; the lowest score wins, and a tie goes to the later attempt.
 */
const chooseIconsByAttempts = async (input: IconChoiceInput): Promise<Map<string, string>> => {
  const entries = await retrieveCandidates(input.config, input.entries, input.signal);
  let feedback = '';
  let best = { accepted: new Map<string, IconChoice>(), score: Number.POSITIVE_INFINITY };
  for (let attempt = 1; attempt <= MAX_CHOICE_ATTEMPTS; attempt += 1) {
    const choices = await requestChoices({ ...input, entries, feedback });
    const valid = choices.filter(choice =>
      entries.some(
        entry =>
          entry.id === choice.slot && entry.candidates.some(icon => icon.name === choice.icon)
      )
    );
    const accepted = new Map(valid.map(choice => [choice.slot, choice]));
    const missing = entries.filter(entry => !accepted.has(entry.id));
    const reused = reusedIcons(valid);
    const score = missing.length + reused.length;
    if (score <= best.score) best = { accepted, score };
    if (score === 0) break;
    feedback = [
      missing.length
        ? `\nThe previous answer missed or used icons outside the candidates for: ${missing.map(entry => entry.id).join(', ')}.`
        : '',
      reused.length
        ? `\nThe previous answer used the same icon for different meanings (${reused.join(', ')}): choose distinct alternatives.`
        : '',
    ].join('');
  }
  return withoutReusedIcons(best.accepted, entries);
};

/**
 * Chooses an icon for every item and group entry of a scene. Icons are decorative and the scene is
 * already validated, so when retrieval or choice fails (approved fallback, issue #242 review) the
 * scene keeps the neutral icon in every slot instead of being discarded.
 */
export const chooseLessonSceneIcons = async (input: IconChoiceInput): Promise<LessonScene> => {
  if (input.entries.length === 0) return input.scene;
  try {
    return applyIcons(input.scene, await chooseIconsByAttempts(input));
  } catch (error) {
    if (input.signal.aborted) throw error;
    console.warn('[lesson-scenes] Icon choice failed; using neutral icons.', error);
    return applyIcons(input.scene, new Map());
  }
};
