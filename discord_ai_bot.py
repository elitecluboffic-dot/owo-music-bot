import discord
from discord.ext import commands
from groq import Groq
import os
import asyncio
from datetime import datetime

# ============================================================
#  KONFIGURASI
# ============================================================
DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")

AI_NAME = "Jarvis"
AI_PERSONALITY = """Kamu adalah Jarvis, asisten AI yang cerdas, ramah, dan sedikit humoris.
Kamu menjawab dalam bahasa yang sama dengan pengguna (Indonesia atau Inggris).
Jawaban kamu singkat, padat, dan mudah dipahami. Gunakan emoji secukupnya."""

PREFIX = "!"
MAX_HISTORY = 6
MAX_RETRIES = 3
COOLDOWN_RATE = 3
COOLDOWN_PER = 60
MODEL_NAME = "llama-3.3-70b-versatile"
# ============================================================

# Setup Groq
client = Groq(api_key=GROQ_API_KEY)

# Setup Discord
intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(command_prefix=PREFIX, intents=intents, help_command=None)

# Riwayat percakapan per user
conversation_history: dict[int, list] = {}


# ============================================================
#  CUSTOM EXCEPTION
# ============================================================
class RateLimitError(Exception):
    def __init__(self, retry_after):
        self.retry_after = retry_after


# ============================================================
#  HELPER: Kirim ke Groq dengan retry otomatis
# ============================================================
async def ask_groq(history: list, pertanyaan: str) -> str:
    for attempt in range(MAX_RETRIES):
        try:
            # Bangun messages dengan system prompt
            messages = [{"role": "system", "content": AI_PERSONALITY}]

            # Tambah history
            for msg in history:
                messages.append({
                    "role": msg["role"],
                    "content": msg["content"]
                })

            response = await asyncio.to_thread(
                client.chat.completions.create,
                model=MODEL_NAME,
                messages=messages,
                max_tokens=1024,
                temperature=0.7,
            )
            return response.choices[0].message.content

        except Exception as e:
            err_str = str(e)
            print(f"[ERROR] Attempt {attempt + 1}: {err_str}")
            if "429" in err_str or "rate_limit" in err_str.lower():
                if attempt < MAX_RETRIES - 1:
                    wait = 15 * (attempt + 1)
                    await asyncio.sleep(wait)
                    continue
                else:
                    raise RateLimitError(None)
            else:
                raise e


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
        return
    elif isinstance(error, commands.MissingRequiredArgument):
        await ctx.reply(f"❌ Kurang argumen! Contoh: `{PREFIX}ai halo siapa kamu?`")
    elif isinstance(error, commands.CommandOnCooldown):
        await ctx.reply(
            f"⏳ Pelan-pelan! Kamu terlalu banyak request.\n"
            f"Coba lagi dalam **{error.retry_after:.0f} detik**."
        )
    else:
        await ctx.reply(f"❌ Terjadi error: `{str(error)}`")


