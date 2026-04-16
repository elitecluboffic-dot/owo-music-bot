import { BgUtils, BgConfig } from 'bgutils-js';
import { JSDOM } from 'jsdom';

const requestKey = 'O43z0dpjhgX20SCx4KAo';
const dom = new JSDOM();
const bgConfig = {
  fetch: (url, options) => fetch(url, options),
  globalObj: dom.window,
  identifier: '',
  requestKey,
};

const challenge = await BgUtils.getChallenge(bgConfig);
if (!challenge) { console.error('Gagal dapat challenge'); process.exit(1); }

await BgUtils.solveChallenge(challenge);
const tokenResult = await BgUtils.generatePoToken(challenge.bgScriptResponse);

console.log('\n=== HASIL ===');
console.log('visitorData:', challenge.interpreterHash);
console.log('poToken:', tokenResult.poToken);
