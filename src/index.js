require("dotenv").config();

const {
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const { GoogleGenAI, ThinkingLevel } = require("@google/genai");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const personality = require("./personality");
const xinPersonality = require("./xin-personality");

const { DISCORD_CLIENT_ID, GEMINI_API_KEY } = process.env;
const AI_USER_COOLDOWN_MS = 5000;
const DEVELOPER_USER_ID = "766135407590244383";
const LIMITED_ADMIN_USER_ID = "1514233018284380263";
const LIMITED_ADMIN_COMMANDS = new Set(["ai", "autoreactor"]);
const HARDCODED_REACTION_CLEANUP_USER_IDS = new Set([
  "1440726415229325413",
  "1442844979558088805",
  "1528054997646970930",
  "1539237818533019703",
  "1451960695406067795",
  "1498809601263407166",
  "1564216124848218145",
  "1452602497955795085",
]);
const botTokens = [
  process.env.DISCORD_TOKEN,
  process.env.DISCORD_TOKEN_2,
  process.env.DISCORD_TOKEN_3,
  process.env.DISCORD_TOKEN_4,
  process.env.DISCORD_TOKEN_5,
];
const CONFIG_PATH = path.join(__dirname, "..", "config.json");
const REACTION_EMOJI_NAME = "haha";
const tokenIsConfigured = (token) => token && !/^(?:put_|your_)/i.test(token);
const geminiApiKey = GEMINI_API_KEY?.trim();
const gemini =
  geminiApiKey && !/^(?:put_|your_)/i.test(geminiApiKey)
    ? new GoogleGenAI({ apiKey: geminiApiKey })
    : null;
const aiUserCooldowns = new Map();
const observedVoiceConnections = new WeakSet();
let reactionCleanupScanPromise;
let reactionCleanupScanRequested = false;
const botChoices = [
  { name: "Ruta (Bot 1)", value: 1 },
  { name: "Bot 2", value: 2 },
  { name: "Bot 3", value: 3 },
  { name: "Bot 4", value: 4 },
  { name: "Xin (Bot 5)", value: 5 },
];

const missingTokenNumbers = botTokens
  .map((token, index) => (tokenIsConfigured(token) ? null : index + 1))
  .filter((number) => number !== null);

if (!DISCORD_CLIENT_ID || missingTokenNumbers.length > 0) {
  const missingSettings = [];
  if (!DISCORD_CLIENT_ID) {
    missingSettings.push("DISCORD_CLIENT_ID");
  }
  for (const number of missingTokenNumbers) {
    missingSettings.push(number === 1 ? "DISCORD_TOKEN" : `DISCORD_TOKEN_${number}`);
  }
  throw new Error(`Set these values in your .env file: ${missingSettings.join(", ")}.`);
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw new Error(`Could not read ${CONFIG_PATH}: ${error.message}`);
  }
}

const config = loadSettings();
if (
  config.reactionCleanupUserIds !== undefined &&
  (!Array.isArray(config.reactionCleanupUserIds) ||
    !config.reactionCleanupUserIds.every(
      (userId) => typeof userId === "string" && /^\d{17,20}$/.test(userId),
    ))
) {
  throw new Error("config.json reactionCleanupUserIds must be an array of Discord user ID strings.");
}
const additionalReactionCleanupUserIds = new Set(config.reactionCleanupUserIds ?? []);
let reactionCleanupEnabled = config.reactionCleanupEnabled === true;
const settings = Object.fromEntries(
  Object.entries(config).filter(
    ([key]) =>
      ![
        "adminUserIds",
        "reactionCleanupEnabled",
        "reactionCleanupUserIds",
      ].includes(key),
  ),
);

function saveSettings() {
  fs.writeFileSync(
    CONFIG_PATH,
    `${JSON.stringify(
      {
        reactionCleanupEnabled,
        reactionCleanupUserIds: [...additionalReactionCleanupUserIds],
        ...settings,
      },
      null,
      2,
    )}\n`,
  );
}

function isReactionCleanupUserId(userId) {
  return (
    HARDCODED_REACTION_CLEANUP_USER_IDS.has(userId) ||
    additionalReactionCleanupUserIds.has(userId)
  );
}

const setReactionCommand = new SlashCommandBuilder()
  .setName("setreaction")
  .setDescription("Choose the channel to react to with the server's :haha: emoji.")
  .setDefaultMemberPermissions(0n)
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("The channel whose messages should be reacted to.")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true),
  );

const sendMessageCommand = new SlashCommandBuilder()
  .setName("sendmessage")
  .setDescription("Send a message to the configured channel from all five bots.")
  .addStringOption((option) =>
    option
      .setName("text")
      .setDescription("The message all five bots should send.")
      .setMaxLength(2000)
      .setRequired(true),
  );

const sendAsCommand = new SlashCommandBuilder()
  .setName("sendas")
  .setDescription("Send a custom message as one selected bot.")
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("The channel where the selected bot should send the message.")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true),
  )
  .addIntegerOption((option) =>
    option
      .setName("bot")
      .setDescription("Which bot account should send the message.")
      .addChoices(...botChoices)
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("text")
      .setDescription("What the selected bot should say.")
      .setMaxLength(2000)
      .setRequired(true),
  );

const replyCommand = new SlashCommandBuilder()
  .setName("reply")
  .setDescription("Reply to a message using one of the five bot accounts.")
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("The text channel containing the message.")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("message")
      .setDescription("The message link or message ID to reply to.")
      .setMaxLength(200)
      .setRequired(true),
  )
  .addIntegerOption((option) =>
    option
      .setName("bot")
      .setDescription("Which bot account should send the reply.")
      .addChoices(...botChoices)
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("text")
      .setDescription("What the selected bot should say.")
      .setMaxLength(2000)
      .setRequired(true),
  );

const aiCommand = new SlashCommandBuilder()
  .setName("ai")
  .setDescription("Turn Ruta and Xin AI replies on or off in this server.")
  .addBooleanOption((option) =>
    option
      .setName("enabled")
      .setDescription("Whether Ruta and Xin should respond to AI prompts.")
      .setRequired(true),
  );

const autoreactorCommand = new SlashCommandBuilder()
  .setName("autoreactor")
  .setDescription("Turn all five bots' automatic reactions on or off in this server.")
  .addBooleanOption((option) =>
    option
      .setName("enabled")
      .setDescription("Whether all five bots should automatically react.")
      .setRequired(true),
  );

