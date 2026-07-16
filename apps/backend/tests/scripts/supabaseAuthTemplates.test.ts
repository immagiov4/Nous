import { describe, expect, test } from 'vitest';

import {
  buildAuthTemplatePatch,
  loadAuthTemplates,
} from '../../../../scripts/supabaseAuthTemplates.ts';

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

  test('keeps each actionable email structurally branded and linked', async () => {
    const templates = await loadAuthTemplates();
    for (const kind of ['invite', 'magic_link', 'recovery'] as const) {
      const template = templates.find(candidate => candidate.kind === kind);
      expect(template, `Missing ${kind} template`).toBeDefined();
      const html = template?.html || '';
      const actionLinks = html.match(/<a\b[^>]*href="{{ \.ConfirmationURL }}"[^>]*>/g) || [];
      const images = html.match(/<img\b[^>]*>/g) || [];
      const viewportTags =
        html.match(
          /<meta\b(?=[^>]*name="viewport")(?=[^>]*content="width=device-width, initial-scale=1\.0")[^>]*>/g
        ) || [];

      expect(actionLinks).toHaveLength(1);
      expect(images).toHaveLength(1);
      expect(viewportTags).toHaveLength(1);
      expect(images[0]).toMatch(/src="https:\/\/[^\s"]+\.png"/);
      expect(images[0]).toMatch(/alt="Nous"/);
      expect(images[0]).toMatch(/width="\d+"/);
      expect(images[0]).toMatch(/height="\d+"/);
    }
  });
});
