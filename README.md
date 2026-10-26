# Discord Channel Emoji Reactor

A small Discord.js app that runs five bot accounts. All five add the server's
custom `:haha:` emoji to every new message in one configured text channel per
server. The configuration is saved in `config.json` and remains after
restarting the bots.

## Setup

1. Install Node.js 20 or newer.
2. Create a Discord application and bot in the Discord Developer Portal.
3. Put all five bot tokens and the primary bot's application ID in `.env`:

   ```env
   DISCORD_TOKEN=primary_bot_token
   DISCORD_TOKEN_2=second_bot_token
   DISCORD_TOKEN_3=third_bot_token
   DISCORD_TOKEN_4=fourth_bot_token
   DISCORD_TOKEN_5=fifth_bot_token
   DISCORD_CLIENT_ID=your_application_client_id
   GEMINI_API_KEY=your_google_ai_studio_api_key
   ```

4. Invite all five bots to each server where they should react. Give each bot
   View Channel, Read Message History, Add Reactions, and Send Messages in the
   target channel. The primary bot also needs the `applications.commands`
   scope; only it registers slash commands. In the Discord Developer Portal,
   enable the **Message Content Intent** for Bot 1 and Bot 5: Bot 1 handles
   `.rr` and direct Ruta mentions, while Bot 5 handles direct Xin mentions.
   Bots 2–4 do not need that privileged intent. No bot needs the Server
   Members privileged intent.
5. From this folder, run:

   ```sh
   npm install
   npm start
   ```

The app also serves a plain-text health status at `/` using Node's built-in
HTTP server. It listens on Render's `PORT` environment variable (or port 3000
when running locally), so you can visit the Render service URL to check how many
of the five Discord bots are connected. Configure `ryvoxbot.onrender.com` as a
custom domain in Render if you want that specific address.

## Configure a server

The `adminUserIds` array in `config.json` controls who can use the bot's admin
slash commands. It currently contains `766135407590244383` and
`1514233018284380263`; edit this array to change the admins. Both users can use
`/setreaction`, `/ai`, `/autoreactor`, `/reply`, `/sendmessage`, and `/sendas`
through the primary bot.
Select a text channel with `/setreaction`, and all five bots will use that
server's custom emoji named `haha`. The emoji must exist in the server, and all
five bot accounts must be members of that server. Only the primary bot
registers the slash commands.
`/setreaction` also starts a scan of existing messages in the selected channel;
each bot checks its own reactions and adds any missing ones. On later restarts
the bots scan the configured channel history again. This requires each bot to
have View Channel, Read Message History, and Add Reactions. Large histories can
take time because each bot processes reactions while respecting Discord's rate
limits. Settings are separate for each server.

Use `/ai enabled:true` or `/ai enabled:false` to turn Ruta and Xin's AI replies
on or off for the current server. The setting is saved across restarts and does
not affect the five bots' automatic reactions. Only IDs listed in
`config.json`'s `adminUserIds` can use this command.

Automatic reactions are off by default, including after a restart, until an
admin explicitly enables them. Use `/autoreactor enabled:true` to turn on
automatic reactions for all five bots in this server, or
`/autoreactor enabled:false` to turn them off. This setting is saved across
restarts; when enabled, each bot also checks existing messages on startup or
after `/setreaction`.

Use `/reply` to choose a channel, paste a message link or ID, select one of the
five bot accounts, and enter the reply text. Use `/sendmessage` to have all
five bots post the same text in the channel configured with `/setreaction`.
Use `/sendas` to choose a channel, select Ruta (Bot 1), Bot 2, Bot 3, Bot 4, or
Xin (Bot 5), and send a custom message as just that bot. The selected bot must
be online, in the server, and have permission to send messages in the channel.
Messages are submitted concurrently; Discord.js handles API rate limits.
Replies and sent messages are posted by the bot accounts, not a human account.

Send a message beginning with `.rr` (for example `.rr kumusta ka?` or
`.rrkumusta ka?`), or mention the primary bot (for example `@Ruta hoy gago`),
to get a short Ruta-style reply. It appears as a real reply to the original
message. The bot shows and refreshes Discord's typing indicator while waiting
for Gemini, then streams the response into the reply. It uses the
`gemini-3.5-flash-lite` model with minimal thinking. Each user has a short
cooldown to limit Gemini API usage.

Mention Bot 5 (`@Xin`) to get a reply using the separate softboy personality in
`src/xin-personality.js`; its generated text also streams into a reply to your
message using `gemini-3.1-flash-lite` with minimal thinking. Replies to either
bot do not trigger a new mention response.
Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey)
and put it in `GEMINI_API_KEY` in `.env`.

Keep `.env` private; it contains all five bot tokens and your Gemini API key.
All five bots must be online to add five reactions to new messages.
