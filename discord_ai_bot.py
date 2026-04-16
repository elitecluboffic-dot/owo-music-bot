import discord
from discord.ext import commands
import google.generativeai as genai
import os
from datetime import datetime

# ============================================================
#  KONFIGURASI
# ============================================================
DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

AI_NAME = "Jarvis"
AI_PERSONALITY = """Kamu adalah Jarvis, asisten AI yang cerdas, ramah, dan sedikit humoris.
Kamu menjawab dalam bahasa yang sama dengan pengguna (Indonesia atau Inggris).
Jawaban kamu singkat, padat, dan mudah dipahami. Gunakan emoji secukupnya."""

PREFIX = "!"
# ============================================================

# Setup Gemini
genai.configure(api_key=GEMINI_API_KEY)
model = genai.GenerativeModel(
    model_name="gemini-2.0-flash",
    system_instruction=AI_PERSONALITY
)

# Setup Discord
intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(command_prefix=PREFIX, intents=intents, help_command=None)

# Riwayat percakapan per user
conversation_history: dict[int, list] = {}
MAX_HISTORY = 10


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
    else:
        await ctx.reply(f"❌ Terjadi error: `{str(error)}`")


@bot.command(name="ai", aliases=["tanya", "ask"])
async def ai_command(ctx, *, pertanyaan: str):
    user_id = ctx.author.id

    async with ctx.typing():
        try:
            if user_id not in conversation_history:
                conversation_history[user_id] = []

            conversation_history[user_id].append({
                "role": "user",
                "parts": [pertanyaan]
            })

            history = conversation_history[user_id][-MAX_HISTORY:]
            chat = model.start_chat(history=history[:-1])
            response = chat.send_message(pertanyaan)
            jawaban = response.text

            conversation_history[user_id].append({
                "role": "model",
                "parts": [jawaban]
            })

            if len(conversation_history[user_id]) > MAX_HISTORY * 2:
                conversation_history[user_id] = conversation_history[user_id][-MAX_HISTORY:]

            embed = discord.Embed(
                description=jawaban,
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

            if len(jawaban) > 4000:
                chunks = [jawaban[i:i+1990] for i in range(0, len(jawaban), 1990)]
                await ctx.reply(f"🤖 **{AI_NAME}:** (jawaban panjang)")
                for chunk in chunks:
                    await ctx.send(chunk)
            else:
                await ctx.reply(embed=embed)

        except Exception as e:
            await ctx.reply(f"❌ **Terjadi error:** `{str(e)}`")


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
    embed.set_footer(text=f"Powered by Gemini AI • {bot.user}")
    await ctx.reply(embed=embed)


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


@bot.command(name="info")
async def info(ctx):
    embed = discord.Embed(
        title=f"ℹ️ Info {AI_NAME}",
        color=discord.Color.blurple(),
        timestamp=datetime.now()
    )
    embed.add_field(name="🤖 Nama", value=AI_NAME, inline=True)
    embed.add_field(name="🧠 Model AI", value="Gemini 2.0 Flash (Google)", inline=True)
    embed.add_field(name="📡 Server", value=f"{len(bot.guilds)}", inline=True)
    embed.add_field(name="👥 Users", value=f"{len(bot.users)}", inline=True)
    embed.add_field(name="🔧 Prefix", value=f"`{PREFIX}`", inline=True)
    embed.add_field(name="📜 Commands", value=f"`{PREFIX}help`", inline=True)
    embed.set_thumbnail(url=bot.user.display_avatar.url)
    embed.set_footer(text="Powered by Gemini AI")
    await ctx.reply(embed=embed)


if __name__ == "__main__":
    print("🚀 Menjalankan bot...")
    bot.run(DISCORD_TOKEN)
