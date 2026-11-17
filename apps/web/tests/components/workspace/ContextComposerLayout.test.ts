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
    await page.waitForFunction(
      () => document.activeElement?.matches('[data-context-menu-target="input"]') === true
    );
    expect(await page.getByRole('textbox').inputValue()).toBe('Una nota **salvata**');
    expect(
      await page.getByRole('textbox').evaluate(element => element === document.activeElement)
    ).toBe(true);
    await page.getByRole('button', { name: 'Apri Schema sintetico', exact: true }).click();
    await page.getByRole('dialog', { name: 'Schema sintetico', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Chiudi artefatto', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Schema sintetico', exact: true })
      .waitFor({ state: 'detached' });
    await page.waitForFunction(
      () => document.activeElement?.matches('[data-context-menu-target="input"]') === true
    );
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

test.each([
  false,
  true,
])('many note attachments keep the editor and footer reachable on mobile=%s', async mobile => {
  const page = await browser.newPage({
    viewport: { width: mobile ? 390 : 1440, height: mobile ? 420 : 900 },
    reducedMotion: 'reduce',
  });
  try {
    await page.goto(
      `${baseUrl}tests/fixtures/contextComposer.html?rich&many${mobile ? '&mobile' : ''}`
    );
    await page.locator('[data-domain-ready="true"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const hit = await page
      .locator('[data-nous-lesson-content-root] p')
      .first()
      .evaluate(element => {
        const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
        if (!node?.textContent) throw new Error('Expected highlighted passage');
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 24);
        const bounds = range.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      });
    await page.mouse.click(hit.x, hit.y);
    await page.getByRole('button', { name: 'Modifica', exact: true }).click();
    const geometry = await page.locator('.context-composer').evaluate(element => {
      const content = element.querySelector('.context-composer-content');
      const footer = element.querySelector('footer');
      const editor = element.querySelector('textarea');
      if (!content || !footer || !editor) throw new Error('Expected composer regions');
      return {
        footer: footer.getBoundingClientRect().bottom,
        editorHeight: editor.getBoundingClientRect().height,
        contentHeight: content.clientHeight,
        scrollHeight: content.scrollHeight,
        viewport: innerHeight,
      };
    });
    expect(geometry.footer).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.editorHeight).toBeGreaterThan(0);
    expect(geometry.scrollHeight).toBeGreaterThanOrEqual(geometry.contentHeight);
    const last = page.getByRole('button', { name: 'Apri Schema 12', exact: true });
    await last.scrollIntoViewIfNeeded();
    expect(await last.isVisible()).toBe(true);
    const draft = page.getByRole('textbox');
    await draft.fill('Bozza da scartare');
    if (mobile) {
      await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
      const cancel = page.getByRole('menuitem', { name: 'Annulla', exact: true });
      await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem');
      await page.keyboard.press('Tab');
      expect(await cancel.evaluate(element => element === document.activeElement)).toBe(true);
      await page.keyboard.press('Enter');
    } else await page.getByRole('button', { name: 'Annulla', exact: true }).click();
    await page.getByRole('button', { name: 'Modifica', exact: true }).waitFor();
    expect(await page.getByRole('textbox').count()).toBe(0);
    expect(
      await page.locator('[data-context-menu-target="note-preview"] strong').textContent()
    ).toBe('collegamento concreto');
    expect(await page.locator('#annotation-state').textContent()).not.toContain(
      'Bozza da scartare'
    );
  } finally {
    await page.close();
  }
});

test('annotation attach and detach survive cancelling only the note text draft', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  try {
    await page.goto(`${baseUrl}tests/fixtures/contextComposer.html?rich&mobile`);
    await page.locator('[data-domain-ready="true"]').waitFor();
    const hit = await page
      .locator('[data-nous-lesson-content-root] p')
      .first()
      .evaluate(element => {
        const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
        if (!node?.textContent) throw new Error('Expected highlighted passage');
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 24);
        const bounds = range.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      });
    await page.mouse.click(hit.x, hit.y);
    for (const operation of ['attach', 'detach'] as const) {
      await page.getByRole('button', { name: 'Modifica', exact: true }).click();
      await page.getByRole('textbox').fill('Bozza da annullare');
      if (operation === 'attach') {
        await page.getByRole('button', { name: 'Allega dagli artefatti', exact: true }).click();
        await page
          .getByRole('menuitem', { name: 'Allega Schema sintetico alla nota', exact: true })
          .click();
      } else
        await page
          .getByRole('button', { name: 'Rimuovi Schema sintetico dalla nota', exact: true })
          .click();
      await page.waitForFunction(
        attached =>
          document
            .getElementById('annotation-state')
            ?.textContent?.includes('visual-draft-scene') === attached,
        operation === 'attach'
      );
      const committed = await page.locator('#annotation-state').textContent();
      await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Annulla', exact: true }).click();
      await page.getByRole('button', { name: 'Modifica', exact: true }).waitFor();
      expect(
        await page.getByRole('button', { name: 'Apri Schema sintetico', exact: true }).count()
      ).toBe(operation === 'attach' ? 1 : 0);
      expect(await page.locator('#annotation-state').textContent()).toBe(committed);
      expect(
        await page.locator('[data-context-menu-target="note-preview"] strong').textContent()
      ).toBe('collegamento concreto');
    }
  } finally {
    await page.close();
  }
});
