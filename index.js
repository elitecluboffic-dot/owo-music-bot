// ====================== SETUP FFMPEG ======================
process.env.FFMPEG_PATH = require('ffmpeg-static');

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  NoSubscriberBehavior
} = require('@discordjs/voice');

const playdl = require('play-dl');
const fs = require('fs');

// ====================== YOUTUBE COOKIES (Support Netscape) ======================
function loadYouTubeCookies() {
  let cookieInput = process.env.YOUTUBE_COOKIE?.trim();

  if (!cookieInput) {
    console.log('⚠️ YOUTUBE_COOKIE belum diisi di Railway Variables!');
    return;
  }

  // Deteksi Netscape format
  if (cookieInput.includes('.youtube.com') || cookieInput.includes('Netscape')) {
    console.log('🔄 Mendeteksi format Netscape cookies.txt... parsing...');
    const lines = cookieInput.split('\n');
    const cookieParts = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 7) continue;

      const name = parts[5];
      const value = parts[6];

      if (['SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
           '__Secure-1PSID', '__Secure-3PSID',
           '__Secure-1PAPISID', '__Secure-3PAPISID',
           '__Secure-1PSIDTS', '__Secure-3PSIDTS',
           '__Secure-1PSIDCC', '__Secure-3PSIDCC'].includes(name)) {
        cookieParts.push(`${name}=${value}`);
      }
    }

    cookieInput = cookieParts.join('; ');
    console.log(`✅ Parse Netscape berhasil → ${cookieParts.length} cookie diambil`);
  }

  if (cookieInput.length < 500) {
    console.log(`⚠️ Cookie terlalu pendek (${cookieInput.length} char)`);
    return;
  }

  try {
    playdl.setToken({ youtube: { cookie: cookieInput } });
    console.log(`✅ YouTube cookies BERHASIL dimuat dari ENV! (${cookieInput.length} karakter)`);
  } catch (err) {
    console.error('❌ Error set cookie:', err.message);
  }
}
loadYouTubeCookies();

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

// ====================== QUEUE FACTORY ======================
function createQueue() {
  return {
    songs: [],
    player: createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    }),
    connection: null,
    textChannel: null,
    volume: 1,
    loop: false
  };
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
  } catch (e) {
    console.log('⚠️ Spotify gagal login:', e.message);
  }
}

// ====================== BOT READY ======================
client.once('clientReady', async () => {
  console.log(`✅ Owo Music Bot Online! (${client.user.tag})`);
  client.user.setActivity('🎵 !play <lagu>', { type: 2 });
  await loginSpotify();
});

// ====================== HELPER DELAY ======================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ====================== RESOLVE SONGS (ANTI 429) ======================
async function resolveSongs(query, requester, retry = 0) {
  const maxRetries = 4;
  try {
    await sleep(650);
    if (playdl.is_expired() && process.env.SPOTIFY_CLIENT_ID) await loginSpotify();

    if (query.includes('spotify.com')) {
      const info = await playdl.spotify(query);
      if (info.type === 'track') {
        await sleep(900);
        const ytResult = await playdl.search(`${info.name} ${info.artists[0].name}`, { source: "youtube", limit: 1 });
        if (ytResult.length === 0) throw new Error("Tidak ditemukan di YouTube");
        return [{ title: info.name, url: ytResult[0].url, duration: formatDuration(info.duration), requestedBy: requester, thumbnail: info.thumbnail?.url || ytResult[0].thumbnail }];
      }
      if (info.type === 'playlist' || info.type === 'album') {
        const tracks = await playdl.spotify(query, { limit: 50 });
        const songs = [];
        for (const track of tracks) {
          await sleep(850);
          const ytSearch = await playdl.search(`${track.name} ${track.artists[0].name}`, { source: "youtube", limit: 1 });
          if (ytSearch.length > 0) {
            songs.push({ title: track.name, url: ytSearch[0].url, duration: formatDuration(track.duration), requestedBy: requester, thumbnail: track.thumbnail?.url || ytSearch[0].thumbnail });
          }
        }
        return songs;
      }
    }

    if (query.includes('youtube.com') || query.includes('youtu.be')) {
      await sleep(800);
      const info = await playdl.video_info(query);
      return [{ title: info.title, url: info.url, duration: formatDuration(info.durationInSec), requestedBy: requester, thumbnail: info.thumbnail }];
    }

    await sleep(750);
    const results = await playdl.search(query, { source: "youtube", limit: 1 });
    if (results.length === 0) return [];
    return [{ title: results[0].title, url: results[0].url, duration: formatDuration(results[0].durationInSec), requestedBy: requester, thumbnail: results[0].thumbnail }];

  } catch (error) {
    console.error('[resolveSongs Error]', error.message);
    if (error.message.includes('429') && retry < maxRetries) {
      const waitTime = (retry + 1) * 10000;
      console.log(`⏳ Kena 429 → Tunggu ${waitTime/1000} detik (retry ${retry + 1}/${maxRetries})`);
      await sleep(waitTime);
      return resolveSongs(query, requester, retry + 1);
    }
    return [];
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
    await sleep(850);
    const stream = await playdl.stream(song.url, { quality: 2, discordPlayerCompatibility: true });

    const resource = createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: true });
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

