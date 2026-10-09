const { test, expect } = require('@playwright/test');
const jwt = require('jsonwebtoken');

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

test('signup creates an authenticated persistent session; logout clears it', async ({ page }) => {
  const username = unique();
  await signUp(page, username);
  await page.reload();
  await expect(page.locator('#app-screen')).toBeVisible();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.locator('#auth-screen')).toBeVisible();
  const me = await page.request.get('/api/me');
  expect(me.status()).toBe(401);
});

test('wrong password is rejected', async ({ page }) => {
  const username = unique();
  await signUp(page, username);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.locator('#auth-screen')).toBeVisible();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill('incorrect-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.locator('#auth-error')).toContainText('Wrong username or password');
});

test('a session for a user that no longer exists is rejected, not crashed', async ({ page }) => {
  // A signed token whose user id is not in the database (e.g. after a reset) must be
  // treated as logged out. Used to reach a foreign-key failure that crashed the server.
  const token = jwt.sign({ id: 999999, username: 'ghost' }, 'playwright-test-secret-not-for-production', { expiresIn: '7d' });
  await page.context().addCookies([{ name: 'token', value: token, url: 'http://127.0.0.1:3100' }]);
  await page.goto('/');
  await expect(page.locator('#auth-screen')).toBeVisible();
  // The server must still be healthy afterwards.
  const me = await page.request.get('/api/me');
  expect(me.status()).toBe(401);
});

test('duplicate username is rejected without replacing the active account', async ({ page }) => {
  const username = unique();
  await signUp(page, username);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.locator('#auth-screen')).toBeVisible();
  await page.getByRole('button', { name: /create an account/i }).click();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('#auth-error')).toContainText('username is taken');
});