const joinCommand = new SlashCommandBuilder()
  .setName("join")
  .setDescription("Make all five bots join a voice channel.")
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("The voice channel all five bots should join.")
      .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
      .setRequired(true),
  );

const botVoiceCommand = new SlashCommandBuilder()
  .setName("botvoice")
  .setDescription("Change the five bots' voice mute or deaf state.")
  .setDefaultMemberPermissions(0n)
  .addStringOption((option) =>
    option
      .setName("action")
      .setDescription("Choose how to change the bots' voice state.")
      .addChoices(
        { name: "Mute all bots", value: "mute" },
        { name: "Unmute all bots", value: "unmute" },
        { name: "Deafen all bots", value: "deafen" },
        { name: "Undeafen all bots", value: "undeafen" },
      )
      .setRequired(true),
  );

const playSoundCommand = new SlashCommandBuilder()
  .setName("playsound")
  .setDescription("Play one of this server's soundboard sounds in the voice channel.")
  .setDefaultMemberPermissions(0n)
  .addStringOption((option) =>
    option
      .setName("sound")
      .setDescription("Choose a soundboard sound.")
      .setAutocomplete(true)
      .setRequired(true),
  );

const reactionCleanupCommand = new SlashCommandBuilder()
  .setName("rc")
  .setDescription("ruut")
  .setDefaultMemberPermissions(0n)
  .addBooleanOption((option) =>
    option
      .setName("enabled")
      .setDescription("Whether reaction cleanup should run globally.")
      .setRequired(true),
  );

const addReactionCleanupUserCommand = new SlashCommandBuilder()
  .setName("adru")
  .setDescription("Add User")
  .setDefaultMemberPermissions(0n)
  .addStringOption((option) =>
    option
      .setName("user_id")
      .setDescription("The Discord user ID to add.")
      .setMinLength(17)
      .setMaxLength(20)
      .setRequired(true),
  );

const addReactionUsersCommand = new SlashCommandBuilder()
  .setName("addu")
  .setDescription("Add User");
for (let userOption = 1; userOption <= 24; userOption += 1) {
  addReactionUsersCommand.addUserOption((option) =>
    option
      .setName(`user${userOption}`)
      .setDescription(`User ${userOption} to add to reaction cleanup.`)
      .setRequired(userOption === 1),
  );
}
addReactionUsersCommand.setDefaultMemberPermissions(0n);

const removeReactionCleanupUserCommand = new SlashCommandBuilder()
  .setName("rv")
  .setDescription("remove")
  .setDefaultMemberPermissions(0n)
  .addStringOption((option) =>
    option
      .setName("user_id")
      .setDescription("The Discord user ID to remove.")
      .setMinLength(17)
      .setMaxLength(20)
      .setRequired(true),
  );

const listReactionCleanupUsersCommand = new SlashCommandBuilder()
  .setName("ls")
  .setDescription("Ls")
  .setDefaultMemberPermissions(0n);

const clients = botTokens.map(
  (_, index) =>
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        ...(index === 0 ? [GatewayIntentBits.GuildMessageReactions] : []),
        ...([0, 4].includes(index) ? [GatewayIntentBits.MessageContent] : []),
      ],
      ...(index === 0
        ? {
            partials: [
              Partials.Channel,
              Partials.Message,
              Partials.Reaction,
              Partials.User,
            ],
          }
        : {}),
    }),
);
const httpServer = http.createServer((request, response) => {
    const onlineBotCount = clients.filter((client) => client.isReady()).length;
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      `Ryvox bot is online.\nDiscord bots connected: ${onlineBotCount}/${clients.length}.\n`,
    );
});
const httpPort = Number(process.env.PORT || 3000);

httpServer.on("error", (error) => {
    console.error("Health-check HTTP server failed:", error);
    process.exitCode = 1;
});
httpServer.listen(httpPort, "0.0.0.0", () => {
    console.log(`Health-check HTTP server listening on port ${httpPort}.`);
});

const primaryClient = clients[0];
const rest = new REST({ version: "10" }).setToken(botTokens[0]);

async function registerCommand(guildId) {
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, guildId), {
    body: [
      setReactionCommand.toJSON(),
      sendMessageCommand.toJSON(),
      sendAsCommand.toJSON(),
      replyCommand.toJSON(),
      aiCommand.toJSON(),
      autoreactorCommand.toJSON(),
      joinCommand.toJSON(),
      botVoiceCommand.toJSON(),
      playSoundCommand.toJSON(),
      reactionCleanupCommand.toJSON(),
      addReactionCleanupUserCommand.toJSON(),
      addReactionUsersCommand.toJSON(),
      removeReactionCleanupUserCommand.toJSON(),
      listReactionCleanupUsersCommand.toJSON(),
    ],
  });
  console.log(
    `Registered /setreaction, /sendmessage, /sendas, /reply, /ai, /autoreactor, /join, /botvoice, /playsound, /rc, /adru, /addu, /rv, and /listuids in server ${guildId}.`,
  );
}

async function reactToMessage(message, configuration, client) {
  if (settings[message.guildId]?.autoreactorEnabled !== true) {
    return false;
  }

  try {
    const existingReaction =
      message.reactions.cache.get(configuration.emojiId) ||
      message.reactions.cache.find(
        (r) => r.emoji.toString() === configuration.emojiId,
      );

    if (existingReaction) {
      const users = await existingReaction.users.fetch();
      if (users.has(client.user.id)) {
        return false;
      }
    }

    if (settings[message.guildId]?.autoreactorEnabled !== true) {
      return false;
    }

    await message.react(configuration.emojiId);
    return true;
  } catch (error) {
    if (error.code === 10008) {
      return false;
    }
    throw error;
  }
}

async function backfillConfiguredChannels(client, botNumber) {
  for (const [guildId, configuration] of Object.entries(settings)) {
    if (
      configuration.autoreactorEnabled !== true ||
      !configuration.channelId ||
      !configuration.emojiId
    ) {
      continue;
    }
    await backfillChannel(client, guildId, configuration, botNumber);
  }
}