// ====================== START CONNECTION (FIXED) ======================
async function startConnection(queue, voiceChannel, guild) {
  try {
    const oldConn = getVoiceConnection(guild.id);
    if (oldConn) oldConn.destroy();

    console.log(`[Voice] Mencoba join ke: ${voiceChannel.name} (${voiceChannel.id})`);

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    queue.connection = connection;
    connection.subscribe(queue.player);

    console.log('[Voice] Menunggu status Ready...');
    await entersState(connection, VoiceConnectionStatus.Ready, 45_000); // timeout lebih panjang

    console.log('✅ [Voice] BERHASIL terkoneksi!');
    return true;

  } catch (e) {
    console.error('[Voice Error] Gagal join voice:', e.message);

    const conn = getVoiceConnection(guild.id);
    if (conn) conn.destroy();

    queues.delete(guild.id);

    if (queue.textChannel) {
      queue.textChannel.send('❌ Bot gagal masuk voice channel. Pastikan bot punya izin "Connect" dan "Speak".');
    }
    return false;
  }
}

// ====================== COMMANDS ======================
async function cmdPlay(message, query) {
  if (!query) return message.reply('❌ Masukkan judul lagu atau link!\n`!play <judul / link>`');

  const voiceChannel = message.member?.voice.channel;
  if (!voiceChannel) return message.reply('❌ Kamu harus join voice channel dulu!');

  const loadingMsg = await message.reply('🔍 Mencari lagu...');

  let queue = queues.get(message.guild.id);
  if (!queue) {
    queue = createQueue();
    queues.set(message.guild.id, queue);
  }
  queue.textChannel = message.channel;

  try {
    const songs = await resolveSongs(query, message.author.tag);
    if (!songs.length) {
      return loadingMsg.edit('❌ Lagu tidak ditemukan atau kena rate limit!');
    }

    const wasEmpty = queue.songs.length === 0;
    queue.songs.push(...songs);

    if (songs.length === 1) {
      await loadingMsg.edit(`✅ **Ditambahkan:** ${songs[0].title}`);
    } else {
      await loadingMsg.edit(`✅ **Ditambahkan ${songs.length} lagu** ke antrian!`);
    }

    if (wasEmpty) {
      const connected = await startConnection(queue, voiceChannel, message.guild);
      if (connected) playSong(message.guild.id, queue);
    }
  } catch (e) {
    console.error('[cmdPlay Error]', e);
    await loadingMsg.edit('❌ Terjadi error saat mencari lagu.');
  }
}

// Skip, Stop, Leave, Queue, NP, Pause, Resume, Loop, Help (tetap sama seperti kode kamu)
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

// ====================== UTILS ======================
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ====================== LOGIN ======================
client.login(process.env.TOKEN);
