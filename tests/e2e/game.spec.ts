import { test, expect, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5173';

async function createPair(browser: Browser, host: Page): Promise<{ guest: Page; guestContext: BrowserContext }> {
  await host.goto('./');
  await host.getByRole('button', { name: '创建房间，邀请朋友' }).click();
  await expect(host.getByRole('heading', { name: '把朋友叫来吧。' })).toBeVisible();
  const invitation = await host.getByLabel('邀请链接', { exact: true }).inputValue();
  const guestContext = await browser.newContext({ ...devices['iPhone 13'], baseURL });
  const guest = await guestContext.newPage();
  await guest.goto(invitation);
  await guest.getByRole('button', { name: '加入房间', exact: true }).click();
  await expect(host.getByRole('heading', { name: '这次，你想到了什么？' })).toBeVisible();
  await expect(guest.getByRole('heading', { name: '这次，你想到了什么？' })).toBeVisible();
  return { guest, guestContext };
}

async function submitWord(page: Page, word: string) {
  await page.getByLabel('你的词', { exact: true }).fill(word);
  await page.getByRole('button', { name: '提交，等对方揭晓' }).click();
}

async function expectNoHorizontalOverflow(page: Page) {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
}

test('两部手机完成提交、隐藏、刷新恢复、同词结束、重开与双举手', async ({ page, browser }, testInfo) => {
  const { guest, guestContext } = await createPair(browser, page);
  try {
    await page.screenshot({ path: testInfo.outputPath('game-mobile.png'), fullPage: true });
    // Refreshing an invitation in the same browser must restore its own seat,
    // rather than attempting to join the now-full room as a third person.
    await guest.reload();
    await expect(guest.getByLabel('你的词', { exact: true })).toBeVisible();
    await submitWord(page, '海风');
    await expect(page.getByText('等待对方提交，随后一起揭晓。')).toBeVisible();
    await expect(guest.getByText('对方已提交', { exact: true })).toBeVisible();
    await expect(guest.getByText('海风', { exact: true })).toHaveCount(0);

    await page.reload();
    await expect(page.getByText('等待对方提交，随后一起揭晓。')).toBeVisible();
    await expect(page.getByLabel('你的词', { exact: true })).toHaveCount(0);
    await submitWord(guest, '海风');
    await expect(page.getByText('同词成功 · 完成 1 轮对词')).toBeVisible();
    await expect(guest.getByText('同词成功 · 完成 1 轮对词')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('matched-mobile.png'), fullPage: true });

    await page.getByRole('button', { name: '再来一局', exact: true }).click();
    await expect(page.getByRole('button', { name: '已准备，等待对方' })).toBeDisabled();
    await expect(guest.getByRole('heading', { name: '原来，我们想的一样。' })).toBeVisible();
    await guest.getByRole('button', { name: '再来一局', exact: true }).click();
    await expect(page.getByLabel('你的词', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '举手结束', exact: true }).click();
    await expect(page.getByRole('button', { name: '你已举手，等待对方确认' })).toBeDisabled();
    await submitWord(page, '大海');
    await submitWord(guest, '沙滩');
    await expect(page.getByRole('heading', { name: '离同频，又近了一点。' })).toBeVisible();
    await expect(guest.getByRole('heading', { name: '离同频，又近了一点。' })).toBeVisible();
    await page.getByRole('button', { name: '继续下一轮', exact: true }).click();
    await expect(page.getByRole('button', { name: '已准备，等待对方' })).toBeDisabled();
    await expect(guest.getByRole('heading', { name: '离同频，又近了一点。' })).toBeVisible();
    await guest.getByRole('button', { name: '继续下一轮', exact: true }).click();
    await expect(page.getByText('第 02 轮', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '你已举手，等待对方确认' })).toBeDisabled();
    await submitWord(guest, '尚未揭晓的海浪');
    await expect(page.getByText('尚未揭晓的海浪', { exact: true })).toHaveCount(0);
    await guest.getByRole('button', { name: '举手结束 · 我也认同', exact: true }).click();
    await expect(page.getByText('双方举手，确认同频 · 完成 1 轮对词')).toBeVisible();
    await expect(guest.getByText('双方举手，确认同频 · 完成 1 轮对词')).toBeVisible();
    await expect(page.getByRole('table', { name: '已揭晓的对词记录' }).getByText('大海', { exact: true })).toBeVisible();
    await expect(page.getByText('尚未揭晓的海浪', { exact: true })).toHaveCount(0);
  } finally {
    await guestContext.close();
  }
});

