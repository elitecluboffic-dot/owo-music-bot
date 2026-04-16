const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  NoSubscriberBehavior,
  StreamType
} = require('@discordjs/voice');
const playdl = require('play-dl');
const ytdl = require('@distube/ytdl-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ====================== YT-DLP BINARY ======================
const YTDLP_BIN = (() => {
  const winPath = path.resolve('./yt-dlp.exe');
  const linuxPath = path.resolve('./yt-dlp');
  if (process.platform === 'win32' && fs.existsSync(winPath)) return winPath;
  if (fs.existsSync(linuxPath)) return linuxPath;
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
})();
console.log(`[yt-dlp] Binary: ${YTDLP_BIN}`);

if (process.platform !== 'win32' && fs.existsSync(YTDLP_BIN)) {
  try { fs.chmodSync(YTDLP_BIN, '755'); } catch (_) {}
}

const youtubedl = require('youtube-dl-exec').create({ binPath: YTDLP_BIN });

// ====================== HELPERS ======================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function jitter(min, max) {
  return sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function extractCleanUrl(input) {
  try {
    const str = (input && typeof input === 'object') ? (input.href || JSON.stringify(input)) : String(input);
    const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/))([a-zA-Z0-9_-]{11})/);
    return match ? `https://www.youtube.com/watch?v=${match[1]}` : str.trim();
  } catch (_) {
    return String(input).trim();
  }
}

// ====================== YOUTUBE COOKIES ======================
let cookiesFilePath = null;

function loadYouTubeCookies() {
  if (process.env.YOUTUBE_COOKIE_FILE && fs.existsSync(process.env.YOUTUBE_COOKIE_FILE)) {
    cookiesFilePath = process.env.YOUTUBE_COOKIE_FILE;
    console.log(`🔄 Menggunakan cookies file: ${cookiesFilePath}`);
    try {
      const cookieContent = fs.readFileSync(cookiesFilePath, 'utf-8');
      const parsed = parseNetscapeCookies(cookieContent);
      if (parsed) playdl.setToken({ youtube: { cookie: parsed } });
    } catch (_) {}
    return;
  }

  let cookieInput = process.env.YOUTUBE_COOKIE?.trim();
  if (!cookieInput) {
    console.log('⚠️ YOUTUBE_COOKIE dan YOUTUBE_COOKIE_FILE belum diisi');
    try { playdl.setToken({ youtube: { cookie: '' } }); } catch (_) {}
    return;
  }

  if (cookieInput.includes('.youtube.com') || cookieInput.includes('Netscape')) {
    const tmpPath = path.resolve('./cookies.txt');
    try {
      fs.writeFileSync(tmpPath, cookieInput, 'utf-8');
      cookiesFilePath = tmpPath;
      console.log(`✅ Cookie Netscape disimpan ke ${tmpPath}`);
    } catch (_) {}
    const parsed = parseNetscapeCookies(cookieInput);
    if (parsed) {
      try { playdl.setToken({ youtube: { cookie: parsed } }); } catch (_) {}
    }
    return;
  }

  try {
    playdl.setToken({ youtube: { cookie: cookieInput } });
    console.log(`✅ YouTube cookies dimuat (${cookieInput.length} char)`);
  } catch (err) {
    console.error('❌ Error set cookie:', err.message);
  }
}