async function backfillChannel(client, guildId, configuration, botNumber) {
  if (settings[guildId]?.autoreactorEnabled !== true) {
    return;
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.error(`Bot ${botNumber} is not in configured server ${guildId}; skipping backfill.`);
    return;
  }

  let channel;
  try {
    channel = await client.channels.fetch(configuration.channelId);
  } catch (error) {
    console.error(
      `Bot ${botNumber} could not fetch configured channel ${configuration.channelId} for history backfill:`,
      error,
    );
    return;
  }

  if (
    !channel ||
    channel.type !== ChannelType.GuildText ||
    channel.guildId !== guildId
  ) {
    console.error(
      `Bot ${botNumber} cannot backfill configured channel ${configuration.channelId}; it is unavailable or is not a text channel in server ${guildId}.`,
    );
    return;
  }

  const botMember = guild.members.me;
  const permissions = botMember && channel.permissionsFor(botMember);
  const requiredPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AddReactions,
  ];

  if (!permissions || !permissions.has(requiredPermissions)) {
    console.error(
      `Bot ${botNumber} cannot backfill channel ${channel.id}; it needs View Channel, Read Message History, and Add Reactions.`,
    );
    return;
  }

  console.log(`Bot ${botNumber} is checking existing messages in channel ${channel.id}.`);
  let before;
  let reactedCount = 0;
  let stoppedByDisabledAutoreactor = false;

  while (true) {
    if (settings[guildId]?.autoreactorEnabled !== true) {
      stoppedByDisabledAutoreactor = true;
      break;
    }

    let messages;
    try {
      messages = await channel.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });
    } catch (error) {
      console.error(
        `Bot ${botNumber} could not fetch message history in channel ${channel.id}; backfill stopped:`,
        error,
      );
      break;
    }

    if (messages.size === 0) {
      break;
    }

    for (const message of messages.values()) {
      if (settings[guildId]?.autoreactorEnabled !== true) {
        stoppedByDisabledAutoreactor = true;
        break;
      }

      try {
        if (await reactToMessage(message, configuration, client)) {
          reactedCount += 1;
        }
      } catch (error) {
        console.error(
          `Bot ${botNumber} could not backfill reaction on message ${message.id} in channel ${channel.id}:`,
          error,
        );
      }
    }

    if (stoppedByDisabledAutoreactor) {
      break;
    }

    before = messages.last().id;
  }

  if (stoppedByDisabledAutoreactor) {
    console.log(
      `Bot ${botNumber} stopped checking channel ${channel.id} because the autoreactor was disabled; added ${reactedCount} missing reactions.`,
    );
  } else {
    console.log(
      `Bot ${botNumber} finished checking channel ${channel.id}; added ${reactedCount} missing reactions.`,
    );
  }
}

function shouldCleanReactionInMessage(message, guildId) {
  return (
    reactionCleanupEnabled &&
    settings[guildId]?.channelId === message.channelId
  );
}

function getConfiguredGuildIdForChannel(channelId) {
  return Object.entries(settings).find(
    ([, configuration]) => configuration.channelId === channelId,
  )?.[0];
}

async function removeTrackedReactionsFromMessage(message, guildId) {
  if (!shouldCleanReactionInMessage(message, guildId)) {
    return 0;
  }

  let removedCount = 0;

  for (const reaction of message.reactions.cache.values()) {
    let after;

    while (shouldCleanReactionInMessage(message, guildId)) {
      let users;
      try {
        users = await reaction.users.fetch({
          limit: 100,
          ...(after ? { after } : {}),
        });
      } catch (error) {
        if (error.code === 10008 || error.code === 10014) {
          return removedCount;
        }
        throw error;
      }

      if (users.size === 0) {
        break;
      }

      for (const user of users.values()) {
        if (!isReactionCleanupUserId(user.id) || !shouldCleanReactionInMessage(message, guildId)) {
          continue;
        }

        try {
          await reaction.users.remove(user.id);
          removedCount += 1;
        } catch (error) {
          if (error.code !== 10008 && error.code !== 10014) {
            throw error;
          }
        }
      }

      if (users.size < 100) {
        break;
      }
      after = users.lastKey();
      if (!after) {
        break;
      }
    }
  }

  return removedCount;
}

async function backfillReactionCleanup() {
  if (!reactionCleanupEnabled) {
    return;
  }

  for (const [guildId, configuration] of Object.entries(settings)) {
    if (!reactionCleanupEnabled) {
      return;
    }
    if (!configuration.channelId) {
      continue;
    }

    const guild = primaryClient.guilds.cache.get(guildId);
    if (!guild) {
      console.error(
        `Reaction cleanup cannot scan server ${guildId}; the primary bot is not in that server.`,
      );
      continue;
    }

    let channel;
    try {
      channel = await primaryClient.channels.fetch(configuration.channelId);
    } catch (error) {
      console.error(
        `Reaction cleanup could not fetch channel ${configuration.channelId} in server ${guildId}:`,
        error,
      );
      continue;
    }

    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      channel.guildId !== guildId
    ) {
      console.error(
        `Reaction cleanup cannot scan channel ${configuration.channelId}; it is unavailable or not a text channel in server ${guildId}.`,
      );
      continue;
    }

    const botMember = guild.members.me;
    const permissions = botMember && channel.permissionsFor(botMember);
    if (
      !permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ])
    ) {
      console.error(
        `Reaction cleanup cannot scan channel ${channel.id}; the primary bot needs View Channel, Read Message History, and Manage Messages.`,
      );
      continue;
    }

    console.log(`Reaction cleanup is scanning channel ${channel.id} in server ${guildId}.`);
    let before;
    let removedCount = 0;

    while (reactionCleanupEnabled) {
      let messages;
      try {
        messages = await channel.messages.fetch({
          limit: 100,
          ...(before ? { before } : {}),
        });
      } catch (error) {
        console.error(
          `Reaction cleanup could not fetch history in channel ${channel.id}:`,
          error,
        );
        break;
      }

      if (messages.size === 0) {
        break;
      }

      for (const message of messages.values()) {
        if (!reactionCleanupEnabled) {
          break;
        }
        try {
          removedCount += await removeTrackedReactionsFromMessage(message, guildId);
        } catch (error) {
          console.error(
            `Reaction cleanup could not process message ${message.id} in channel ${channel.id}:`,
            error,
          );
        }
      }

      before = messages.last().id;
    }

    console.log(
      `Reaction cleanup finished scanning channel ${channel.id}; removed ${removedCount} tracked reactions.`,
    );
  }
}

function startReactionCleanupScan() {
  if (!reactionCleanupEnabled) {
    return;
  }
  if (reactionCleanupScanPromise) {
    reactionCleanupScanRequested = true;
    return;
  }

  reactionCleanupScanPromise = (async () => {
    do {
      reactionCleanupScanRequested = false;
      await backfillReactionCleanup();
    } while (reactionCleanupEnabled && reactionCleanupScanRequested);
  })()
    .catch((error) => {
      console.error("Global reaction cleanup history scan failed:", error);
    })
    .finally(() => {
      reactionCleanupScanPromise = undefined;
      if (reactionCleanupEnabled && reactionCleanupScanRequested) {
        startReactionCleanupScan();
      }
    });
}