# ============================================================
#  COMMAND: !ai
# ============================================================
@bot.command(name="ai", aliases=["tanya", "ask"])
@commands.cooldown(rate=COOLDOWN_RATE, per=COOLDOWN_PER, type=commands.BucketType.user)
async def ai_command(ctx, *, pertanyaan: str):
    user_id = ctx.author.id

    async with ctx.typing():
        try:
            # Init history user
            if user_id not in conversation_history:
                conversation_history[user_id] = []

            # Tambah pesan user ke history
            conversation_history[user_id].append({
                "role": "user",
                "content": pertanyaan
            })

            # Ambil history terbatas
            history = conversation_history[user_id][-MAX_HISTORY:]

            # Kirim ke Groq
            jawaban = await ask_groq(history, pertanyaan)

            # Simpan jawaban ke history
            conversation_history[user_id].append({
                "role": "assistant",
                "content": jawaban
            })

            # Trim history
            if len(conversation_history[user_id]) > MAX_HISTORY * 2:
                conversation_history[user_id] = conversation_history[user_id][-MAX_HISTORY:]

            # Buat embed
            embed = discord.Embed(
                description=jawaban[:4096],
                color=discord.Color.blurple(),
                timestamp=datetime.now()
            )
            embed.set_author(name=f"🤖 {AI_NAME}", icon_url=bot.user.display_avatar.url)
            embed.add_field(
                name="❓ Pertanyaan",
                value=f"```{pertanyaan[:200]}{'...' if len(pertanyaan) > 200 else ''}```",
                inline=False
            )
            embed.set_footer(
                text=f"Ditanya oleh {ctx.author.display_name} • {PREFIX}reset untuk hapus riwayat",
                icon_url=ctx.author.display_avatar.url
            )

            # Kirim (handle jawaban panjang)
            if len(jawaban) > 4000:
                chunks = [jawaban[i:i+1990] for i in range(0, len(jawaban), 1990)]
                await ctx.reply(f"🤖 **{AI_NAME}:** (jawaban panjang)")
                for chunk in chunks:
                    await ctx.send(chunk)
            else:
                await ctx.reply(embed=embed)

        except RateLimitError:
            await ctx.reply(
                "❌ **Rate limit Groq tercapai!**\n"
                "Coba lagi dalam beberapa menit 🙏"
            )

        except Exception as e:
            await ctx.reply(f"❌ **Terjadi error:** `{str(e)[:500]}`")


# ============================================================
#  COMMAND: !reset
# ============================================================
@bot.command(name="reset", aliases=["clear", "hapus"])
async def reset_history(ctx):
    user_id = ctx.author.id
    if user_id in conversation_history:
        conversation_history.pop(user_id)
    embed = discord.Embed(
        description=f"✅ Riwayat percakapanmu dengan **{AI_NAME}** sudah direset!",
        color=discord.Color.green()
    )
    await ctx.reply(embed=embed)


# ============================================================
#  COMMAND: !help
# ============================================================
@bot.command(name="help", aliases=["bantuan", "cmd"])
async def help_command(ctx):
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
    embed.set_footer(text=f"Powered by Groq AI • {bot.user}")
    await ctx.reply(embed=embed)


# ============================================================
#  COMMAND: !ping
# ============================================================
@bot.command(name="ping")
async def ping(ctx):
    latency = round(bot.latency * 1000)
    if latency < 100:
        color, status = discord.Color.green(), "🟢 Excellent"
    elif latency < 200:
        color, status = discord.Color.yellow(), "🟡 Good"
    else:
        color, status = discord.Color.red(), "🔴 Slow"
    embed = discord.Embed(
        title="🏓 Pong!",
        description=f"**Latensi:** `{latency}ms` — {status}",
        color=color
    )
    await ctx.reply(embed=embed)


# ============================================================
#  COMMAND: !info
# ============================================================
@bot.command(name="info")
async def info(ctx):
    embed = discord.Embed(
        title=f"ℹ️ Info {AI_NAME}",
        color=discord.Color.blurple(),
        timestamp=datetime.now()
    )
    embed.add_field(name="🤖 Nama", value=AI_NAME, inline=True)
    embed.add_field(name="🧠 Model AI", value="Llama 3.3 70B (Groq)", inline=True)
    embed.add_field(name="📡 Server", value=f"{len(bot.guilds)}", inline=True)
    embed.add_field(name="👥 Users", value=f"{len(bot.users)}", inline=True)
    embed.add_field(name="🔧 Prefix", value=f"`{PREFIX}`", inline=True)
    embed.add_field(name="📜 Commands", value=f"`{PREFIX}help`", inline=True)
    embed.set_thumbnail(url=bot.user.display_avatar.url)
    embed.set_footer(text="Powered by Groq AI")
    await ctx.reply(embed=embed)


# ============================================================
if __name__ == "__main__":
    print("🚀 Menjalankan bot...")
    bot.run(DISCORD_TOKEN)