function parseNetscapeCookies(content) {
  const lines = content.split('\n');
  const parts = [];
  const wanted = [
    'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
    '__Secure-1PSID', '__Secure-3PSID',
    '__Secure-1PAPISID', '__Secure-3PAPISID',
    '__Secure-1PSIDTS', '__Secure-3PSIDTS',
    '__Secure-1PSIDCC', '__Secure-3PSIDCC'
  ];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const cols = t.split(/\s+/);
    if (cols.length < 7) continue;
    if (wanted.includes(cols[5])) parts.push(`${cols[5]}=${cols[6]}`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

loadYouTubeCookies();

// ====================== PO TOKEN + VISITOR DATA ======================
if (process.env.YT_VISITOR_DATA || process.env.YT_PO_TOKEN) {
  try {
    const tokenObj = { youtube: {} };
    if (process.env.YOUTUBE_COOKIE) tokenObj.youtube.cookie = process.env.YOUTUBE_COOKIE;
    if (process.env.YT_VISITOR_DATA) tokenObj.youtube.visitorData = process.env.YT_VISITOR_DATA;
    if (process.env.YT_PO_TOKEN) tokenObj.youtube.poToken = process.env.YT_PO_TOKEN;
    playdl.setToken(tokenObj);
    console.log(`✅ YouTube token dimuat (visitorData: ${!!process.env.YT_VISITOR_DATA}, poToken: ${!!process.env.YT_PO_TOKEN})`);
  } catch (e) {
    console.warn('⚠️ Gagal set YT token:', e.message);
  }
}

// Debug cookies
if (cookiesFilePath && fs.existsSync(cookiesFilePath)) {
  const size = fs.statSync(cookiesFilePath).size;
  console.log(`✅ Cookies file OK: ${cookiesFilePath} (${size} bytes)`);
} else {
  console.warn('⚠️ Cookies file TIDAK ditemukan! YouTube mungkin diblokir.');
}

// ====================== YTDL AGENT ======================
let ytdlAgent;
try {
  const rawCookies = process.env.YTDL_COOKIES;
  if (rawCookies) {
    ytdlAgent = ytdl.createAgent(JSON.parse(rawCookies));
    console.log('✅ ytdl-core agent dari YTDL_COOKIES');
  } else {
    ytdlAgent = ytdl.createAgent();
    console.log('ℹ️ ytdl-core agent tanpa cookies');
  }
} catch (e) {
  console.warn('⚠️ Gagal buat ytdl agent:', e.message);
}

// ====================== CLIENT SETUP ======================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
const queues = new Map();
const PREFIX = '!';

// ====================== SONG CACHE ======================
const songCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
function getCached(key) {
  const entry = songCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) { songCache.delete(key); return null; }
  return entry.songs;
}
function setCache(key, songs) {
  if (songCache.size >= 200) songCache.delete(songCache.keys().next().value);
  songCache.set(key, { songs, timestamp: Date.now() });
}

// ====================== REQUEST QUEUE ======================
let ytRequestRunning = false;
const ytRequestQueue = [];
function enqueueYtRequest(fn) {
  return new Promise((resolve, reject) => {
    ytRequestQueue.push({ fn, resolve, reject });
    processYtQueue();
  });
}
async function processYtQueue() {
  if (ytRequestRunning || ytRequestQueue.length === 0) return;
  ytRequestRunning = true;
  const { fn, resolve, reject } = ytRequestQueue.shift();
  try { resolve(await fn()); } catch (err) { reject(err); } finally {
    ytRequestRunning = false;
    await jitter(1500, 3000);
    processYtQueue();
  }
}

// ====================== QUEUE FACTORY ======================
function createQueue() {
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  player.on('stateChange', (o, n) => console.log(`[Player] ${o.status} -> ${n.status}`));
  player.on('error', (e) => console.error('[Player Error]', e.message));
  return { songs: [], player, connection: null, textChannel: null, volume: 1, loop: false };
}

// ====================== SPOTIFY LOGIN ======================
async function loginSpotify() {
  try {
    if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET && process.env.SPOTIFY_REFRESH_TOKEN) {
      await playdl.setToken({
        spotify: {
          client_id: process.env.SPOTIFY_CLIENT_ID,
          client_secret: process.env.SPOTIFY_CLIENT_SECRET,
          refresh_token: process.env.SPOTIFY_REFRESH_TOKEN,
          market: 'ID'
        }
      });
      console.log('✅ Spotify berhasil terhubung!');
    }
  } catch (e) { console.log('⚠️ Spotify gagal login:', e.message); }
}

// ====================== BOT READY ======================
let readyFired = false;
async function onReady() {
  if (readyFired) return;
  readyFired = true;
  console.log(`✅ Owo Music Bot Online! (${client.user.tag})`);
  client.user.setActivity('🎵 !play <lagu>', { type: 2 });
  await loginSpotify();
}
client.once('clientReady', onReady);

