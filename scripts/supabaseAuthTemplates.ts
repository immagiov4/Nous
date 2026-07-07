import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type SupabaseAuthTemplateKind = 'confirmation' | 'invite' | 'magic_link' | 'recovery';

export interface SupabaseAuthTemplate {
  html: string;
  kind: SupabaseAuthTemplateKind;
  subject: string;
}

export type SupabaseAuthTemplatePatch = Partial<
  Record<
    | `mailer_subjects_${SupabaseAuthTemplateKind}`
    | `mailer_templates_${SupabaseAuthTemplateKind}_content`,
    string
  >
>;

const TEMPLATE_SUBJECTS: Record<SupabaseAuthTemplateKind, string> = {
  confirmation: 'Conferma il tuo account Nous',
  invite: 'Il tuo invito a Nous',
  magic_link: 'Accedi a Nous',
  recovery: 'Reimposta la password Nous',
};

const TEMPLATE_FILENAMES: Record<SupabaseAuthTemplateKind, string> = {
  confirmation: 'confirmation.html',
  invite: 'invite.html',
  magic_link: 'magic-link.html',
  recovery: 'recovery.html',
};

export const AUTH_TEMPLATE_KINDS: SupabaseAuthTemplateKind[] = [
  'confirmation',
  'invite',
  'magic_link',
  'recovery',
];

export const buildAuthTemplatePatch = (
  templates: SupabaseAuthTemplate[]
): SupabaseAuthTemplatePatch => {
  const patch: SupabaseAuthTemplatePatch = {};

  for (const template of [...templates].sort((left, right) =>
    left.kind.localeCompare(right.kind)
  )) {
    patch[`mailer_subjects_${template.kind}`] = template.subject;
    patch[`mailer_templates_${template.kind}_content`] = template.html;
  }

  return patch;
};

export const loadAuthTemplates = async (
  templatesDir = resolve(process.cwd(), 'supabase', 'templates')
): Promise<SupabaseAuthTemplate[]> =>
  Promise.all(
    AUTH_TEMPLATE_KINDS.map(async kind => ({
      kind,
      subject: TEMPLATE_SUBJECTS[kind],
      html: await readFile(resolve(templatesDir, TEMPLATE_FILENAMES[kind]), 'utf8'),
    }))
  );
