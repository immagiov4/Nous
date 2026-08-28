import {
  type CourseInterviewMessage,
  CourseInterviewMessageSchema,
  CourseInterviewProposalSchema,
} from '@shared/courseInterviewContract.js';
import * as z from 'zod';

import type { GlobalModelConfig } from '../config/modelConfig.js';
import { type GenerateCourseObjectInput, generateCourseObject } from './courseGenerationModel.js';
import type { DeepReadonly } from './types.js';

export const CourseInterviewTurnSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('question'),
    message: z.string().min(1),
  }),
  z.object({
    kind: z.literal('proposal'),
    message: z.string().min(1),
    proposal: CourseInterviewProposalSchema,
  }),
  z.object({
    kind: z.literal('cancelled'),
    message: z.string().min(1),
  }),
]);

export type CourseInterviewTurn = z.infer<typeof CourseInterviewTurnSchema>;

export interface CourseInterviewModelInput {
  readonly config: DeepReadonly<GlobalModelConfig>;
  readonly hasReliableSourceContext: boolean;
  readonly messages: readonly CourseInterviewMessage[];
  readonly mode: 'document' | 'learn';
  readonly signal: AbortSignal;
  readonly sourceContext?: string;
}

type GenerateObject = <Schema extends z.ZodType>(
  input: GenerateCourseObjectInput<Schema>
) => Promise<z.output<Schema>>;

const DEVELOPER_INSTRUCTIONS = `You are the Nous Reader interviewer. Collect only the high-impact information needed to personalize a course.

Rules:
- Ask one short, concrete question at a time.
- Focus on level, goal, gaps, familiarity with the material, and preferred progression.
- About three useful answers are normally enough. Ask more only when high-impact information is missing.
- Do not explain the topic, write lessons, or generate the course.
- Avoid questions about scheduling and organization unless the user states a decisive constraint.
- When the information is sufficient, return a concise proposal instead of another question.
- The proposal must preserve the topic, level, style, goals, detailed context, and language.
- If the user clearly says they want to exit or opened the flow by mistake, return cancelled. Decide from the meaning of the whole conversation, never from isolated words.
- If the source context is not reliable, do not pretend to know its content.
- Write in Italian.`;

const buildPrompt = (input: CourseInterviewModelInput): string => {
  const sourceContext = input.sourceContext ?? '(no source context available)';
  const messages = input.messages.map(message => CourseInterviewMessageSchema.parse(message));
  return `Course mode: ${input.mode}
Reliable source context: ${input.hasReliableSourceContext ? 'yes' : 'no'}

SOURCE CONTEXT:
${sourceContext}

CONVERSATION (JSON):
${JSON.stringify(messages)}

Decide whether to ask one new question or prepare the course proposal.`;
};

export const createCourseInterviewModel = (
  dependencies: { readonly generateObject?: GenerateObject } = {}
) => ({
  assessTurn: async (input: CourseInterviewModelInput): Promise<CourseInterviewTurn> =>
    (dependencies.generateObject ?? generateCourseObject)({
      config: input.config,
      developerInstructions: DEVELOPER_INSTRUCTIONS,
      name: 'course_interview_turn',
      prompt: buildPrompt(input),
      schema: CourseInterviewTurnSchema,
      signal: input.signal,
      slot: 'assessment',
    }),
});
