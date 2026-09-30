// Regression tests for defects found in the adversarial review of the rewrite.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openOrdersFile, tmp } from './fixtures';

const dir = tmp('e2e3-');
const tab = (page: Page, id: string) => page.getByTestId(`tab-${id}`);
const po = (page: Page, name: string) => tab(page, 'delivery').getByTestId('po-list').getByRole('button').filter({ hasText: name });

async function login(page: Page, email: string) {
  await page.getByLabel('אימייל').fill(email);
  await page.getByLabel('סיסמה').fill('demo1234');
  await page.getByRole('button', { name: 'כניסה' }).click();
}

async function signOut(page: Page, email: string) {
  await page.getByRole('button', { name: new RegExp(email.replace('.', '\\.')) }).click();
  await page.getByRole('menuitem', { name: /התנתקות/ }).click();
  await expect(page.getByRole('button', { name: 'כניסה' })).toBeVisible();
}

test.describe.serial('review regressions', () => {
  let page: Page;
  const dialogs: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.accept();
    });
    await page.goto('/');
    await login(page, 'demo@mody.co.il');
    await tab(page, 'delivery').getByTestId('open-orders-input').setInputFiles(openOrdersFile(dir));
    await expect(tab(page, 'delivery').getByTestId('po-list').getByRole('button')).toHaveCount(3);
  });

  test('a failed open-orders load never deletes saved selections', async () => {
    const d = tab(page, 'delivery');
    await po(page, 'PO202600000404').click();
    await d.getByLabel("📄 מס' תעודת משלוח:").fill('700000003');
    await d.getByLabel('בחר שורה 1').check();
    await expect(d.getByText('💾 נשמר')).toBeVisible();

    // every load fails until released (robust to React StrictMode's double mount)
    await page.evaluate(() => localStorage.setItem('mody_mock_fail_loads', '99'));
    await page.reload();
    await expect(d.getByText('טעינת ההזמנות נכשלה')).toBeVisible();
    await page.waitForTimeout(1500); // give a wrongful reconcile + save time to happen
    await expect(d.getByText('הוסרו מהבחירה')).toHaveCount(0);

    await page.evaluate(() => localStorage.setItem('mody_mock_fail_loads', '0'));
    await d.getByRole('button', { name: 'נסה שוב' }).click();
    await expect(po(page, 'PO202600000404').locator('.sel-count')).toHaveText('1');
    await expect(po(page, 'PO202600000404')).toContainText('700000003');
  });

  test('an S prefix copied from the scan name is not sent to the portal', async () => {
    const d = tab(page, 'delivery');
    await po(page, 'PO202600000404').click();
    await d.getByLabel("📄 מס' תעודת משלוח:").fill('S700000003');
    await expect(d.getByText('יישלח לפורטל כ-')).toContainText('700000003');
    await page.getByRole('button', { name: 'סיכום ויצוא ←' }).click();
    dialogs.length = 0;
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ CSV בלבד' }).click()]);
    const path = join(dir, 'a.csv');
    await download.saveAs(path);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(path, 'utf8')).toMatch(/^﻿10000080,700000003,\d\d\/\d\d\/\d\d,5000000003,,37,171,PO202600000404,1$/);
  });

  test('reusing a document number later in the same session still warns', async () => {
    const d = tab(page, 'delivery');
    await d.getByRole('button', { name: '✕ נקה הכל' }).click();
    await po(page, 'PO202600000101').click();
    await d.getByLabel("📄 מס' תעודת משלוח:").fill('700000003'); // same number as the report just made
    await d.getByLabel('בחר שורה 2').check();
    await page.getByRole('button', { name: 'סיכום ויצוא ←' }).click();
    await expect(d.locator('.alert-amber')).toContainText('תעודות שכבר דווחו בעבר: 700000003');
  });

  test('a chosen folder without PDFs is reported, not silently ignored', async () => {
    const d = tab(page, 'delivery');
    const empty = join(dir, 'empty-folder');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'readme.txt'), 'no pdfs here');
    await d.getByTestId('pdf-input-delivery').setInputFiles(empty);
    await expect(d.getByTestId('pdf-list')).toContainText('לא נמצאו קבצי PDF בתיקייה שנבחרה');
    await expect(d.getByTestId('pdf-list')).toContainText('S700000003.pdf — לא נמצא בתיקייה');
  });

  test('edits made right before sign-out are saved for their owner and never leak to the next user', async () => {
    // add a second member
    await page.getByRole('button', { name: '👥 משתמשים' }).click();
    await tab(page, 'admin').getByPlaceholder('אימייל').fill('user2@mody.co.il');
    await tab(page, 'admin').getByRole('button', { name: '+ הוסף' }).click();
    await expect(tab(page, 'admin').getByText('user2@mody.co.il')).toBeVisible();

    await page.getByRole('button', { name: '📦 תעודות משלוח' }).click();
    const d = tab(page, 'delivery');
    await po(page, 'PO202600000202').click();
    await d.getByLabel("📄 מס' תעודת משלוח:").fill('700000002');
    await d.getByLabel('בחר שורה 1').check(); // then sign out immediately, inside the save debounce
    await signOut(page, 'demo@mody.co.il');

    await login(page, 'user2@mody.co.il');
    await expect(tab(page, 'delivery').getByTestId('po-list').getByRole('button')).toHaveCount(3);
    await page.waitForTimeout(6000); // longer than the save retry interval
    await page.reload(); // a leaked write would land in user2's stored drafts
    await expect(tab(page, 'delivery').getByTestId('po-list').getByRole('button')).toHaveCount(3);
    await expect(tab(page, 'delivery').locator('.sel-count')).toHaveCount(0);
    await signOut(page, 'user2@mody.co.il');

    await login(page, 'demo@mody.co.il');
    await expect(po(page, 'PO202600000202').locator('.sel-count')).toHaveText('1');
    await expect(po(page, 'PO202600000202')).toContainText('700000002');
  });
});
