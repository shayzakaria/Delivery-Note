import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { openOrdersFile, pdfFolder, readZip, tmp } from './fixtures';

const dir = tmp('e2e2-');
const tab = (page: Page, id: string) => page.getByTestId(`tab-${id}`);

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('אימייל').fill('demo@mody.co.il');
  await page.getByLabel('סיסמה').fill('demo1234');
  await page.getByRole('button', { name: 'כניסה' }).click();
  await expect(page.getByRole('button', { name: '📦 תעודות משלוח' })).toBeVisible();
}

/** Same orders, but line 2 of PO…0202 is now fully delivered. */
function updatedOpenOrders(): string {
  const r = (po: string, sku: number, item: string, balance: number, price: number) => {
    const row: unknown[] = new Array(18).fill(null);
    Object.assign(row, { 0: 10000074, 1: 'אתר צפון', 3: new Date(2026, 0, 6), 4: po, 5: 'דירה 147', 6: 'קניין א', 9: sku, 11: item, 12: balance, 13: balance, 15: price });
    return row;
  };
  const ws = XLSX.utils.aoa_to_sheet([
    ['אתר'],
    r('PO202600000202', 5000000002, 'חיפוי חדרים רטובים', 10, 60),
    r('PO202600000202', 5000000004, 'כיור', 0, 108),
    r('PO202600000202', 5000000004, 'כיור שדרוג', 1, 540),
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const path = join(dir, 'open-orders-v2.xlsx');
  writeFileSync(path, new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer));
  return path;
}

test.describe.serial('manual invoices and re-import', () => {
  let page: Page;
  const dialogs: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.accept();
    });
    await login(page);
    await tab(page, 'delivery').getByTestId('open-orders-input').setInputFiles(openOrdersFile(dir));
    await expect(tab(page, 'delivery').getByTestId('po-list').getByRole('button')).toHaveCount(3);
  });

  test('manual invoice tab exports the 9-column file with i-prefixed PDFs', async () => {
    await page.getByRole('button', { name: '🧾 חשבוניות' }).click();
    const inv = tab(page, 'invoice');
    await inv.getByTestId('po-list').getByRole('button').filter({ hasText: 'PO202600000404' }).click();
    await inv.getByLabel('🧾 מס׳ חשבונית:').fill('300000001');
    await inv.getByLabel('בחר שורה 1').check();
    await inv.getByLabel('כמות לשורה 1').fill('10');
    await page.getByRole('button', { name: 'סיכום ויצוא ←' }).click();
    await expect(inv.locator('.alert-green')).toContainText('1 הזמנות | 1 פריטים | סה"כ ₪1,710.00');
    await inv.getByTestId('pdf-input-invoice_manual').setInputFiles(pdfFolder(dir, ['i300000001.pdf', 'S300000001.pdf']));
    // a delivery-note scan with the same number is not taken as the invoice PDF
    await expect(inv.getByTestId('pdf-list')).toContainText('1 PDF מזוהים | 1 לא מזוהים');

    dialogs.length = 0;
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ הורד חבילה (CSV + PDF)' }).click()]);
    expect(dialogs).toEqual([]);
    const name = download.suggestedFilename();
    expect(name).toMatch(/^\d\d-\d\d-\d{4}_חשבוניות\.zip$/);
    const path = join(dir, 'inv.zip');
    await download.saveAs(path);
    const zip = readZip(path);
    const folder = name.replace(/\.zip$/, '');
    const stamp = folder.replace('_חשבוניות', '');
    expect(zip.names).toEqual([`${folder}/${stamp}.csv`, `${folder}/i300000001.pdf`]);
    expect(zip.files[`${folder}/${stamp}.csv`]).toMatch(/^﻿10000080,300000001,\d\d\/\d\d\/\d\d,5000000003,,10,171,PO202600000404,1$/);
  });

  test('a newer open-orders file drops selections that are no longer open', async () => {
    await page.getByRole('button', { name: '📦 תעודות משלוח' }).click();
    const d = tab(page, 'delivery');
    await d.getByTestId('po-list').getByRole('button').filter({ hasText: 'PO202600000202' }).click();
    await d.getByLabel("📄 מס' תעודת משלוח:").fill('700000002');
    await d.getByLabel('בחר שורה 1').check();
    await d.getByLabel('בחר שורה 2').check();
    await expect(d.getByTestId('po-list').getByRole('button').filter({ hasText: 'PO202600000202' }).locator('.sel-count')).toHaveText('2');

    dialogs.length = 0;
    await d.getByTestId('open-orders-input').setInputFiles(updatedOpenOrders());
    await expect.poll(() => dialogs.join('')).toContain('תחליף את רשימת ההזמנות הפתוחות');
    await expect(d.getByText('open-orders-v2.xlsx | 1 הזמנות פתוחות')).toBeVisible();
    await expect(d.locator('.alert-amber')).toContainText('1 פריטים שסומנו בעבר הוסרו מהבחירה');
    const po = d.getByTestId('po-list').getByRole('button').filter({ hasText: 'PO202600000202' });
    await expect(po.locator('.sel-count')).toHaveText('1');
    await expect(po).toContainText('700000002');
  });
});
