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
const youtubedl = require('youtube-dl-exec');

// ====================== YOUTUBE COOKIES ======================
function loadYouTubeCookies() {
  let cookieInput = process.env.YOUTUBE_COOKIE?.trim();

  if (!cookieInput) {
    console.log('⚠️ YOUTUBE_COOKIE belum diisi, init token kosong...');
    try { playdl.setToken({ youtube: { cookie: '' } }); } catch (_) {}
    return;
  }

  if (cookieInput.includes('.youtube.com') || cookieInput.includes('Netscape')) {
    console.log('🔄 Mendeteksi format Netscape cookies.txt...');
    const lines = cookieInput.split('\n');
    const cookieParts = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 7) continue;
      const name = parts[5];
      const value = parts[6];
      if ([
        'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
        '__Secure-1PSID', '__Secure-3PSID',
        '__Secure-1PAPISID', '__Secure-3PAPISID',
        '__Secure-1PSIDTS', '__Secure-3PSIDTS',
        '__Secure-1PSIDCC', '__Secure-3PSIDCC'
      ].includes(name)) {
        cookieParts.push(`${name}=${value}`);
      }
    }
    cookieInput = cookieParts.join('; ');
    console.log(`✅ Parse Netscape berhasil → ${cookieParts.length} cookie diambil`);
  }

  if (cookieInput.length < 500) {
    console.log(`⚠️ Cookie terlalu pendek (${cookieInput.length} char), tetap dicoba...`);
  }

  try {
    playdl.setToken({ youtube: { cookie: cookieInput } });
    console.log(`✅ YouTube cookies berhasil dimuat! (${cookieInput.length} karakter)`);
  } catch (err) {
    console.error('❌ Error set cookie:', err.message);
    try { playdl.setToken({ youtube: { cookie: '' } }); } catch (_) {}
  }
}
loadYouTubeCookies();

// ====================== YTDL AGENT ======================
let ytdlAgent;
try {
  const rawCookies = process.env.YTDL_COOKIES;
  if (rawCookies) {
    ytdlAgent = ytdl.createAgent(JSON.parse(rawCookies));
    console.log('✅ ytdl-core agent berhasil dibuat dari YTDL_COOKIES!');
  } else {
    ytdlAgent = ytdl.createAgent();
    console.log('ℹ️ ytdl-core agent tanpa cookies');
  }
} catch (e) {
  console.warn('⚠️ Gagal buat ytdl agent:', e.message);
  ytdlAgent = undefined;
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

// ====================== HELPERS ======================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Delay acak antara min–max ms supaya tidak kena rate limit
function jitter(min, max) {
  return sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ====================== SONG CACHE ======================
// Cache hasil search supaya query yang sama tidak hit YouTube lagi
const songCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 menit

function getCached(key) {
  const entry = songCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    songCache.delete(key);
    return null;
  }
  return entry.songs;
}

function setCache(key, songs) {
  if (songCache.size >= 200) {
    const firstKey = songCache.keys().next().value;
    songCache.delete(firstKey);
  }
  songCache.set(key, { songs, timestamp: Date.now() });
}

// ====================== REQUEST QUEUE ======================
// Semua request ke YouTube dijalankan satu per satu (serialize)
// supaya tidak ada banyak request paralel yang memicu rate limit
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
  try {
    const result = await fn();
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    ytRequestRunning = false;
    // Delay 1.5–3 detik antar request
    await jitter(1500, 3000);
    processYtQueue();
  }
}

// ====================== QUEUE FACTORY ======================
function createQueue() {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
  });

  player.on('stateChange', (oldState, newState) => {
    console.log(`[Player] ${oldState.status} -> ${newState.status}`);
  });

  player.on('error', (error) => {
    console.error('[Player Error]', error.message);
  });

  return {
    songs: [],
    player,
    connection: null,
    textChannel: null,
    volume: 1,
    loop: false
  };
}

