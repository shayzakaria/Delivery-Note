// The admin analytics screen: what admins see, and that regular users never load it.
import { expect, test, type Page } from '@playwright/test';
import { openOrdersFile, tmp } from './fixtures';

const dir = tmp('e2e-an-');
const tab = (page: Page, id: string) => page.getByTestId(`tab-${id}`);
const po = (page: Page, name: string) => tab(page, 'delivery').getByTestId('po-list').getByRole('button').filter({ hasText: name });

async function login(page: Page, email: string) {
  await page.getByLabel('אימייל').fill(email);
  await page.getByLabel('סיסמה').fill('demo1234');
  await page.getByRole('button', { name: 'כניסה' }).click();
}

async function exportOne(page: Page, poName: string, doc: string, line: number, expectDup = false) {
  const d = tab(page, 'delivery');
  await po(page, poName).click();
  await d.getByLabel("📄 מס' תעודת משלוח:").fill(doc);
  if (expectDup) await page.getByRole('alertdialog').getByRole('button', { name: 'המשך בכל זאת' }).click();
  await d.getByLabel(`בחר שורה ${line}`).check();
  await page.getByRole('button', { name: 'סיכום ויצוא ←' }).click();
  await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ CSV בלבד' }).click()]);
  await d.getByRole('button', { name: '✕ נקה הכל' }).click();
}

test('admins see usage analytics; regular users never download the admin screens', async ({ page }) => {
  page.on('dialog', (x) => void x.accept());
  await page.goto('/');
  await login(page, 'demo@mody.co.il');

  // some activity: an upload, two reports reusing one delivery-note number, one unfinished selection
  await tab(page, 'delivery').getByTestId('open-orders-input').setInputFiles(openOrdersFile(dir));
  await exportOne(page, 'PO202600000404', '700000501', 1);
  await exportOne(page, 'PO202600000101', '700000501', 2, true);
  await po(page, 'PO202600000202').click();
  await tab(page, 'delivery').getByLabel('בחר שורה 1').check();

  await page.getByRole('button', { name: '⚙ ניהול' }).click();
  const admin = tab(page, 'admin');
  await admin.getByPlaceholder('אימייל').fill('worker@mody.co.il');
  await page.getByRole('button', { name: '+ הוסף' }).click();
  await expect(admin.getByText('worker@mody.co.il')).toBeVisible();

  await admin.getByRole('tab', { name: '📊 אנליטיקה' }).click();
  const an = admin.getByTestId('analytics');
  await expect(an.locator('.an-kpi').filter({ hasText: 'דיווחים' }).first()).toContainText('2');
  await expect(an.locator('.an-kpi').filter({ hasText: 'משתמשים פעילים' })).toContainText('1');
  await expect(an.locator('.an-kpi').filter({ hasText: 'קובץ הזמנות פתוחות' })).toContainText('✅');

  const users = an.getByTestId('analytics-users');
  await expect(users.getByRole('row').filter({ hasText: 'demo@mody.co.il' })).toContainText('2'); // reports in period
  await expect(users.getByRole('row').filter({ hasText: 'worker@mody.co.il' })).toContainText('טרם נרשם');

  await expect(an.getByTestId('analytics-dups')).toContainText('700000501');
  await expect(an.getByTestId('analytics-dups')).toContainText('PO202600000404');

  // the unfinished selection shows once the threshold allows "today"
  await expect(an.getByText('אין בחירות פתוחות ישנות')).toBeVisible();
  await an.getByLabel('ימים ללא שינוי').selectOption('1');
  await expect(an.getByText('אין בחירות פתוחות ישנות')).toBeVisible(); // updated today, not ≥1 day ago

  // chart hover tooltip and table view
  await an.locator('[data-testid^="bar-"]').last().hover();
  await expect(an.getByRole('tooltip')).toContainText('סה״כ: 2');
  await an.getByRole('button', { name: 'הצג כטבלה' }).click();
  await expect(an.locator('table:has(th:text-is("תקופה"))')).toContainText('2');

  // a regular user: no management tab, and the admin code is never requested
  await page.getByRole('button', { name: /demo@mody\.co\.il/ }).click();
  await page.getByRole('menuitem', { name: /התנתקות/ }).click();
  const fresh = await page.context().newPage();
  const adminChunks: string[] = [];
  fresh.on('request', (r) => /AdminTab|AnalyticsPanel/.test(r.url()) && adminChunks.push(r.url()));
  await fresh.goto('/');
  await login(fresh, 'worker@mody.co.il');
  await expect(fresh.getByRole('button', { name: '📦 תעודות משלוח' })).toBeVisible();
  await expect(fresh.getByRole('button', { name: '⚙ ניהול' })).toHaveCount(0);
  await fresh.waitForTimeout(500);
  expect(adminChunks).toEqual([]);
});