async function sendAiReply(message, content) {
  try {
    await message.reply({
      content,
      allowedMentions: { parse: [], repliedUser: false },
    });
  } catch (error) {
    console.error(`Could not send AI reply to message ${message.id}:`, error);
  }
}

async function handleAiPrompt(message, userMessage, botName, botPersonality) {
  const cooldownKey = `${botName}:${message.author.id}`;
  const now = Date.now();
  const cooldownExpiresAt = aiUserCooldowns.get(cooldownKey) ?? 0;
  if (cooldownExpiresAt > now) {
    const response =
      botName === "Xin"
        ? "hala wait lang muna, sunod-sunod ka naman 😭"
        : "Sandali lang, sunod-sunod ka naman. Try again in a few seconds.";
    await sendAiReply(message, response);
    return;
  }
  aiUserCooldowns.set(cooldownKey, now + AI_USER_COOLDOWN_MS);

  if (!gemini) {
    await sendAiReply(
      message,
      "Gemini API key isn't set yet. Add GEMINI_API_KEY to `.env`, then restart me.",
    );
    return;
  }

  let typingInterval;
  let aiReply;
  try {
    typingInterval = setInterval(() => {
      message.channel.sendTyping().catch((error) => {
        console.error(`Could not refresh typing indicator for message ${message.id}:`, error);
      });
    }, 8000);
    await message.channel.sendTyping().catch((error) => {
      console.error(`Could not start typing indicator for message ${message.id}:`, error);
    });

    const stream = await gemini.models.generateContentStream({
      model:
        botName === "Xin"
          ? "gemini-3.1-flash-lite"
          : "gemini-3.5-flash-lite",
      contents: [
        {
          role: "user",
          parts: [{ text: userMessage }],
        },
      ],
      config: {
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
        },
        systemInstruction: [{ text: botPersonality }],
        maxOutputTokens: 250,
      },
    });
    let generatedText = "";
    let lastEditAt = 0;

    for await (const chunk of stream) {
      if (chunk.text) {
        generatedText += chunk.text;
        const now = Date.now();

        if (!aiReply) {
          aiReply = await message.reply({
            content: generatedText.slice(0, 2000),
            allowedMentions: { parse: [], repliedUser: false },
          });
          lastEditAt = now;
        } else if (now - lastEditAt >= 1000) {
          await aiReply.edit(generatedText.slice(0, 2000));
          lastEditAt = now;
        }
      }
    }

    generatedText = generatedText.trim();
    if (!generatedText) {
      throw new Error("Gemini returned an empty response.");
    }

    if (aiReply) {
      await aiReply.edit(generatedText.slice(0, 2000));
    } else {
      await sendAiReply(message, generatedText.slice(0, 2000));
    }
  } catch (error) {
    console.error(`${botName} Gemini reply failed for message ${message.id}:`, error);
    const errorReply =
      botName === "Xin"
        ? "hala, nag-error ako saglit :(( try mo ulit later."
        : "Jusko, nag-error utak ko sandali. Try again later.";
    if (aiReply) {
      await aiReply.edit(errorReply).catch((editError) => {
        console.error(`Could not update failed ${botName} reply ${aiReply.id}:`, editError);
        return sendAiReply(message, errorReply);
      });
    } else {
      await sendAiReply(message, errorReply);
    }
  } finally {
    if (typingInterval) {
      clearInterval(typingInterval);
    }
  }
}

function parseMessageReference(input) {
  if (/^\d{17,20}$/.test(input)) {
    return { messageId: input };
  }

  try {
    const url = new URL(input);
    const validHosts = [
      "discord.com",
      "www.discord.com",
      "canary.discord.com",
      "ptb.discord.com",
      "discordapp.com",
      "www.discordapp.com",
    ];
    const pathMatch = url.pathname.match(
      /^\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/,
    );

    if (!validHosts.includes(url.hostname) || !pathMatch) {
      return null;
    }

    return {
      guildId: pathMatch[1],
      channelId: pathMatch[2],
      messageId: pathMatch[3],
    };
  } catch {
    return null;
  }
}

primaryClient.on("guildCreate", async (guild) => {
  try {
    await registerCommand(guild.id);
  } catch (error) {
    console.error(`Could not register /setreaction in server ${guild.id}:`, error);
  }
});