test('320px 手机首页和邀请页可用，复制失败提供可选中的链接', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')) },
    });
  });
  await page.goto('./');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('home-320px.png'), fullPage: true });
  await page.getByLabel('已有房间码？', { exact: true }).fill('123');
  await page.getByRole('button', { name: '加入房间', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('请输入 6 位数字房间码');
  await page.getByRole('button', { name: '创建房间，邀请朋友' }).click();
  await page.getByRole('button', { name: '复制链接', exact: true }).click();
  await expect(page.getByText('无法自动复制，请长按下方链接，选择复制。')).toBeVisible();
  const link = page.getByLabel('邀请链接', { exact: true });
  await expect(link).toBeFocused();
  const selection = await link.evaluate((input: HTMLInputElement) => ({
    start: input.selectionStart, end: input.selectionEnd, length: input.value.length,
  }));
  expect(selection).toEqual({ start: 0, end: selection.length, length: selection.length });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('lobby-320px.png'), fullPage: true });
});

test('词语输入限制和超长中文在小屏幕上保持可读', async ({ page, browser }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const { guest, guestContext } = await createPair(browser, page);
  try {
    const submit = page.getByRole('button', { name: '提交，等对方揭晓' });
    const input = page.getByLabel('你的词', { exact: true });
    await expect(submit).toBeDisabled();
    await input.fill('词'.repeat(31));
    await expect(submit).toBeDisabled();
    await input.fill('词'.repeat(30));
    await expect(submit).toBeEnabled();
    await submit.click();
    await submitWord(guest, '风'.repeat(30));
    await expect(page.getByRole('heading', { name: '离同频，又近了一点。' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('long-words-320px.png'), fullPage: true });
  } finally {
    await guestContext.close();
  }
});

test('手机离线后自动恢复已提交内容，双方同时举手不会回退结束状态', async ({ page, browser, context }) => {
  const { guest, guestContext } = await createPair(browser, page);
  try {
    await submitWord(page, '离线前的词');
    await expect(page.getByText('等待对方提交，随后一起揭晓。')).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByText(/连接已断开，正在尝试重连/)).toBeVisible();
    await expect(page.getByRole('button', { name: '举手结束', exact: true })).toBeDisabled();
    await expect(guest.getByText('对方离线，等待重连', { exact: true })).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByRole('button', { name: '举手结束', exact: true })).toBeEnabled();
    await expect(page.getByText('等待对方提交，随后一起揭晓。')).toBeVisible();
    await expect(guest.getByText('双方在线', { exact: true })).toBeVisible();
    await submitWord(guest, '不同但接近的词');
    await expect(page.getByRole('heading', { name: '离同频，又近了一点。' })).toBeVisible();
    await expect(guest.getByRole('heading', { name: '离同频，又近了一点。' })).toBeVisible();
    await Promise.all([
      page.getByRole('button', { name: /^举手结束/ }).click(),
      guest.getByRole('button', { name: /^举手结束/ }).click(),
    ]);
    await expect(page.getByText('双方举手，确认同频 · 完成 1 轮对词')).toBeVisible();
    await expect(guest.getByText('双方举手，确认同频 · 完成 1 轮对词')).toBeVisible();
  } finally {
    await context.setOffline(false);
    await guestContext.close();
  }
});

test('结束快照先于旧操作确认到达时，界面仍保持结束状态', async ({ page, browser }) => {
  let delayedAck: string | null = null;
  let released = false;
  let upgraded: () => void = () => {};
  const transportReady = new Promise<void>((resolve) => { upgraded = resolve; });
  await page.routeWebSocket(/\/socket\.io\//, (route) => {
    const server = route.connectToServer();
    route.onMessage((message) => {
      server.send(message);
      if (message === '5') upgraded();
    });
    server.onMessage((message) => {
      if (typeof message !== 'string') { route.send(message); return; }
      const ack = /^43\d+(\[.*)$/s.exec(message);
      if (ack) {
        const data = JSON.parse(ack[1]) as { ok?: boolean; snapshot?: { phase?: string; self?: { raised?: boolean } } }[];
        if (data[0]?.ok && data[0].snapshot?.phase === 'revealed' && data[0].snapshot.self?.raised) {
          delayedAck = message;
          return;
        }
      }
      route.send(message);
      if (delayedAck && message.startsWith('42[')) {
        const [event, snapshot] = JSON.parse(message.slice(2)) as [string, { phase?: string }];
        if (event === 'snapshot' && snapshot.phase === 'ended') {
          route.send(delayedAck);
          delayedAck = null;
          released = true;
        }
      }
    });
  });
  const { guest, guestContext } = await createPair(browser, page);
  try {
    await transportReady;
    await submitWord(page, '海风');
    await submitWord(guest, '海边的风');
    await expect(page.getByRole('heading', { name: '离同频，又近了一点。' })).toBeVisible();
    await page.getByRole('button', { name: '举手结束', exact: true }).click();
    await expect(guest.getByText('对方举手了，觉得已经同频。')).toBeVisible();
    await guest.getByRole('button', { name: '举手结束 · 我也认同', exact: true }).click();
    await expect.poll(() => released).toBe(true);
    await expect(page.getByText('正在同步…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('双方举手，确认同频 · 完成 1 轮对词')).toBeVisible();
    await expect(guest.getByText('双方举手，确认同频 · 完成 1 轮对词')).toBeVisible();
  } finally {
    await guestContext.close();
  }
});
