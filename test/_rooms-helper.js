'use strict';
// Entry helpers for e2e tests. Path: main menu -> Play (#hub-play) -> Multiplayer (#menu-card-mp) -> the
// Multiplayer screen (#mp-rooms[data-view="choose"]) -> a tile: #mr-tile-join (table finder and the list of open
// tables) or #mr-tile-create (table settings, Create table). The player's name comes from Settings > User (the
// shared record poker-trainer:user:v1); the helpers set it before the join so no name is typed on the screen.

// Writes the player's profile (the shared user record) without a page reload; mp.js reads it when the screen opens.
async function setUser(page, name, avatar) {
  await page.evaluate(([n, a]) => {
    window.localStorage.setItem('poker-trainer:user:v1', JSON.stringify({ name: n, avatar: a || '' }));
  }, [name || 'Tester', avatar || '']);
}

// Opens the Multiplayer screen and expands the tile for `mode` ('join' | 'create'; default 'join').
// For 'join' the finder panel is open and its list of tables is shown. The user name is set first (default 'Tester').
// Pass mode === false to only reach the Multiplayer screen.
async function openMp(page, mode, name) {
  if (mode === undefined) mode = 'join';
  if (!(await page.isVisible('#menu-card-mp'))) await page.click('#hub-play');
  await setUser(page, name || 'Tester');
  await page.click('#menu-card-mp');
  await page.waitForSelector('#mp-rooms[data-view="choose"]', { timeout: 10000 });
  if (!mode) return;
  await page.click('#mr-tile-' + mode);
  if (mode === 'join') await page.waitForSelector('#mr-panel-join:not([hidden])', { timeout: 10000 });
}

// Entry helper: after openMp(page, 'join', name) the list of tables shows in the finder panel. Joins the first
// listed table; with an empty list it creates one (Create tile, table name, Create table) with the same name.
// Then the table body shows (no name form: the name was set in Settings).
async function enterRoom(page, name) {
  await page.waitForSelector('#mr-panel-join:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(() => {
    const e = document.querySelector('#mp-rooms .mr-empty');
    return document.querySelectorAll('#mp-rooms .mr-row').length > 0 || (!!e && !e.hidden);
  }, null, { timeout: 10000 });
  if (await page.locator('#mp-rooms .mr-row').count()) {
    await page.locator('#mp-rooms .mr-row').first().click();
  } else {
    await page.click('#mr-tile-create');
    await page.fill('#mp-rooms .mr-tname', 'Table ' + Math.random().toString(36).slice(2, 7));
    await page.waitForSelector('#mp-rooms .mr-create-go:not([disabled])', { timeout: 10000 });
    await page.click('#mp-rooms .mr-create-go');
  }
  await page.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
}
module.exports = { enterRoom, openMp, setUser };