primaryClient.on("interactionCreate", async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (
      interaction.commandName !== "playsound" ||
      interaction.user.id !== DEVELOPER_USER_ID ||
      !interaction.guild
    ) {
      await interaction.respond([]);
      return;
    }

    try {
      const focusedValue = interaction.options.getFocused().toLocaleLowerCase();
      const sounds = await interaction.guild.soundboardSounds.fetch();
      await interaction.respond(
        sounds
          .filter(
            (sound) =>
              sound.available &&
              sound.name.toLocaleLowerCase().includes(focusedValue),
          )
          .first(25)
          .map((sound) => ({
            name: sound.name,
            value: sound.soundId,
          })),
      );
    } catch (error) {
      console.error(
        `Could not load soundboard sounds for autocomplete in server ${interaction.guildId}:`,
        error,
      );
      await interaction.respond([]);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const isDeveloper = interaction.user.id === DEVELOPER_USER_ID;
  const isLimitedAdminCommand =
    interaction.user.id === LIMITED_ADMIN_USER_ID &&
    LIMITED_ADMIN_COMMANDS.has(interaction.commandName);
  if (!isDeveloper && !isLimitedAdminCommand) {
    await interaction.reply({
      content: "You are not authorized to use this bot command.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "rc") {
    const enabled = interaction.options.getBoolean("enabled", true);
    const previousValue = reactionCleanupEnabled;
    reactionCleanupEnabled = enabled;

    try {
      saveSettings();
    } catch (error) {
      reactionCleanupEnabled = previousValue;
      console.error("Could not save the global reaction cleanup setting:", error);
      await interaction.reply({
        content: "I couldn't save the reaction cleanup setting. Check that I can write config.json.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: enabled
        ? "Global reaction cleanup is on. I’m scanning configured reaction channels for tracked users’ existing reactions."
        : "Global reaction cleanup is off. Any active history scans will stop.",
      flags: MessageFlags.Ephemeral,
    });

    if (enabled) {
      startReactionCleanupScan();
    }
    return;
  }

  if (interaction.commandName === "adru") {
    const userId = interaction.options.getString("user_id", true).trim();
    if (!/^\d{17,20}$/.test(userId)) {
      await interaction.reply({
        content: "Enter a valid Discord user ID containing 17–20 digits.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (isReactionCleanupUserId(userId)) {
      await interaction.reply({
        content: "That user ID is already on the reaction cleanup list.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    additionalReactionCleanupUserIds.add(userId);
    try {
      saveSettings();
    } catch (error) {
      additionalReactionCleanupUserIds.delete(userId);
      console.error(`Could not save reaction cleanup user ID ${userId}:`, error);
      await interaction.reply({
        content: "I couldn't save that user ID. Check that I can write config.json.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: reactionCleanupEnabled
        ? `Added user ID ${userId} to the cleanup list. Scanning existing reactions now.`
        : `Added user ID ${userId} to the cleanup list. It will be processed when global cleanup is enabled.`,
      flags: MessageFlags.Ephemeral,
    });

    if (reactionCleanupEnabled) {
      startReactionCleanupScan();
    }
    return;
  }

  if (interaction.commandName === "addu") {
    const userIds = new Set();
    for (let userOption = 1; userOption <= 24; userOption += 1) {
      const user = interaction.options.getUser(`user${userOption}`);
      if (user) {
        userIds.add(user.id);
      }
    }

    const addedUserIds = [...userIds].filter(
      (userId) => !isReactionCleanupUserId(userId),
    );
    if (addedUserIds.length === 0) {
      await interaction.reply({
        content: "All selected users are already on the reaction cleanup list.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    for (const userId of addedUserIds) {
      additionalReactionCleanupUserIds.add(userId);
    }

    try {
      saveSettings();
    } catch (error) {
      for (const userId of addedUserIds) {
        additionalReactionCleanupUserIds.delete(userId);
      }
      console.error("Could not save the selected reaction cleanup user IDs:", error);
      await interaction.reply({
        content: "I couldn't save the selected users. Check that I can write config.json.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const skippedCount = userIds.size - addedUserIds.length;
    await interaction.reply({
      content: `Added ${addedUserIds.length} user${addedUserIds.length === 1 ? "" : "s"} to the reaction cleanup list.${skippedCount ? ` ${skippedCount} already listed.` : ""}${reactionCleanupEnabled ? " Scanning existing reactions now." : " They will be processed when global cleanup is enabled."}`,
      flags: MessageFlags.Ephemeral,
    });

    if (reactionCleanupEnabled) {
      startReactionCleanupScan();
    }
    return;
  }

  if (interaction.commandName === "rv") {
    const userId = interaction.options.getString("user_id", true).trim();
    if (!/^\d{17,20}$/.test(userId)) {
      await interaction.reply({
        content: "Enter a valid Discord user ID containing 17–20 digits.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (HARDCODED_REACTION_CLEANUP_USER_IDS.has(userId)) {
      await interaction.reply({
        content: "That ID is hardcoded and cannot be removed with /rv.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!additionalReactionCleanupUserIds.delete(userId)) {
      await interaction.reply({
        content: "That ID is not in the additional reaction cleanup list.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      saveSettings();
    } catch (error) {
      additionalReactionCleanupUserIds.add(userId);
      console.error(`Could not save removal of reaction cleanup user ID ${userId}:`, error);
      await interaction.reply({
        content: "I couldn't save that change. Check that I can write config.json.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: `Removed user ID ${userId} from the additional reaction cleanup list.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "ls") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userIds = [
      ...new Set([
        ...HARDCODED_REACTION_CLEANUP_USER_IDS,
        ...additionalReactionCleanupUserIds,
      ]),
    ].sort();
    const lines = [];

    for (const userId of userIds) {
      let user;
      try {
        user = await primaryClient.users.fetch(userId);
      } catch (error) {
        if (error.code !== 10013) {
          console.error(`Could not fetch user ${userId} for /ls:`, error);
        }
      }

      const name = user
        ? `${user.globalName ?? user.username} (@${user.username})`
        : "Unknown or unavailable user";
      const source = HARDCODED_REACTION_CLEANUP_USER_IDS.has(userId)
        ? "hardcoded"
        : "added";
      lines.push(`${name} — ${userId} [${source}]`);
    }

    const responseLines =
      lines.length > 0
        ? lines
        : ["No reaction cleanup user IDs are configured."];
    const chunks = [];
    let chunk = "";
    for (const line of responseLines) {
      if (chunk && chunk.length + line.length + 1 > 1900) {
        chunks.push(chunk);
        chunk = "";
      }
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
    if (chunk) {
      chunks.push(chunk);
    }

    await interaction.editReply({
      content: chunks[0],
      allowedMentions: { parse: [] },
    });
    for (const nextChunk of chunks.slice(1)) {
      await interaction.followUp({
        content: nextChunk,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
    return;
  }

  if (interaction.commandName === "ai") {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const enabled = interaction.options.getBoolean("enabled", true);
    const previousSettings = settings[interaction.guildId];
    settings[interaction.guildId] = {
      ...previousSettings,
      aiEnabled: enabled,
    };

    try {
      saveSettings();
    } catch (error) {
      if (previousSettings) {
        settings[interaction.guildId] = previousSettings;
      } else {
        delete settings[interaction.guildId];
      }
      console.error(`Could not save the AI setting for server ${interaction.guildId}:`, error);
      await interaction.reply({
        content: "I couldn't save the AI setting. Check that I can write config.json.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: `Ruta and Xin AI replies are now ${enabled ? "on" : "off"} in this server. Autoreactions are not affected.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "autoreactor") {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const enabled = interaction.options.getBoolean("enabled", true);
    const previousSettings = settings[interaction.guildId];
    settings[interaction.guildId] = {
      ...previousSettings,
      autoreactorEnabled: enabled,
    };

    try {
      saveSettings();
    } catch (error) {
      if (previousSettings) {
        settings[interaction.guildId] = previousSettings;
      } else {
        delete settings[interaction.guildId];
      }
      console.error(
        `Could not save the autoreactor setting for server ${interaction.guildId}:`,
        error,
      );
      await interaction.reply({
        content: "I couldn't save the autoreactor setting. Check that I can write config.json.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: `Automatic reactions are now ${enabled ? "on" : "off"} for all five bots in this server.`,
      flags: MessageFlags.Ephemeral,
    });

    const configuration = settings[interaction.guildId];
    if (enabled && configuration.channelId && configuration.emojiId) {
      clients.forEach((client, index) => {
        if (!client.isReady()) {
          return;
        }

        backfillChannel(
          client,
          interaction.guildId,
          configuration,
          index + 1,
        ).catch((error) => {
          console.error(
            `Bot ${index + 1} could not backfill configured channel ${configuration.channelId}:`,
            error,
          );
        });
      });
    }

    return;
  }

  if (interaction.commandName === "join") {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.options.getChannel("channel", true);
    const joinedBots = [];
    const pendingBots = [];
    const failedBots = [];

    await Promise.all(
      clients.map(async (client, index) => {
        const botNumber = index + 1;
        const botName = botChoices[index].name;
        const guild = client.guilds.cache.get(interaction.guildId);

        if (!client.isReady()) {
          failedBots.push(`${botName}: offline`);
          return;
        }
        if (!guild) {
          failedBots.push(`${botName}: not in this server`);
          return;
        }

        let connection;
        try {
          const voiceChannel = await client.channels.fetch(channel.id);
          if (
            !voiceChannel ||
            ![
              ChannelType.GuildVoice,
              ChannelType.GuildStageVoice,
            ].includes(voiceChannel.type) ||
            voiceChannel.guildId !== interaction.guildId
          ) {
            failedBots.push(`${botName}: cannot access that voice channel`);
            return;
          }

          const botMember = guild.members.me;
          const permissions = botMember && voiceChannel.permissionsFor(botMember);
          if (
            !permissions?.has([
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
            ])
          ) {
            failedBots.push(`${botName}: needs View Channel and Connect permissions`);
            return;
          }

          connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: interaction.guildId,
            adapterCreator: guild.voiceAdapterCreator,
            group: `bot-${botNumber}`,
            selfDeaf: true,
            selfMute: true,
          });
          if (!observedVoiceConnections.has(connection)) {
            observedVoiceConnections.add(connection);
            connection.on("error", (error) => {
              console.error(
                `${botName} voice connection error in channel ${connection.joinConfig.channelId}:`,
                error,
              );
            });
            connection.on("stateChange", (_, newState) => {
              console.log(
                `${botName} voice connection in channel ${connection.joinConfig.channelId} changed to ${newState.status}.`,
              );
            });
          }

          try {
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
            joinedBots.push(botName);
          } catch (error) {
            if (error.name !== "AbortError") {
              throw error;
            }

            const isInChannel = botMember.voice.channelId === voiceChannel.id;
            pendingBots.push(
              isInChannel
                ? `${botName} joined; voice transport is still ${connection.state.status}`
                : `${botName} has not confirmed joining; connection is ${connection.state.status}`,
            );
            console.warn(
              `${botName} did not reach ready state for voice channel ${channel.id} within 30 seconds; member voice channel is ${botMember.voice.channelId ?? "unknown"} and connection state is ${connection.state.status}. Keeping the connection alive.`,
            );
          }
        } catch (error) {
          connection?.destroy();
          console.error(
            `${botName} could not join voice channel ${channel.id} in server ${interaction.guildId}:`,
            error,
          );
          failedBots.push(`${botName}: failed to join (see bot logs)`);
        }
      }),
    );

    const resultLines = [];
    if (joinedBots.length > 0) {
      resultLines.push(`Joined <#${channel.id}>: ${joinedBots.join(", ")}.`);
    }
    if (pendingBots.length > 0) {
      resultLines.push(
        `Still connecting (kept in the channel): ${pendingBots.join("; ")}.`,
      );
    }
    if (failedBots.length > 0) {
      resultLines.push(`Could not join: ${failedBots.join("; ")}.`);
    }
    await interaction.editReply(resultLines.join("\n"));
    return;
  }

  if (interaction.commandName === "botvoice") {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const action = interaction.options.getString("action", true);
    const isMuteAction = action === "mute" || action === "unmute";
    const property = isMuteAction ? "selfMute" : "selfDeaf";
    const targetValue = action === "mute" || action === "deafen";
    const updatedBots = [];
    const unchangedBots = [];
    const unavailableBots = [];

    for (let index = 0; index < clients.length; index += 1) {
      const botName = botChoices[index].name;
      const connection = getVoiceConnection(
        interaction.guildId,
        `bot-${index + 1}`,
      );

      if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
        unavailableBots.push(botName);
        continue;
      }

      if (connection.joinConfig[property] === targetValue) {
        unchangedBots.push(botName);
        continue;
      }

      if (
        connection.rejoin({
          selfMute: isMuteAction
            ? targetValue
            : connection.joinConfig.selfMute,
          selfDeaf: isMuteAction
            ? connection.joinConfig.selfDeaf
            : targetValue,
        })
      ) {
        updatedBots.push(botName);
      } else {
        unavailableBots.push(botName);
      }
    }

    const lines = [];
    if (updatedBots.length > 0) {
      lines.push(
        `Requested ${action} for: ${updatedBots.join(", ")}. Discord may take a moment to update their voice states.`,
      );
    }
    if (unchangedBots.length > 0) {
      lines.push(`Already set: ${unchangedBots.join(", ")}.`);
    }
    if (unavailableBots.length > 0) {
      lines.push(`Not connected or could not update: ${unavailableBots.join(", ")}.`);
    }
    if (lines.length === 0) {
      lines.push("No bot voice connections are active in this server.");
    }

    await interaction.reply({
      content: lines.join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "playsound") {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const soundId = interaction.options.getString("sound", true);
    const connection = getVoiceConnection(interaction.guildId, "bot-1");
    if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
      await interaction.editReply("Ruta needs to join a voice channel with /join first.");
      return;
    }

    try {
      const channel = await primaryClient.channels.fetch(
        connection.joinConfig.channelId,
      );
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.editReply(
          "Ruta must be connected to a regular voice channel to play a soundboard sound.",
        );
        return;
      }

      const botMember = interaction.guild.members.me;
      const permissions = botMember && channel.permissionsFor(botMember);
      if (!permissions?.has(PermissionFlagsBits.UseSoundboard)) {
        await interaction.editReply(
          "Ruta needs the Use Soundboard permission in its voice channel.",
        );
        return;
      }

      const sounds = await interaction.guild.soundboardSounds.fetch();
      const sound = sounds.get(soundId);
      if (!sound?.available) {
        await interaction.editReply(
          "That sound is unavailable or is no longer in this server's soundboard.",
        );
        return;
      }

      await channel.sendSoundboardSound(sound);
      await interaction.editReply(`Played "${sound.name}" in <#${channel.id}>.`);
    } catch (error) {
      console.error(
        `Could not play soundboard sound ${soundId} in server ${interaction.guildId}:`,
        error,
      );
      await interaction.editReply(
        "I couldn't play that sound. Check Ruta's voice connection, soundboard permission, and the bot logs.",
      );
    }
    return;
  }

  if (interaction.commandName === "sendmessage") {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const configuration = settings[interaction.guildId];
    if (!configuration) {
      await interaction.reply({
        content: "Set a channel first with /setreaction.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const text = interaction.options.getString("text", true);
    const targetChannels = [];
    const unavailableBots = [];

    for (let index = 0; index < clients.length; index += 1) {
      const client = clients[index];
      const botNumber = index + 1;

      if (!client.isReady()) {
        unavailableBots.push(`Bot ${botNumber} is offline`);
        continue;
      }

      const guild = client.guilds.cache.get(interaction.guildId);
      if (!guild) {
        unavailableBots.push(`Bot ${botNumber} is not in this server`);
        continue;
      }

      try {
        const channel = await client.channels.fetch(configuration.channelId);
        const botMember = guild.members.me;
        const permissions = botMember && channel?.permissionsFor(botMember);

        if (
          !channel ||
          channel.type !== ChannelType.GuildText ||
          channel.guildId !== interaction.guildId ||
          !permissions?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
          ])
        ) {
          unavailableBots.push(
            `Bot ${botNumber} cannot send messages in <#${configuration.channelId}>`,
          );
          continue;
        }

        targetChannels[index] = channel;
      } catch (error) {
        console.error(
          `Bot ${botNumber} could not access configured channel ${configuration.channelId}:`,
          error,
        );
        unavailableBots.push(`Bot ${botNumber} could not access the configured channel`);
      }
    }

    if (unavailableBots.length > 0) {
      await interaction.editReply(
        `No messages were sent. Fix these bot issues first: ${unavailableBots.join("; ")}.`,
      );
      return;
    }

    const sendResults = await Promise.allSettled(
      targetChannels.map((channel) =>
        channel.send({
          content: text,
          allowedMentions: { parse: [] },
        }),
      ),
    );
    const failedBots = sendResults.flatMap((result, index) => {
      if (result.status === "fulfilled") {
        return [];
      }
      console.error(`Bot ${index + 1} could not send the requested message:`, result.reason);
      return [`Bot ${index + 1}`];
    });

    if (failedBots.length > 0) {
      await interaction.editReply(
        `Some messages were sent, but ${failedBots.join(", ")} could not send. Check the console and bot permissions.`,
      );
      return;
    }

    await interaction.editReply(
      `All five bots sent your message in <#${configuration.channelId}>.`,
    );
    return;
  }

  if (interaction.commandName === "sendas") {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.options.getChannel("channel", true);
    const botNumber = interaction.options.getInteger("bot", true);
    const text = interaction.options.getString("text", true);
    const selectedClient = clients[botNumber - 1];

    if (!selectedClient?.isReady()) {
      await interaction.editReply(`Bot ${botNumber} is offline, so it could not send the message.`);
      return;
    }

    const selectedGuild = selectedClient.guilds.cache.get(interaction.guildId);
    if (!selectedGuild) {
      await interaction.editReply(
        `Bot ${botNumber} is not in this server. Add it to the server before using /sendas.`,
      );
      return;
    }

    try {
      const targetChannel = await selectedClient.channels.fetch(channel.id);
      if (
        !targetChannel ||
        targetChannel.type !== ChannelType.GuildText ||
        targetChannel.guildId !== interaction.guildId
      ) {
        await interaction.editReply("The selected bot cannot access that text channel.");
        return;
      }

      const botMember = selectedGuild.members.me;
      const permissions = botMember && targetChannel.permissionsFor(botMember);
      if (
        !permissions?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
        ])
      ) {
        await interaction.editReply(
          `Bot ${botNumber} needs View Channel and Send Messages permissions in <#${channel.id}>.`,
        );
        return;
      }

      await targetChannel.send({
        content: text,
        allowedMentions: { parse: [] },
      });
      await interaction.editReply(
        `Your message was sent in <#${channel.id}> as ${selectedClient.user.tag}.`,
      );
    } catch (error) {
      console.error(
        `Bot ${botNumber} could not send a custom message in channel ${channel.id}:`,
        error,
      );
      await interaction.editReply(
        `Bot ${botNumber} couldn't send the message because of a Discord or network error. Check the console and its channel permissions.`,
      );
    }
    return;
  }

  if (interaction.commandName === "reply") {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.options.getChannel("channel", true);
    const messageInput = interaction.options.getString("message", true).trim();
    const botNumber = interaction.options.getInteger("bot", true);
    const replyText = interaction.options.getString("text", true);
    const messageReference = parseMessageReference(messageInput);

    if (!messageReference) {
      await interaction.editReply(
        "Enter a valid Discord message link or a message ID (right-click the message and choose Copy Message Link).",
      );
      return;
    }

    if (
      (messageReference.guildId && messageReference.guildId !== interaction.guildId) ||
      (messageReference.channelId && messageReference.channelId !== channel.id)
    ) {
      await interaction.editReply(
        "The message link must point to the selected channel in this server.",
      );
      return;
    }

    const selectedClient = clients[botNumber - 1];
    if (!selectedClient.isReady()) {
      await interaction.editReply(
        `Bot ${botNumber} is not connected right now. Wait for it to log in, then try again.`,
      );
      return;
    }

    const selectedGuild = selectedClient.guilds.cache.get(interaction.guildId);
    if (!selectedGuild) {
      await interaction.editReply(
        `Bot ${botNumber} is not in this server. Add that bot to the server before using it to reply.`,
      );
      return;
    }

    try {
      const targetChannel = await selectedClient.channels.fetch(channel.id);
      if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
        await interaction.editReply("The selected bot cannot access that text channel.");
        return;
      }

      const botMember = selectedGuild.members.me;
      const permissions = botMember && targetChannel.permissionsFor(botMember);
      const requiredPermissions = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
      ];

      if (!permissions || !permissions.has(requiredPermissions)) {
        await interaction.editReply(
          `Bot ${botNumber} needs View Channel, Read Message History, and Send Messages permissions in <#${channel.id}>.`,
        );
        return;
      }

      const targetMessage = await targetChannel.messages.fetch(
        messageReference.messageId,
      );
      await targetMessage.reply({
        content: replyText,
        allowedMentions: { parse: [], repliedUser: false },
        failIfNotExists: true,
      });

      await interaction.editReply(
        `Replied to [the selected message](https://discord.com/channels/${interaction.guildId}/${channel.id}/${targetMessage.id}) as ${selectedClient.user.tag}.`,
      );
    } catch (error) {
      console.error(
        `Bot ${botNumber} could not reply to message ${messageReference.messageId} in channel ${channel.id}:`,
        error,
      );
      if (error.code === 10008) {
        await interaction.editReply(
          `Discord couldn't find that message in <#${channel.id}>. The message ID may be wrong, the message may have been deleted, or the selected channel may not match. Copy the link from the message's context menu and select that same channel. If the link is correct, make sure Bot ${botNumber} can view the channel and its message history.`,
        );
      } else if (error.code === 50001 || error.code === 50013) {
        await interaction.editReply(
          `Bot ${botNumber} doesn't have permission to access or reply in <#${channel.id}>. Give it View Channel, Read Message History, and Send Messages permissions.`,
        );
      } else {
        await interaction.editReply(
          `Bot ${botNumber} couldn't reply because of a Discord or network error (code ${error.code ?? "unknown"}). Check the console for details and verify its channel permissions.`,
        );
      }
    }
    return;
  }

  if (interaction.commandName !== "setreaction") {
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.options.getChannel("channel", true);
  let emoji;
  try {
    const emojis = await interaction.guild.emojis.fetch();
    emoji = emojis.find(
      (serverEmoji) =>
        serverEmoji.name?.toLowerCase() === REACTION_EMOJI_NAME.toLowerCase(),
    );
  } catch (error) {
    console.error(`Could not fetch the :${REACTION_EMOJI_NAME}: server emoji:`, error);
    await interaction.reply({
      content: "I couldn't load the server's custom emojis. Please try again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!emoji) {
    await interaction.reply({
      content: `I couldn't find a custom emoji named :${REACTION_EMOJI_NAME}: in this server.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const botMember = interaction.guild.members.me;
  const permissions = botMember && channel.permissionsFor(botMember);
  const requiredPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AddReactions,
  ];

  if (!permissions || !permissions.has(requiredPermissions)) {
    await interaction.reply({
      content:
        "I need View Channel, Read Message History, and Add Reactions permissions in that channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  settings[interaction.guildId] = {
    ...settings[interaction.guildId],
    channelId: channel.id,
    emojiId: emoji.toString(),
  };

  try {
    saveSettings();
  } catch (error) {
    console.error("Could not save the channel reaction settings:", error);
    await interaction.reply({
      content: "I couldn't save the settings. Check that I can write config.json.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content:
      settings[interaction.guildId].autoreactorEnabled !== true
        ? `The autoreactor is off. The channel <#${channel.id}> is saved; all five bots will react there when you turn it back on.`
        : `All five bots will react to new messages in <#${channel.id}> with ${emoji.toString()} and are checking its existing message history now.`,
    flags: MessageFlags.Ephemeral,
  });

  clients.forEach((client, index) => {
    if (!client.isReady()) {
      return;
    }

    backfillChannel(client, interaction.guildId, settings[interaction.guildId], index + 1).catch(
      (error) => {
        console.error(
          `Bot ${index + 1} could not backfill configured channel ${channel.id}:`,
          error,
        );
      },
    );
  });
});

primaryClient.on("messageReactionAdd", async (reaction, user) => {
  if (
    !reactionCleanupEnabled ||
    !isReactionCleanupUserId(user.id)
  ) {
    return;
  }

  const channelId = reaction.message.channelId;
  const guildId = getConfiguredGuildIdForChannel(channelId);
  if (!guildId) {
    return;
  }

  try {
    // Reaction identifiers are available on partial events, so remove without fetching the message.
    await reaction.users.remove(user.id);
  } catch (error) {
    if (error.code !== 10008 && error.code !== 10014) {
      console.error(
        `Reaction cleanup could not remove user ${user.id}'s reaction from message ${reaction.message.id} in channel ${channelId}:`,
        error,
      );
    }
  }
});

clients.forEach((client, index) => {
  client.once("clientReady", async (readyClient) => {
    console.log(`Bot ${index + 1} logged in as ${readyClient.user.tag}.`);

    await backfillConfiguredChannels(readyClient, index + 1);

    if (index === 0) {
      for (const guild of readyClient.guilds.cache.values()) {
        try {
          await registerCommand(guild.id);
        } catch (error) {
          console.error(`Could not register /setreaction in server ${guild.id}:`, error);
        }
      }

      if (reactionCleanupEnabled) {
        startReactionCleanupScan();
      }
    }
  });

  client.on("messageCreate", async (message) => {
    if (!message.guildId) {
      return;
    }

    const configuration = settings[message.guildId];
    if (configuration && message.channelId === configuration.channelId) {
      try {
        await reactToMessage(message, configuration, client);
      } catch (error) {
        console.error(
          `Bot ${index + 1} could not react to message ${message.id} in channel ${message.channelId}:`,
          error,
        );
      }
    }

    if (
      ![0, 4].includes(index) ||
      message.author.bot ||
      settings[message.guildId]?.aiEnabled === false
    ) {
      return;
    }

    const isRuta = index === 0;
    const botName = isRuta ? "Ruta" : "Xin";
    const botPersonality = isRuta ? personality : xinPersonality;
    const commandMatch = isRuta
      ? message.content.match(/^\.rr(?:\s+)?([\s\S]*)$/i)
      : null;
    const mentionPattern = client.user
      ? new RegExp(`<@!?${client.user.id}>`)
      : null;
    const mentionedBot =
      !message.reference &&
      client.user &&
      (message.mentions.users.has(client.user.id) ||
        (mentionPattern && mentionPattern.test(message.content)));

    if (index === 4 && !message.author.bot && message.mentions.users.size > 0) {
      console.log(
        `Xin mention check: message ${message.id}, received mentions [${[
          ...message.mentions.users.keys(),
        ].join(", ")}], direct Xin ping ${Boolean(mentionedBot)}.`,
      );
    }

    if (!commandMatch && !mentionedBot) {
      return;
    }

    const userMessage = commandMatch
      ? commandMatch[1].trim()
      : message.content
          .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
          .trim();
    if (!userMessage) {
      const emptyMentionReply = isRuta
        ? "sabihin mo ano gusto mo gago"
        : "tanga kaba ano?";
      await sendAiReply(message, emptyMentionReply);
      return;
    }

    await handleAiPrompt(message, userMessage, botName, botPersonality);
  });

  client.login(botTokens[index]).catch((error) => {
    console.error(`Bot ${index + 1} could not log in:`, error);
    process.exitCode = 1;
  });
});