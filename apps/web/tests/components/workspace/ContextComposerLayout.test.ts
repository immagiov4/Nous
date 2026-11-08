import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { withMutedAudio } from '../../../../../scripts/browser-audio';

let browser: Browser;
let baseUrl: string;
beforeAll(async () => {
  baseUrl = inject('browserFixtureUrl');
  browser = await chromium.launch(withMutedAudio({ headless: true }));
});
afterAll(async () => {
  await browser?.close();
});

test.each([
  false,
  true,
])('selection and saved-note composer keeps context and placement on mobile=%s', async mobile => {
  const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1440, height: 900 } });
  const requests: unknown[] = [];
  try {
    await page.route('**/api/**', async route => {
      if (new URL(route.request().url()).pathname === '/api/chat/context') {
        requests.push(route.request().postDataJSON());
        const chunks = [
          { type: 'start', messageId: 'reply' },
          { type: 'start-step' },
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'Risposta sintetica alla nota.' },
          { type: 'text-end', id: 'answer' },
          { type: 'finish-step' },
          { type: 'finish' },
        ];
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
          body: `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
        });
      } else await route.fulfill({ status: 204 });
    });
    await page.goto(`${baseUrl}tests/fixtures/contextComposer.html${mobile ? '?mobile' : ''}`);
    await page.locator('[data-domain-ready="true"]').waitFor();
    await page.getByRole('button', { name: 'Seleziona il passaggio sintetico' }).click();
    const composer = page.locator('[data-context-menu-target="composer"]');
    await composer.waitFor();
    await page
      .getByRole('textbox', { name: 'Chiedi a Nous', exact: true })
      .fill('La domanda indipendente');
    await page.getByRole('button', { name: 'Nota', exact: true }).click();
    await page.getByRole('textbox').fill('Una nota **salvata**');
    await page.getByRole('button', { name: 'Allega dagli artefatti', exact: true }).click();
    await page
      .getByRole('menuitem', { name: 'Allega Schema sintetico alla nota', exact: true })
      .click();
    // Let the real reader's mobile selection/focus synchronization run after the picker unmounts.
    await page.waitForTimeout(250);
    expect(await page.getByRole('textbox').inputValue()).toBe('Una nota **salvata**');
    expect(
      await page.getByRole('textbox').evaluate(element => element === document.activeElement)
    ).toBe(true);
    await page.getByRole('button', { name: 'Apri Schema sintetico', exact: true }).click();
    await page.getByRole('dialog', { name: 'Schema sintetico', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Chiudi artefatto', exact: true }).click();
    await page.waitForTimeout(250);
    expect(await page.getByRole('textbox').inputValue()).toBe('Una nota **salvata**');
    const geometry = await composer.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const more = element.querySelector('[aria-label="Apri menu"]')?.getBoundingClientRect();
      const save = element.querySelector('[aria-label="Salva nota"]')?.getBoundingClientRect();
      if (!more || !save) throw new Error('Composer actions must exist');
      return {
        left: bounds.left,
        right: bounds.right,
        moreLeft: more.left,
        moreRight: more.right,
        gap: save.left - more.right,
      };
    });
    expect(geometry.moreLeft).toBeGreaterThanOrEqual(geometry.left);
    expect(geometry.moreRight).toBeLessThanOrEqual(geometry.right);
    expect(geometry.gap).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Chiedi a Nous', exact: true }).click();
    expect(await page.getByRole('textbox').inputValue()).toBe('La domanda indipendente');
    await page.getByRole('button', { name: 'Nota', exact: true }).click();
    await page.getByRole('button', { name: 'Salva nota', exact: true }).click();
    await page.waitForFunction(() =>
      JSON.parse(document.getElementById('annotation-state')?.textContent || '[]').some(
        (note: { note: string }) => note.note.includes('salvata')
      )
    );
    expect(await page.locator('main').textContent()).not.toContain('salvata');
    const hit = await page
      .locator('[data-nous-lesson-content-root] p')
      .first()
      .evaluate(element => {
        const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
        if (!text) throw new Error('Annotated passage must remain visible');
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 24);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
    await page.mouse.click(hit.x, hit.y);
    await page.getByRole('button', { name: 'Modifica', exact: true }).waitFor();
    expect(
      await page.getByRole('button', { name: 'Nota', exact: true }).getAttribute('aria-pressed')
    ).toBe('true');
    expect(await page.locator('.context-composer strong').textContent()).toBe('salvata');
    expect(await page.getByRole('textbox').count()).toBe(0);
    await page.getByRole('button', { name: 'Chiedi a Nous', exact: true }).click();
    await page.getByRole('textbox').fill('Usa la nota salvata');
    await page.getByRole('button', { name: 'Invia domanda', exact: true }).click();
    await page.getByText('Risposta sintetica alla nota.', { exact: true }).waitFor();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      attachedAnnotationNote: 'Una nota **salvata**',
      messages: [
        expect.objectContaining({
          role: 'user',
          parts: [expect.objectContaining({ type: 'text', text: 'Usa la nota salvata' })],
        }),
      ],
    });
  } finally {
    await page.close();
  }
});
