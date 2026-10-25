require("dotenv").config();

const {
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const { GoogleGenAI, ThinkingLevel } = require("@google/genai");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const personality = require("./personality");
const xinPersonality = require("./xin-personality");

const { DISCORD_CLIENT_ID, GEMINI_API_KEY } = process.env;
const ADMIN_USER_ID = "766135407590244383";
const AI_USER_COOLDOWN_MS = 5000;
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

const settings = loadSettings();

function saveSettings() {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

const setReactionCommand = new SlashCommandBuilder()
  .setName("setreaction")
  .setDescription("Choose the channel to react to with the server's :haha: emoji.")
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
      .addChoices(
        { name: "Bot 1 (primary)", value: 1 },
        { name: "Bot 2", value: 2 },
        { name: "Bot 3", value: 3 },
        { name: "Bot 4", value: 4 },
        { name: "Bot 5", value: 5 },
      )
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

const clients = botTokens.map(
  (_, index) =>
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        ...([0, 4].includes(index) ? [GatewayIntentBits.MessageContent] : []),
      ],
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
      replyCommand.toJSON(),
      aiCommand.toJSON(),
    ],
  });
  console.log(
    `Registered /setreaction, /sendmessage, /reply, and /ai in server ${guildId}.`,
  );
}

async function reactToMessage(message, configuration, client) {
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

  await message.react(configuration.emojiId);
  return true;
}

async function backfillConfiguredChannels(client, botNumber) {
  for (const [guildId, configuration] of Object.entries(settings)) {
    if (!configuration.channelId || !configuration.emojiId) {
      continue;
    }
    await backfillChannel(client, guildId, configuration, botNumber);
  }
}

async function backfillChannel(client, guildId, configuration, botNumber) {
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

  while (true) {
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

    before = messages.last().id;
  }

  console.log(
    `Bot ${botNumber} finished checking channel ${channel.id}; added ${reactedCount} missing reactions.`,
  );
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
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.user.id !== ADMIN_USER_ID) {
    await interaction.reply({
      content: "You are not authorized to use this bot command.",
      flags: MessageFlags.Ephemeral,
    });
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
    content: `All five bots will react to new messages in <#${channel.id}> with ${emoji.toString()} and are checking its existing message history now.`,
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

clients.forEach((client, index) => {
  client.once("clientReady", async (readyClient) => {
    console.log(`Bot ${index + 1} logged in as ${readyClient.user.tag}.`);

    if (index === 0) {
      for (const guild of readyClient.guilds.cache.values()) {
        try {
          await registerCommand(guild.id);
        } catch (error) {
          console.error(`Could not register /setreaction in server ${guild.id}:`, error);
        }
      }
    }

    await backfillConfiguredChannels(readyClient, index + 1);
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