// ====================== RESOLVE SONGS ======================
async function resolveSongs(query, requester, retry = 0) {
  const maxRetries = 4;
  if (typeof query !== 'string') query = String(query);
  const cacheKey = query.toLowerCase().trim();
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[Cache] Hit: "${cacheKey}"`);
    return cached.map(s => ({ ...s, requestedBy: requester }));
  }

  return enqueueYtRequest(async () => {
    try {
      await jitter(2000, 4000);
      try { if (playdl.is_expired?.() && process.env.SPOTIFY_CLIENT_ID) await loginSpotify(); } catch (_) {}

      // ===== SPOTIFY =====
      if (query.includes('spotify.com')) {
        const info = await playdl.spotify(query);
        if (info.type === 'track') {
          await jitter(1000, 2000);
          const ytResult = await playdl.search(`${info.name} ${info.artists[0].name}`, { source: { youtube: 'video' }, limit: 1 });
          if (!ytResult.length) throw new Error('Tidak ditemukan di YouTube');
          const songs = [{ title: info.name, url: ytResult[0].url, duration: formatDuration(info.durationInSec), requestedBy: requester, thumbnail: info.thumbnail?.url || ytResult[0].thumbnails?.[0]?.url }];
          setCache(cacheKey, songs);
          return songs;
        }
        if (info.type === 'playlist' || info.type === 'album') {
          const songs = [];
          for (const track of info.tracks || []) {
            await jitter(1200, 2500);
            const ytSearch = await playdl.search(`${track.name} ${track.artists[0].name}`, { source: { youtube: 'video' }, limit: 1 });
            if (ytSearch.length > 0) {
              songs.push({ title: track.name, url: ytSearch[0].url, duration: formatDuration(track.durationInSec), requestedBy: requester, thumbnail: track.thumbnail?.url || ytSearch[0].thumbnails?.[0]?.url });
            }
          }
          return songs;
        }
      }

      // ===== YOUTUBE URL =====
      if (query.includes('youtube.com') || query.includes('youtu.be')) {
        await jitter(1500, 3000);
        const cleanUrl = extractCleanUrl(query);

        // Prioritas 1: yt-dlp
        try {
          console.log('[resolve] Mencoba yt-dlp untuk info...');
          const ytdlpOptions = {
            dumpSingleJson: true,
            noWarnings: true,
            quiet: true,
            noCheckCertificates: true,
            extractorRetries: 3,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            addHeader: ['Accept-Language:en-US,en;q=0.9'],
          };
          if (cookiesFilePath && fs.existsSync(cookiesFilePath)) {
            ytdlpOptions.cookies = cookiesFilePath;
          }
          if (process.env.YT_PO_TOKEN && process.env.YT_VISITOR_DATA) {
            ytdlpOptions.extractorArgs = `youtube:po_token=web+${process.env.YT_PO_TOKEN};visitor_data=${process.env.YT_VISITOR_DATA}`;
          }

          const ytInfo = await youtubedl(cleanUrl, ytdlpOptions);
          if (!ytInfo || !ytInfo.title) throw new Error('yt-dlp tidak mengembalikan data valid');

          const songs = [{ title: ytInfo.title, url: ytInfo.webpage_url || cleanUrl, duration: formatDuration(ytInfo.duration), requestedBy: requester, thumbnail: ytInfo.thumbnail }];
          setCache(cacheKey, songs);
          console.log(`[resolve] ✅ yt-dlp: ${ytInfo.title}`);
          return songs;
        } catch (ytErr) {
          console.warn('[resolve] yt-dlp gagal, fallback ke playdl:', ytErr.message);
        }

        // Prioritas 2: play-dl
        let info;
        for (let attempt = 0; attempt <= 4; attempt++) {
          try {
            info = await playdl.video_info(cleanUrl);
            break;
          } catch (err) {
            if (err.message.includes('429') && attempt < 4) {
              const wait = (attempt + 1) * 25000;
              console.log(`⏳ 429 → tunggu ${wait / 1000}s`);
              await sleep(wait);
              continue;
            }
            console.error('[resolve] playdl gagal:', err.message);
            throw err;
          }
        }
        const details = info.video_details;
        const songs = [{ title: details.title, url: details.url, duration: formatDuration(details.durationInSec), requestedBy: requester, thumbnail: details.thumbnails?.[0]?.url }];
        setCache(cacheKey, songs);
        return songs;
      }

      // ===== SEARCH QUERY =====
      await jitter(800, 1500);
      const results = await playdl.search(query, { source: { youtube: 'video' }, limit: 1 });
      if (!results.length) return [];
      const songs = [{ title: results[0].title, url: results[0].url, duration: formatDuration(results[0].durationInSec), requestedBy: requester, thumbnail: results[0].thumbnails?.[0]?.url }];
      setCache(cacheKey, songs);
      return songs;

    } catch (error) {
      console.error('[resolveSongs Error]', error.message);
      if (error.message?.includes('429') && retry < maxRetries) {
        const waitTime = Math.pow(2, retry + 1) * 8000;
        console.log(`⏳ 429 → Tunggu ${waitTime / 1000}s (retry ${retry + 1}/${maxRetries})`);
        await sleep(waitTime);
        return resolveSongs(query, requester, retry + 1);
      }
      return [];
    }
  });
}

// ====================== GET STREAM ======================
async function getStream(url, retry = 0) {
  const maxRetries = 3;
  const cleanUrl = extractCleanUrl(url);

  // ── 1. yt-dlp via spawn ──
  try {
    console.log('[Stream] Mencoba yt-dlp via spawn...');
    const args = [
      cleanUrl,
      '--format', 'bestaudio[ext=webm]/bestaudio[ext=opus]/bestaudio/best',
      '--output', '-',
      '--quiet',
      '--no-warnings',
      '--no-check-certificates',
      '--extractor-retries', '3',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
    ];

    if (cookiesFilePath && fs.existsSync(cookiesFilePath)) {
      args.push('--cookies', cookiesFilePath);
      console.log(`[yt-dlp] Pakai cookies: ${cookiesFilePath}`);
    } else {
      console.warn('[yt-dlp] ⚠️ Tidak ada cookies file!');
    }

    if (process.env.YT_PO_TOKEN && process.env.YT_VISITOR_DATA) {
      args.push('--extractor-args', `youtube:po_token=web+${process.env.YT_PO_TOKEN};visitor_data=${process.env.YT_VISITOR_DATA}`);
      console.log('[yt-dlp] Pakai po_token + visitorData');
    } else if (process.env.YT_VISITOR_DATA) {
      args.push('--add-header', `X-Youtube-Identity-Token:${process.env.YT_VISITOR_DATA}`);
    }

    const subprocess = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (!subprocess.stdout) throw new Error('yt-dlp stdout null');

    subprocess.stderr?.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.warn('[yt-dlp stderr]', msg);
    });

    await new Promise((resolve, reject) => {
      subprocess.stdout.once('data', resolve);
      subprocess.once('error', reject);
      subprocess.once('close', (code) => {
        if (code !== 0 && code !== null) reject(new Error(`yt-dlp exit ${code}`));
      });
      setTimeout(resolve, 3000);
    });

    console.log('[Stream] ✅ yt-dlp berhasil');
    return { stream: subprocess.stdout, type: StreamType.Arbitrary };
  } catch (e) {
    console.warn('[Stream] ❌ yt-dlp gagal:', e.message);
  }

  // ── 2. play-dl ──
  try {
    console.log('[Stream] Mencoba play-dl...');
    await jitter(800, 1500);
    const streamData = await playdl.stream(cleanUrl, { quality: 2, discordPlayerCompatibility: true });
    console.log('[Stream] ✅ play-dl berhasil');
    return { stream: streamData.stream, type: streamData.type };
  } catch (e) {
    console.warn('[Stream] ❌ play-dl gagal:', e.message);
    if (e.message.includes('429') && retry < maxRetries) {
      await sleep((retry + 1) * 15000);
      return getStream(url, retry + 1);
    }
  }

  // ── 3. ytdl-core fallback ──
  try {
    console.log('[Stream] Mencoba ytdl-core...');
    const opts = { filter: 'audioonly', quality: 'highestaudio', highWaterMark: 1 << 25 };
    if (ytdlAgent) opts.agent = ytdlAgent;
    const stream = ytdl(cleanUrl, opts);
    console.log('[Stream] ✅ ytdl-core berhasil');
    return { stream, type: StreamType.Arbitrary };
  } catch (e) {
    console.error('[Stream] ❌ ytdl-core gagal:', e.message);
    throw new Error('Semua metode stream gagal.');
  }
}

// ====================== PLAY SONG ======================
async function playSong(guildId, queue) {
  if (!queue || !queue.songs.length) {
    if (queue?.textChannel) queue.textChannel.send('✅ Antrian habis! Ketik `!leave` untuk keluar.');
    return;
  }
  const song = queue.songs[0];
  try {
    console.log(`[playSong] Streaming: ${song.title}`);
    await jitter(500, 1000);
    const { stream, type } = await getStream(song.url);
    const resource = createAudioResource(stream, { inputType: type, inlineVolume: true });
    resource.volume?.setVolume(queue.volume);
    queue.player.play(resource);

    if (queue.textChannel) {
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎶 Sedang Memutar')
        .setDescription(`**[${song.title}](${song.url})**`)
        .addFields(
          { name: '⏱️ Durasi', value: song.duration || '?', inline: true },
          { name: '👤 Request', value: song.requestedBy || 'Unknown', inline: true },
          { name: '📋 Antrian', value: `${queue.songs.length - 1} lagu berikutnya`, inline: true }
        )
        .setFooter({ text: 'Owo Music Bot 🎵' });
      queue.textChannel.send({ embeds: [embed] });
    }

    queue.player.once(AudioPlayerStatus.Idle, () => {
      if (!queue.loop) queue.songs.shift();
      playSong(guildId, queue);
    });
  } catch (e) {
    console.error('[playSong Error]', e.message);
    if (queue.textChannel) queue.textChannel.send(`⚠️ Error memutar **${song.title}**, skip...`);
    queue.songs.shift();
    playSong(guildId, queue);
  }
}

// ====================== START CONNECTION ======================
async function startConnection(queue, voiceChannel, guild) {
  try {
    const oldConn = getVoiceConnection(guild.id);
    if (oldConn) { oldConn.destroy(); await sleep(800); }
    console.log(`[Voice] Join ke: ${voiceChannel.name}`);
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });
    connection.on('stateChange', (o, n) => console.log(`[Voice State] ${o.status} -> ${n.status}`));
    connection.on('error', (e) => console.error('[Voice Error]', e.message));
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        console.log('🔄 Reconnecting...');
      } catch {
        connection.destroy();
        queues.delete(guild.id);
      }
    });
    queue.connection = connection;
    connection.subscribe(queue.player);
    await entersState(connection, VoiceConnectionStatus.Ready, 40_000);
    console.log('✅ [Voice] Berhasil join!');
    return true;
  } catch (e) {
    console.error('[Voice ERROR]', e.message);
    getVoiceConnection(guild.id)?.destroy();
    queues.delete(guild.id);
    if (queue.textChannel) queue.textChannel.send('❌ Bot gagal join voice channel.');
    return false;
  }
}

// ====================== COMMANDS ======================
async function cmdPlay(message, query) {
  if (!query) return message.reply('❌ Masukkan judul lagu atau link!\n`!play <judul / link>`');
  const voiceChannel = message.member?.voice.channel;
  if (!voiceChannel) return message.reply('❌ Kamu harus join voice channel dulu!');
  console.log(`[CMD PLAY] User: ${message.author.tag} | Query: ${query}`);
  const loadingMsg = await message.reply('🔍 Mencari lagu...');
  let queue = queues.get(message.guild.id);
  if (!queue) { queue = createQueue(); queues.set(message.guild.id, queue); }
  queue.textChannel = message.channel;
  try {
    const songs = await resolveSongs(query, message.author.tag);
    if (!songs.length) return loadingMsg.edit('❌ Lagu tidak ditemukan atau kena rate limit.');
    const wasEmpty = queue.songs.length === 0;
    queue.songs.push(...songs);
    await loadingMsg.edit(songs.length === 1 ? `✅ **Ditambahkan:** ${songs[0].title}` : `✅ **Ditambahkan ${songs.length} lagu** ke antrian!`);
    if (wasEmpty) {
      const connected = await startConnection(queue, voiceChannel, message.guild);
      if (connected) { await sleep(500); playSong(message.guild.id, queue); }
    }
  } catch (e) {
    console.error('[cmdPlay ERROR]', e.message);
    await loadingMsg.edit('❌ Terjadi error saat memproses perintah.');
  }
}

async function cmdSkip(message) {
  const queue = queues.get(message.guild.id);
  if (!queue || !queue.songs.length) return message.reply('❌ Tidak ada lagu!');
  queue.player.stop();
  message.reply('⏭️ Lagu di-skip!');
}

async function cmdStop(message) {
  const queue = queues.get(message.guild.id);
  if (!queue) return message.reply('❌ Bot tidak aktif!');
  queue.songs = []; queue.loop = false; queue.player.stop();
  message.reply('⏹️ Music player dihentikan!');
}

async function cmdLeave(message) {
  const queue = queues.get(message.guild.id);
  if (queue) { queue.player.stop(true); queue.connection?.destroy(); queues.delete(message.guild.id); }
  message.reply('👋 Bot keluar dari voice channel!');
}

async function cmdQueue(message) {
  const queue = queues.get(message.guild.id);
  if (!queue || !queue.songs.length) return message.reply('📋 Antrian kosong!');
  const list = queue.songs.slice(0, 10).map((s, i) => `${i === 0 ? '▶️' : `${i + 1}.`} ${s.title} \`[${s.duration}]\``).join('\n');
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('📋 Antrian Lagu').setDescription(list).setFooter({ text: `Total: ${queue.songs.length} lagu${queue.loop ? ' | 🔁 Loop aktif' : ''}` });
  message.reply({ embeds: [embed] });
}

