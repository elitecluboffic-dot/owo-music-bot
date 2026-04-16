import discord
from discord.ext import commands
import anthropic
import asyncio
from datetime import datetime

# ============================================================
#  KONFIGURASI - ISI DI SINI
# ============================================================
DISCORD_TOKEN = "TOKEN_BOT_DISCORD_KAMU_DI_SINI"
ANTHROPIC_API_KEY = "API_KEY_ANTHROPIC_KAMU_DI_SINI"

# Nama & kepribadian AI kamu
AI_NAME = "Jarvis"
AI_PERSONALITY = """Kamu adalah Jarvis, asisten AI yang cerdas, ramah, dan sedikit humoris.
Kamu menjawab dalam bahasa yang sama dengan pengguna (Indonesia atau Inggris).
Jawaban kamu singkat, padat, dan mudah dipahami. Gunakan emoji secukupnya."""

# Prefix command
PREFIX = "!"
# ============================================================

# Setup intents
intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(command_prefix=PREFIX, intents=intents, help_command=None)

# Anthropic client
ai_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

# Riwayat percakapan per user (opsional, biar konteks nyambung)
conversation_history: dict[int, list] = {}
MAX_HISTORY = 10  # Maksimal pesan yang disimpan per user


# ============================================================
#  EVENTS
# ============================================================

