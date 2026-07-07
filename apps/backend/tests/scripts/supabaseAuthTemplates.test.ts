import { describe, expect, test } from 'vitest';

import { buildAuthTemplatePatch } from '../../../../scripts/supabaseAuthTemplates.ts';

describe('Supabase auth template sync helpers', () => {
  test('builds Management API patch keys from local templates', () => {
    const patch = buildAuthTemplatePatch([
      {
        kind: 'magic_link',
        subject: 'Accedi a Nous',
        html: '<p>{{ .ConfirmationURL }}</p>',
      },
      {
        kind: 'invite',
        subject: 'Invito a Nous',
        html: '<p>{{ .SiteURL }}</p>',
      },
    ]);

    expect(patch).toEqual({
      mailer_subjects_invite: 'Invito a Nous',
      mailer_subjects_magic_link: 'Accedi a Nous',
      mailer_templates_invite_content: '<p>{{ .SiteURL }}</p>',
      mailer_templates_magic_link_content: '<p>{{ .ConfirmationURL }}</p>',
    });
  });
});