// ====================== SPOTIFY LOGIN ======================
async function loginSpotify() {
  try {
    if (
      process.env.SPOTIFY_CLIENT_ID &&
      process.env.SPOTIFY_CLIENT_SECRET &&
      process.env.SPOTIFY_REFRESH_TOKEN
    ) {
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
  } catch (e) {
    console.log('⚠️ Spotify gagal login:', e.message);
  }
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

  // Cek cache dulu sebelum request ke YouTube
  const cacheKey = query.toLowerCase().trim();
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[Cache] Hit: "${cacheKey}"`);
    return cached.map(s => ({ ...s, requestedBy: requester }));
  }

  // Semua request YouTube dimasukkan ke antrian agar tidak paralel
  return enqueueYtRequest(async () => {
    try {
      await jitter(800, 1800);

      try {
        if (playdl.is_expired?.() && process.env.SPOTIFY_CLIENT_ID) await loginSpotify();
      } catch (_) {}

      // ===== SPOTIFY =====
      if (query.includes('spotify.com')) {
        const info = await playdl.spotify(query);

        if (info.type === 'track') {
          await jitter(1000, 2000);
          const ytResult = await playdl.search(
            `${info.name} ${info.artists[0].name}`,
            { source: { youtube: 'video' }, limit: 1 }
          );
          if (!ytResult.length) throw new Error('Tidak ditemukan di YouTube');
          const songs = [{
            title: info.name,
            url: ytResult[0].url,
            duration: formatDuration(info.durationInSec),
            requestedBy: requester,
            thumbnail: info.thumbnail?.url || ytResult[0].thumbnails?.[0]?.url
          }];
          setCache(cacheKey, songs);
          return songs;
        }

        if (info.type === 'playlist' || info.type === 'album') {
          const songs = [];
          for (const track of info.tracks || []) {
            await jitter(1200, 2500);
            const ytSearch = await playdl.search(
              `${track.name} ${track.artists[0].name}`,
              { source: { youtube: 'video' }, limit: 1 }
            );
            if (ytSearch.length > 0) {
              songs.push({
                title: track.name,
                url: ytSearch[0].url,
                duration: formatDuration(track.durationInSec),
                requestedBy: requester,
                thumbnail: track.thumbnail?.url || ytSearch[0].thumbnails?.[0]?.url
              });
            }
          }
          return songs; // playlist tidak di-cache
        }
      }

      // ===== YOUTUBE URL =====
      if (query.includes('youtube.com') || query.includes('youtu.be')) {
        await jitter(800, 1500);
        let info;
        for (let attempt = 0; attempt <= 3; attempt++) {
          try {
            info = await playdl.video_info(query);
            break;
          } catch (err) {
            if (err.message.includes('429') && attempt < 3) {
              const wait = (attempt + 1) * 15000;
              console.log(`⏳ 429 di video_info → tunggu ${wait / 1000}s (attempt ${attempt + 1}/3)`);
              await sleep(wait);
              continue;
            }
            throw err;
          }
        }
        const details = info.video_details;
        const songs = [{
          title: details.title,
          url: details.url,
          duration: formatDuration(details.durationInSec),
          requestedBy: requester,
          thumbnail: details.thumbnails?.[0]?.url
        }];
        setCache(cacheKey, songs);
        return songs;
      }

      // ===== SEARCH QUERY =====
      await jitter(800, 1500);
      const results = await playdl.search(query, { source: { youtube: 'video' }, limit: 1 });
      if (!results.length) return [];
      const songs = [{
        title: results[0].title,
        url: results[0].url,
        duration: formatDuration(results[0].durationInSec),
        requestedBy: requester,
        thumbnail: results[0].thumbnails?.[0]?.url
      }];
      setCache(cacheKey, songs);
      return songs;

    } catch (error) {
      console.error('[resolveSongs Error]', error.message);
      if (error.message?.includes('429') && retry < maxRetries) {
        // Exponential backoff: 16s → 32s → 64s → 128s
        const waitTime = Math.pow(2, retry + 1) * 8000;
        console.log(`⏳ Kena 429 → Tunggu ${waitTime / 1000}s (retry ${retry + 1}/${maxRetries})`);
        await sleep(waitTime);
        return resolveSongs(query, requester, retry + 1);
      }
      return [];
    }
  });
}

// ====================== GET STREAM ======================
// Urutan: yt-dlp (prioritas, paling stabil) → play-dl → ytdl-core
async function getStream(url, retry = 0) {
  const maxRetries = 2;

  // ── 1. yt-dlp (prioritas utama, paling tahan rate limit) ──
  try {
    console.log('[Stream] Mencoba yt-dlp...');
    const ytdlpArgs = {
      format: 'bestaudio[ext=webm]/bestaudio[ext=opus]/bestaudio/best',
      output: '-',
      quiet: true,
      noWarnings: true,
      noCheckCertificates: true,
      bufferSize: '16K',
    };
    if (process.env.YTDLP_COOKIE_FILE) {
      ytdlpArgs.cookies = process.env.YTDLP_COOKIE_FILE;
    } else if (process.env.YOUTUBE_COOKIE) {
      ytdlpArgs['add-header'] = `Cookie:${process.env.YOUTUBE_COOKIE.trim()}`;
    }
    const subprocess = youtubedl.exec(url, ytdlpArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
    const stream = subprocess.stdout;
    if (!stream) throw new Error('yt-dlp stdout null');
    console.log('[Stream] ✅ yt-dlp berhasil');
    return { stream, type: StreamType.Arbitrary };
  } catch (ytdlpErr) {
    console.warn('[Stream] ❌ yt-dlp gagal:', ytdlpErr.message);
  }

  // ── 2. play-dl ──
  try {
    console.log('[Stream] Mencoba play-dl...');
    await jitter(500, 1200);
    const streamData = await playdl.stream(url, { quality: 2 });
    if (!streamData?.stream) throw new Error('play-dl stream kosong');
    console.log('[Stream] ✅ play-dl berhasil, type:', streamData.type);
    return { stream: streamData.stream, type: streamData.type };
  } catch (playdlErr) {
    console.warn('[Stream] ❌ play-dl gagal:', playdlErr.message);
    if (playdlErr.message.includes('429') && retry < maxRetries) {
      const wait = (retry + 1) * 12000;
      console.log(`⏳ 429 di stream → tunggu ${wait / 1000}s (retry ${retry + 1}/${maxRetries})`);
      await sleep(wait);
      return getStream(url, retry + 1);
    }
  }

  // ── 3. @distube/ytdl-core ──
  try {
    console.log('[Stream] Mencoba ytdl-core fallback...');
    const ytdlOptions = {
      filter: 'audioonly',
      quality: 'highestaudio',
      highWaterMark: 1 << 25
    };
    if (ytdlAgent) ytdlOptions.agent = ytdlAgent;
    const stream = ytdl(url, ytdlOptions);
    console.log('[Stream] ✅ ytdl-core berhasil');
    return { stream, type: StreamType.Arbitrary };
  } catch (ytdlErr) {
    console.error('[Stream] ❌ ytdl-core juga gagal:', ytdlErr.message);
    throw new Error('Semua metode stream gagal. Coba lagi nanti.');
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

    const resource = createAudioResource(stream, {
      inputType: type,
      inlineVolume: true
    });

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
    if (oldConn) {
      oldConn.destroy();
      await sleep(800);
    }

    console.log(`[Voice] Join ke: ${voiceChannel.name}`);

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    connection.on('stateChange', (oldState, newState) => {
      console.log(`[Voice State] ${oldState.status} -> ${newState.status}`);
    });

    connection.on('error', (err) => {
      console.error('[Voice Connection Error]', err.message);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        console.log('🔄 Reconnecting voice...');
      } catch {
        console.log('❌ Destroying connection...');
        connection.destroy();
        queues.delete(guild.id);
      }
    });

    queue.connection = connection;
    connection.subscribe(queue.player);

    await entersState(connection, VoiceConnectionStatus.Ready, 40_000);
    console.log('✅ [Voice] Berhasil join voice channel!');
    return true;

  } catch (error) {
    console.error('[Voice ERROR]', error.message);
    const conn = getVoiceConnection(guild.id);
    if (conn) conn.destroy();
    queues.delete(guild.id);
    if (queue.textChannel) queue.textChannel.send('❌ Bot gagal join voice channel. Coba lagi.');
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
  if (!queue) {
    queue = createQueue();
    queues.set(message.guild.id, queue);
  }
  queue.textChannel = message.channel;

  try {
    const songs = await resolveSongs(query, message.author.tag);

    if (!songs.length) return loadingMsg.edit('❌ Lagu tidak ditemukan atau kena rate limit. Coba lagi sebentar lagi.');

    const wasEmpty = queue.songs.length === 0;
    queue.songs.push(...songs);

    if (songs.length === 1) {
      await loadingMsg.edit(`✅ **Ditambahkan:** ${songs[0].title}`);
    } else {
      await loadingMsg.edit(`✅ **Ditambahkan ${songs.length} lagu** ke antrian!`);
    }

    if (wasEmpty) {
      const connected = await startConnection(queue, voiceChannel, message.guild);
      if (connected) {
        await sleep(500);
        playSong(message.guild.id, queue);
      }
    }

  } catch (e) {
    console.error(`[cmdPlay ERROR]`, e.message);
    await loadingMsg.edit('❌ Terjadi error saat memproses perintah.');
  }
}

async function cmdSkip(message) {
  const queue = queues.get(message.guild.id);
  if (!queue || !queue.songs.length) return message.reply('❌ Tidak ada lagu yang diputar!');
  queue.player.stop();
  message.reply('⏭️ Lagu di-skip!');
}

async function cmdStop(message) {
  const queue = queues.get(message.guild.id);
  if (!queue) return message.reply('❌ Bot tidak sedang aktif!');
  queue.songs = [];
  queue.loop = false;
  queue.player.stop();
  message.reply('⏹️ Music player dihentikan!');
}

async function cmdLeave(message) {
  const queue = queues.get(message.guild.id);
  if (queue) {
    queue.player.stop(true);
    queue.connection?.destroy();
    queues.delete(message.guild.id);
  }
  message.reply('👋 Bot keluar dari voice channel!');
}

async function cmdQueue(message) {
  const queue = queues.get(message.guild.id);
  if (!queue || !queue.songs.length) return message.reply('📋 Antrian kosong!');
  const list = queue.songs.slice(0, 10)
    .map((s, i) => `${i === 0 ? '▶️' : `${i + 1}.`} ${s.title} \`[${s.duration}]\``)
    .join('\n');
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📋 Antrian Lagu')
    .setDescription(list)
    .setFooter({ text: `Total: ${queue.songs.length} lagu${queue.loop ? ' | 🔁 Loop aktif' : ''}` });
  message.reply({ embeds: [embed] });
}

