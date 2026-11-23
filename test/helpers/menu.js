'use strict';
// Main menu hub helper: the options (data-fmt tiles) sit under their hub tile. Table (Quick game) and
// multiplayer are in Play; exam, practice and single spots (quick) are in Practice. Opens the right
// hub first when the tile is hidden, then clicks the tile. Works with a Playwright Page.
async function openFmt(p, fmt) {
  const group = fmt === 'table' || fmt === 'mp' ? 'play' : 'practice';
  if (!(await p.isVisible('[data-fmt="' + fmt + '"]'))) await p.click('#hub-' + group);
  await p.click('[data-fmt="' + fmt + '"]');
}
module.exports = { openFmt };
