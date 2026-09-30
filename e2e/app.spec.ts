import { expect, test, type Page } from '@playwright/test';
import { invoiceReportFile, openOrdersFile, pdfFolder, portalReportFile, readZip, tmp } from './fixtures';

const dir = tmp('e2e-');

async function login(page: Page, email = 'demo@mody.co.il') {
  await page.goto('/');
  await page.getByLabel('אימייל').fill(email);
  await page.getByLabel('סיסמה').fill('demo1234');
  await page.getByRole('button', { name: 'כניסה' }).click();
}

/** Today's stamps as the browser computes them (DD-MM-YYYY and DD/MM/YY). */
async function stamps(page: Page) {
  return page.evaluate(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return { file: `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`, csv: `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}` };
  });
}

const tab = (page: Page, id: string) => page.getByTestId(`tab-${id}`);
const poButton = (page: Page, po: string) => tab(page, 'delivery').getByTestId('po-list').getByRole('button').filter({ hasText: po });

test.describe.serial('full reporting flow', () => {
  let page: Page;
  const dialogs: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.accept();
    });
  });

  test('login and load the open-orders file', async () => {
    await login(page);
    await expect(page.getByRole('button', { name: '📦 תעודות משלוח' })).toBeVisible();
    await tab(page, 'delivery').getByTestId('open-orders-input').setInputFiles(openOrdersFile(dir));
    await expect(tab(page, 'delivery').getByText('open-orders.xlsx | 3 הזמנות פתוחות')).toBeVisible();
    await expect(tab(page, 'delivery').getByTestId('po-list').getByRole('button')).toHaveCount(3);
    // US-style dates were a bug in the original (1/6/26); orders now show 06/01/2026
    await expect(poButton(page, 'PO202600000101')).toContainText('06/01/2026');
  });

  test('search, select items and enter delivery notes', async () => {
    const d = tab(page, 'delivery');
    await d.getByLabel('חיפוש הזמנה').fill('101');
    await expect(d.getByTestId('po-list').getByRole('button')).toHaveCount(1);
    await poButton(page, 'PO202600000101').click();
    // closed line 1 is hidden; the open line keeps its original number 2
    await expect(d.locator('td.line-no')).toHaveText(['2']);
    await d.getByLabel("📄 מס' תעודת משלוח:").fill('700000001');
    await d.getByLabel('בחר שורה 2').check();

    await d.getByLabel('חיפוש הזמנה').fill('');
    await poButton(page, 'PO202600000404').click();
    await d.getByLabel('בחר שורה 1').check();
    // leaving an order with items but no document number is blocked
    dialogs.length = 0;
    await poButton(page, 'PO202600000202').click();
    await expect.poll(() => dialogs.join('')).toContain('לפני המעבר להזמנה הבאה');
    await expect(d.locator('.right-top-title')).toContainText('PO202600000404');
    await d.getByLabel('בחר שורה 1').uncheck();

    await poButton(page, 'PO202600000202').click();
    await d.getByLabel("📄 מס' תעודת משלוח:").fill('700000002');
    await d.getByLabel('בחר שורה 1').check();
    await d.getByLabel('כמות לשורה 1').fill('4.08');
    await d.getByLabel('בחר שורה 2').check();
    await d.getByLabel('בחר שורה 3').check();
    await expect(d.locator('.right-top')).toContainText('2 הזמנות | 4 פריטים');
    await expect(d.getByText('💾 נשמר')).toBeVisible();
  });

  test('summary, PDF folder and package download', async () => {
    await page.getByRole('button', { name: 'סיכום ויצוא ←' }).click();
    const d = tab(page, 'delivery');
    await expect(d.locator('.alert-green')).toContainText('2 הזמנות | 4 פריטים | סה"כ ₪932.80');
    await d.getByTestId('pdf-input-delivery').setInputFiles(pdfFolder(dir, ['S700000001.pdf', 'S700000002.pdf', 'S700000009.pdf', 'notes.txt']));
    const list = d.getByTestId('pdf-list');
    await expect(list).toContainText('3 קבצי PDF נטענו');
    await expect(list).toContainText('2 PDF מזוהים | 1 לא מזוהים');

    dialogs.length = 0;
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ הורד חבילה (CSV + PDF)' }).click()]);
    expect(dialogs).toEqual([]);
    const s = await stamps(page);
    expect(download.suggestedFilename()).toBe(`${s.file}_משלוחים.zip`);
    const zipPath = `${dir}/delivery.zip`;
    await download.saveAs(zipPath);
    const zip = readZip(zipPath);
    const folder = `${s.file}_משלוחים`;
    expect(zip.names[0]).toBe(`${folder}/${s.file}.csv`); // PDFs follow the folder listing order
    expect(zip.names.slice(1).sort()).toEqual([`${folder}/S700000001.pdf`, `${folder}/S700000002.pdf`]);
    expect(zip.files[`${folder}/${s.file}.csv`]).toBe(
      '﻿' +
        [
          `10000074,700000001,${s.csv},5000000001,,1,40,PO202600000101,2`,
          `10000074,700000002,${s.csv},5000000002,,4.08,60,PO202600000202,1`,
          `10000074,700000002,${s.csv},5000000004,,1,108,PO202600000202,2`,
          `10000074,700000002,${s.csv},5000000004,,1,540,PO202600000202,3`,
        ].join('\n'),
    );
    await expect(d.getByText('והדיווח נשמר בהיסטוריה')).toBeVisible();
  });

  test('selections survive a page reload', async () => {
    await page.reload();
    await expect(poButton(page, 'PO202600000202').locator('.sel-count')).toHaveText('3');
    await poButton(page, 'PO202600000202').click();
    await expect(tab(page, 'delivery').getByLabel('כמות לשורה 1')).toHaveValue('4.08');
  });

  test('re-exporting warns that the delivery notes were already reported', async () => {
    await page.getByRole('button', { name: 'סיכום ויצוא ←' }).click();
    await expect(tab(page, 'delivery').locator('.alert-amber')).toContainText('תעודות שכבר דווחו בעבר: 700000001');
    dialogs.length = 0;
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ CSV בלבד' }).click()]);
    expect(dialogs.join('\n')).toContain('תעודות שכבר דווחו בעבר');
    expect(download.suggestedFilename()).toMatch(/^\d\d-\d\d-\d{4}\.csv$/);
  });

  test('history lists the exports', async () => {
    await page.getByRole('button', { name: '📋 היסטוריה' }).click();
    const h = tab(page, 'history');
    const rows = h.getByTestId('history-table').locator('tbody > tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('700000001, 700000002');
    await rows.first().getByRole('button', { name: '▸ פרטים' }).click();
    await expect(h.locator('.detail-cell')).toContainText('חיפוי חדרים רטובים');
  });

  test('invoice matching uses order-line numbers from the delivery history', async () => {
    await page.getByRole('button', { name: '⚖ התאמת חשבוניות' }).click();
    const m = tab(page, 'match');
    await m.getByTestId('portal-input').setInputFiles(portalReportFile(dir));
    await m.getByTestId('invoice-report-input').setInputFiles(invoiceReportFile(dir));
    await expect(m.getByTestId('cnt-ok')).toHaveText('2');
    await expect(m.getByTestId('cnt-diff')).toHaveText('0');
    await expect(m.getByTestId('cnt-missing')).toHaveText('1');
    await m.getByRole('button', { name: /300000001/ }).click();
    await expect(m.locator('.detail-cell')).toContainText('היסטוריה');
    await expect(m.getByTestId('export-summary')).toContainText('ייכללו בקובץ ה-CSV: 2 חשבוניות תקינות בלבד.');

    dialogs.length = 0;
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ CSV בלבד' }).click()]);
    expect(dialogs).toEqual([]);
    const csvPath = `${dir}/invoices.csv`;
    await download.saveAs(csvPath);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(csvPath, 'utf8')).toBe(
      '﻿' +
        [
          '10000074,300000001,,D,01/09/26,5000000004,,1,108,700000002,PO202600000202,2',
          '10000074,300000001,,D,01/09/26,5000000004,,1,540,700000002,PO202600000202,3',
          '10000074,300000001,,D,01/09/26,5000000002,,4.08,60,700000002,,',
          '10000074,300000002,,D,01/09/26,5000000001,,1,40,700000001,,',
        ].join('\n'),
    );
    await expect(m.getByRole('button', { name: /300000001/ }).locator('..')).toContainText('יוצאה בעבר');
  });

  test('admin can add members; strangers get no access', async () => {
    await page.getByRole('button', { name: '👥 משתמשים' }).click();
    const a = tab(page, 'admin');
    await a.getByPlaceholder('אימייל').fill('User2@Mody.co.il');
    await page.getByRole('button', { name: '+ הוסף' }).click();
    await expect(a.getByText('user2@mody.co.il')).toBeVisible();
    dialogs.length = 0;
    await a.getByLabel('הרשאה עבור demo@mody.co.il').selectOption('user');
    await expect.poll(() => dialogs.join('')).toContain('לא ניתן להסיר את המנהל האחרון');

    await page.getByRole('button', { name: /demo@mody.co.il/ }).click();
    await page.getByRole('menuitem', { name: /התנתקות/ }).click();
    await login(page, 'stranger@example.com');
    await expect(page.getByText('אין הרשאת גישה')).toBeVisible();
  });
});