async function cmdNowPlaying(message) {
  const queue = queues.get(message.guild.id);
  if (!queue || !queue.songs.length) return message.reply('❌ Tidak ada lagu yang diputar!');
  const song = queue.songs[0];
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎵 Now Playing')
    .setDescription(`**[${song.title}](${song.url})**`)
    .addFields(
      { name: '⏱️ Durasi', value: song.duration || '?', inline: true },
      { name: '👤 Request', value: song.requestedBy || 'Unknown', inline: true }
    );
  message.reply({ embeds: [embed] });
}

async function cmdPause(message) {
  const queue = queues.get(message.guild.id);
  if (!queue) return message.reply('❌ Tidak ada lagu yang diputar!');
  queue.player.pause();
  message.reply('⏸️ Lagu di-pause!');
}

async function cmdResume(message) {
  const queue = queues.get(message.guild.id);
  if (!queue) return message.reply('❌ Tidak ada lagu yang diputar!');
  queue.player.unpause();
  message.reply('▶️ Lagu dilanjutkan!');
}

async function cmdLoop(message) {
  const queue = queues.get(message.guild.id);
  if (!queue) return message.reply('❌ Tidak ada lagu yang diputar!');
  queue.loop = !queue.loop;
  message.reply(`🔁 Loop: **${queue.loop ? 'Aktif' : 'Nonaktif'}**`);
}

