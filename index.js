// ====================== SETUP FFMPEG & SODIUM ======================
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

// ====================== YOUTUBE COOKIES DARI ENV (PALING AMAN UNTUK RAILWAY) ======================
function loadYouTubeCookies() {
  const cookie = process.env.YOUTUBE_COOKIE?.trim();

  if (!cookie) {
    console.log('⚠️ YOUTUBE_COOKIE belum diisi di Railway Variables!');
    console.log('💡 Silakan tambahkan di Variables Railway');
    return;
  }

  if (cookie.length < 400) {
    console.log(`⚠️ Cookie terlalu pendek (${cookie.length} char)`);
    return;
  }

  try {
    playdl.setToken({ youtube: { cookie: cookie } });
    console.log(`✅ YouTube cookies BERHASIL dimuat dari ENV! (${cookie.length} karakter)`);
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
    } else {
      console.log('⚠️ SPOTIFY env tidak lengkap (hanya YouTube aktif)');
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

// ====================== MESSAGE HANDLER ======================
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const query = args.join(' ');

  switch (command) {
    case 'play': case 'p': await cmdPlay(message, query); break;
    case 'skip': case 's': await cmdSkip(message); break;
    case 'stop': await cmdStop(message); break;
    case 'queue': case 'q': await cmdQueue(message); break;
    case 'nowplaying': case 'np': await cmdNowPlaying(message); break;
    case 'pause': await cmdPause(message); break;
    case 'resume': await cmdResume(message); break;
    case 'loop': await cmdLoop(message); break;
    case 'leave': case 'dc': await cmdLeave(message); break;
    case 'help': await cmdHelp(message); break;
  }
});

// ====================== START CONNECTION ======================
async function startConnection(queue, voiceChannel, guild) {
  const oldConn = getVoiceConnection(guild.id);
  if (oldConn) oldConn.destroy();

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  queue.connection = connection;
  connection.subscribe(queue.player);

  console.log(`[Voice] Mencoba join ke: ${voiceChannel.name}`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[Voice Attempt ${attempt}/3]`);
      await entersState(connection, VoiceConnectionStatus.Ready, 35_000);
      console.log('✅ [Voice] BERHASIL terkoneksi!');
      return true;
    } catch (e) {
      console.log(`[Voice Attempt ${attempt}] Gagal: ${e.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.error('[Voice] GAGAL setelah 3 attempt');
  connection.destroy();
  queues.delete(guild.id);
  if (queue.textChannel) queue.textChannel.send('❌ Gagal join voice channel.');
  return false;
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

    const stream = await playdl.stream(song.url, {
      quality: 2,
      discordPlayerCompatibility: true
    });

    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
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
    if (queue.textChannel) {
      queue.textChannel.send(`⚠️ Error memutar **${song.title}**, skip...`);
    }
    queue.songs.shift();
    playSong(guildId, queue);
  }
}

// ====================== RESOLVE SONGS (SUDAH DIFIX) ======================
async function resolveSongs(query, requester) {
  try {
    if (playdl.is_expired() && process.env.SPOTIFY_CLIENT_ID) {
      await loginSpotify();
    }

    // Spotify
    if (query.includes('spotify.com')) {
      const info = await playdl.spotify(query);

      if (info.type === 'track') {
        const ytResult = await playdl.search(`${info.name} ${info.artists[0].name}`, { source: "youtube", limit: 1 });
        if (ytResult.length === 0) throw new Error("Tidak ditemukan di YouTube");

        return [{
          title: info.name,
          url: ytResult[0].url,
          duration: formatDuration(info.duration),
          requestedBy: requester,
          thumbnail: info.thumbnail?.url || ytResult[0].thumbnail
        }];
      }

      if (info.type === 'playlist' || info.type === 'album') {
        const tracks = await playdl.spotify(query, { limit: 50 });
        const songs = [];

        for (const track of tracks) {
          const ytSearch = await playdl.search(`${track.name} ${track.artists[0].name}`, { source: "youtube", limit: 1 });
          if (ytSearch.length > 0) {
            songs.push({
              title: track.name,
              url: ytSearch[0].url,
              duration: formatDuration(track.duration),
              requestedBy: requester,
              thumbnail: track.thumbnail?.url || ytSearch[0].thumbnail
            });
          }
        }
        return songs;
      }
    }

    // YouTube Link
    if (query.includes('youtube.com') || query.includes('youtu.be')) {
      const info = await playdl.video_info(query);
      return [{
        title: info.title,
        url: info.url,
        duration: formatDuration(info.durationInSec),
        requestedBy: requester,
        thumbnail: info.thumbnail
      }];
    }

    // Search Biasa
    const results = await playdl.search(query, { source: "youtube", limit: 1 });
    if (results.length === 0) return [];

    return [{
      title: results[0].title,
      url: results[0].url,
      duration: formatDuration(results[0].durationInSec),
      requestedBy: requester,
      thumbnail: results[0].thumbnail
    }];

  } catch (error) {
    console.error('[resolveSongs Error]', error.message);
    return [];
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
    if (!songs.length) return loadingMsg.edit('❌ Lagu tidak ditemukan!');

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

// Skip, Stop, Leave, Queue, NP, Pause, Resume, Loop, Help
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