@bot.event
async def on_ready():
    print("=" * 50)
    print(f"✅ Bot aktif sebagai: {bot.user}")
    print(f"🤖 AI Name: {AI_NAME}")
    print(f"📡 Terhubung ke {len(bot.guilds)} server")
    print(f"🕐 Waktu: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 50)
    await bot.change_presence(
        activity=discord.Activity(
            type=discord.ActivityType.listening,
            name=f"{PREFIX}ai <pertanyaan>"
        )
    )


@bot.event
async def on_command_error(ctx, error):
    if isinstance(error, commands.CommandNotFound):
        return  # Abaikan command yang tidak ada
    elif isinstance(error, commands.MissingRequiredArgument):
        await ctx.reply(f"❌ Kurang argumen! Contoh: `{PREFIX}ai halo siapa kamu?`")
    else:
        await ctx.reply(f"❌ Terjadi error: `{str(error)}`")


# ============================================================
#  COMMANDS
# ============================================================

@bot.command(name="ai", aliases=["tanya", "ask"])
async def ai_command(ctx, *, pertanyaan: str):
    """Tanya AI apapun yang kamu mau!"""
    
    user_id = ctx.author.id
    
    # Typing indicator biar keliatan lagi "mikir"
    async with ctx.typing():
        try:
            # Ambil history user
            if user_id not in conversation_history:
                conversation_history[user_id] = []
            
            # Tambahkan pesan user ke history
            conversation_history[user_id].append({
                "role": "user",
                "content": pertanyaan
            })
            
            # Panggil Anthropic API
            response = ai_client.messages.create(
                model="claude-opus-4-5",
                max_tokens=1024,
                system=AI_PERSONALITY,
                messages=conversation_history[user_id][-MAX_HISTORY:]  # Batasi history
            )
            
            jawaban = response.content[0].text
            
            # Simpan jawaban AI ke history
            conversation_history[user_id].append({
                "role": "assistant",
                "content": jawaban
            })
            
            # Potong history jika terlalu panjang
            if len(conversation_history[user_id]) > MAX_HISTORY * 2:
                conversation_history[user_id] = conversation_history[user_id][-MAX_HISTORY:]
            
            # Buat embed yang keren
            embed = discord.Embed(
                description=jawaban,
                color=discord.Color.blurple(),
                timestamp=datetime.now()
            )
            embed.set_author(
                name=f"🤖 {AI_NAME}",
                icon_url=bot.user.display_avatar.url
            )
            embed.add_field(
                name="❓ Pertanyaan",
                value=f"```{pertanyaan[:200]}{'...' if len(pertanyaan) > 200 else ''}```",
                inline=False
            )
            embed.set_footer(
                text=f"Ditanya oleh {ctx.author.display_name} • {PREFIX}reset untuk hapus riwayat",
                icon_url=ctx.author.display_avatar.url
            )
            
            # Jika jawaban terlalu panjang untuk embed, kirim sebagai teks biasa
            if len(jawaban) > 4000:
                chunks = [jawaban[i:i+1990] for i in range(0, len(jawaban), 1990)]
                await ctx.reply(f"🤖 **{AI_NAME}:** (jawaban panjang)")
                for chunk in chunks:
                    await ctx.send(chunk)
            else:
                await ctx.reply(embed=embed)
                
        except anthropic.AuthenticationError:
            await ctx.reply("❌ **API Key Anthropic tidak valid!** Cek konfigurasi bot.")
        except anthropic.RateLimitError:
            await ctx.reply("⏳ **Rate limit tercapai.** Coba lagi sebentar ya!")
        except Exception as e:
            await ctx.reply(f"❌ **Terjadi error:** `{str(e)}`")


@bot.command(name="reset", aliases=["clear", "hapus"])
async def reset_history(ctx):
    """Reset riwayat percakapan dengan AI"""
    user_id = ctx.author.id
    if user_id in conversation_history:
        conversation_history.pop(user_id)
    
    embed = discord.Embed(
        description=f"✅ Riwayat percakapanmu dengan **{AI_NAME}** sudah direset!",
        color=discord.Color.green()
    )
    await ctx.reply(embed=embed)


@bot.command(name="help", aliases=["bantuan", "cmd"])
async def help_command(ctx):
    """Tampilkan daftar command"""
    embed = discord.Embed(
        title=f"🤖 {AI_NAME} — Daftar Command",
        color=discord.Color.blurple(),
        timestamp=datetime.now()
    )
    
    commands_list = [
        (f"`{PREFIX}ai <pertanyaan>`", "Tanya AI apapun yang kamu mau"),
        (f"`{PREFIX}tanya <pertanyaan>`", "Alias untuk `!ai`"),
        (f"`{PREFIX}reset`", "Hapus riwayat percakapan dengan AI"),
        (f"`{PREFIX}help`", "Tampilkan pesan ini"),
        (f"`{PREFIX}ping`", "Cek latensi bot"),
        (f"`{PREFIX}info`", "Info tentang bot"),
    ]
    
    for name, value in commands_list:
        embed.add_field(name=name, value=value, inline=False)
    
    embed.set_footer(text=f"Powered by Claude AI • {bot.user}")
    await ctx.reply(embed=embed)


@bot.command(name="ping")
async def ping(ctx):
    """Cek latensi bot"""
    latency = round(bot.latency * 1000)
    
    if latency < 100:
        color = discord.Color.green()
        status = "🟢 Excellent"
    elif latency < 200:
        color = discord.Color.yellow()
        status = "🟡 Good"
    else:
        color = discord.Color.red()
        status = "🔴 Slow"
    
    embed = discord.Embed(
        title="🏓 Pong!",
        description=f"**Latensi:** `{latency}ms` — {status}",
        color=color
    )
    await ctx.reply(embed=embed)


@bot.command(name="info")
async def info(ctx):
    """Info tentang bot"""
    embed = discord.Embed(
        title=f"ℹ️ Info {AI_NAME}",
        color=discord.Color.blurple(),
        timestamp=datetime.now()
    )
    embed.add_field(name="🤖 Nama", value=AI_NAME, inline=True)
    embed.add_field(name="🧠 Model AI", value="Claude (Anthropic)", inline=True)
    embed.add_field(name="📡 Server", value=f"{len(bot.guilds)}", inline=True)
    embed.add_field(name="👥 Users", value=f"{len(bot.users)}", inline=True)
    embed.add_field(name="🔧 Prefix", value=f"`{PREFIX}`", inline=True)
    embed.add_field(name="📜 Commands", value=f"`{PREFIX}help`", inline=True)
    embed.set_thumbnail(url=bot.user.display_avatar.url)
    embed.set_footer(text=f"Powered by Claude AI")
    await ctx.reply(embed=embed)


# ============================================================
#  JALANKAN BOT
# ============================================================
if __name__ == "__main__":
    print("🚀 Menjalankan bot...")
    bot.run(DISCORD_TOKEN)