async function cmdHelp(message) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎵 Owo Music Bot — Daftar Perintah')
    .addFields(
      { name: '`!play <judul/link>`', value: 'Putar lagu dari YouTube/Spotify', inline: false },
      { name: '`!skip` / `!s`', value: 'Skip lagu', inline: true },
      { name: '`!stop`', value: 'Stop & clear antrian', inline: true },
      { name: '`!pause` / `!resume`', value: 'Pause / Resume', inline: true },
      { name: '`!queue` / `!q`', value: 'Lihat antrian', inline: true },
      { name: '`!np`', value: 'Lagu sekarang', inline: true },
      { name: '`!loop`', value: 'Toggle loop', inline: true },
      { name: '`!leave` / `!dc`', value: 'Keluar voice', inline: true }
    )
    .setFooter({ text: 'Owo Music Bot 🎵' });
  message.reply({ embeds: [embed] });
}

// ====================== MESSAGE HANDLER ======================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const query = args.join(' ');

  console.log(`[CMD] ${message.author.tag}: ${PREFIX}${command} ${query}`);

  switch (command) {
    case 'play':
    case 'p':
      await cmdPlay(message, query);
      break;
    case 'skip':
    case 's':
      await cmdSkip(message);
      break;
    case 'stop':
      await cmdStop(message);
      break;
    case 'leave':
    case 'dc':
      await cmdLeave(message);
      break;
    case 'queue':
    case 'q':
      await cmdQueue(message);
      break;
    case 'np':
    case 'nowplaying':
      await cmdNowPlaying(message);
      break;
    case 'pause':
      await cmdPause(message);
      break;
    case 'resume':
      await cmdResume(message);
      break;
    case 'loop':
      await cmdLoop(message);
      break;
    case 'help':
      await cmdHelp(message);
      break;
  }
});

// ====================== LOGIN ======================
client.login(process.env.TOKEN);