async function cmdNowPlaying(message) {
  const queue = queues.get(message.guild.id);
  if (!queue || !queue.songs.length) return message.reply('❌ Tidak ada lagu!');
  const song = queue.songs[0];
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🎵 Now Playing').setDescription(`**[${song.title}](${song.url})**`).addFields({ name: '⏱️ Durasi', value: song.duration || '?', inline: true }, { name: '👤 Request', value: song.requestedBy || 'Unknown', inline: true });
  message.reply({ embeds: [embed] });
}

async function cmdPause(message) {
  const queue = queues.get(message.guild.id);
  if (!queue) return message.reply('❌ Tidak ada lagu!');
  queue.player.pause(); message.reply('⏸️ Lagu di-pause!');
}

async function cmdResume(message) {
  const queue = queues.get(message.guild.id);
  if (!queue) return message.reply('❌ Tidak ada lagu!');
  queue.player.unpause(); message.reply('▶️ Lagu dilanjutkan!');
}

async function cmdLoop(message) {
  const queue = queues.get(message.guild.id);
  if (!queue) return message.reply('❌ Tidak ada lagu!');
  queue.loop = !queue.loop;
  message.reply(`🔁 Loop: **${queue.loop ? 'Aktif' : 'Nonaktif'}**`);
}

async function cmdHelp(message) {
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🎵 Owo Music Bot — Daftar Perintah').addFields(
    { name: '`!play <judul/link>`', value: 'Putar lagu dari YouTube/Spotify', inline: false },
    { name: '`!skip` / `!s`', value: 'Skip lagu', inline: true },
    { name: '`!stop`', value: 'Stop & clear antrian', inline: true },
    { name: '`!pause` / `!resume`', value: 'Pause / Resume', inline: true },
    { name: '`!queue` / `!q`', value: 'Lihat antrian', inline: true },
    { name: '`!np`', value: 'Lagu sekarang', inline: true },
    { name: '`!loop`', value: 'Toggle loop', inline: true },
    { name: '`!leave` / `!dc`', value: 'Keluar voice', inline: true }
  ).setFooter({ text: 'Owo Music Bot 🎵' });
  message.reply({ embeds: [embed] });
}

// ====================== MESSAGE HANDLER ======================
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const query = args.join(' ');
  console.log(`[CMD] ${message.author.tag}: ${PREFIX}${command} ${query}`);
  switch (command) {
    case 'play': case 'p': await cmdPlay(message, query); break;
    case 'skip': case 's': await cmdSkip(message); break;
    case 'stop': await cmdStop(message); break;
    case 'leave': case 'dc': await cmdLeave(message); break;
    case 'queue': case 'q': await cmdQueue(message); break;
    case 'np': case 'nowplaying': await cmdNowPlaying(message); break;
    case 'pause': await cmdPause(message); break;
    case 'resume': await cmdResume(message); break;
    case 'loop': await cmdLoop(message); break;
    case 'help': await cmdHelp(message); break;
  }
});

// ====================== LOGIN ======================
client.login(process.env.TOKEN);
