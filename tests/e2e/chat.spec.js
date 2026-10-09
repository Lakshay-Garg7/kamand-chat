const { test, expect } = require('@playwright/test');
const unique = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const password = 'safe-test-password';

async function signUp(page, username) {
  await page.goto('/');
  await page.getByRole('button', { name: /create an account/i }).click();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('#app-screen')).toBeVisible();
}

async function openPerson(page, username) {
  await page.locator('#user-list li').filter({ hasText: username }).first().click();
  await expect(page.locator('#peer-name')).toHaveText(username);
}

test('two users exchange real-time messages; history survives reload', async ({ browser }) => {
  const alice = unique();
  const bob = unique();
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const a = await aliceContext.newPage();
  const b = await bobContext.newPage();
  try {
    await signUp(a, alice);
    await signUp(b, bob);
    await openPerson(a, bob);
    await openPerson(b, alice);
    // Presence must become visible in both authenticated sessions.
    await expect(a.locator('#peer-status')).toHaveText('Online');
    await expect(b.locator('#peer-status')).toHaveText('Online');

    const first = `hello-${Date.now()}`;
    await a.locator('#message-input').fill(first);
    await a.locator('#composer button[type="submit"]').click();
    await expect(b.locator('#messages')).toContainText(first);

    const second = `reply-${Date.now()}`;
    await b.locator('#message-input').fill(second);
    await b.locator('#composer button[type="submit"]').click();
    await expect(a.locator('#messages')).toContainText(second);

    await b.reload();
    await expect(b.locator('#app-screen')).toBeVisible();
    await openPerson(b, alice);
    await expect(b.locator('#messages')).toContainText(first);
    await expect(b.locator('#messages')).toContainText(second);

    await a.locator('#message-input').fill('typing-test');
    await expect(b.locator('#peer-status')).toHaveText('typing...');
    await a.locator('#message-input').fill('');
    await expect(b.locator('#peer-status')).not.toHaveText('typing...', { timeout: 6000 });
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test('empty message does not create a chat message', async ({ browser }) => {
  const alice = unique();
  const bob = unique();
  const ac = await browser.newContext();
  const bc = await browser.newContext();
  const a = await ac.newPage();
  const b = await bc.newPage();
  try {
    await signUp(a, alice);
    await signUp(b, bob);
    await openPerson(a, bob);
    await a.locator('#composer button[type="submit"]').click();
    await expect(a.locator('#messages .msg')).toHaveCount(0);
  } finally {
    await ac.close();
    await bc.close();
  }
});

test('Kamand AI replies to a message (free provider, no key needed)', async ({ page }) => {
  await signUp(page, unique());
  await openPerson(page, 'KamandAI');
  await page.locator('#message-input').fill('Say hello in three words.');
  await page.locator('#composer button[type="submit"]').click();
  // My message plus the assistant's reply = two bubbles (the free API can take a few seconds).
  await expect(page.locator('#messages .msg')).toHaveCount(2, { timeout: 30_000 });
});
