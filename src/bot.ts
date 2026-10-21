import { randomInt } from "node:crypto";
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  Colors,
  ComponentType,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  GuildMember,
  InteractionContextType,
  Message,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID; // optional: instant command sync for one server
if (!TOKEN) throw new Error("DISCORD_TOKEN is not set");

const WING_SIZES = [2, 3, 4, 5] as const;
const LOBBY_TIMEOUT_MS = 60 * 60 * 1000;
const SELECT_TIMEOUT_MS = 2 * 60 * 1000;
const COMMAND_COOLDOWN_MS = 30 * 1000;

// Anti-spam: per-user cooldown and one open lobby per host (userId -> lobby message URL).
const lastUsed = new Map<string, number>();
const activeLobbies = new Map<string, string>();

interface Player {
  id: string;
  name: string;
}

class FightLobby {
  readonly players = new Map<string, Player>();
  teams: [Player[], Player[]] | null = null;
  closed = false;

  constructor(
    readonly host: Player,
    readonly wingSize: number,
  ) {}

  get capacity(): number {
    return this.wingSize * 2;
  }

  get full(): boolean {
    return this.players.size >= this.capacity;
  }

  roll(): void {
    const pool = [...this.players.values()];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    this.teams = [pool.slice(0, this.wingSize), pool.slice(this.wingSize)];
  }

  private static names(players: Iterable<Player>): string {
    const lines = [...players].map((p) => `• ${p.name}`);
    return lines.length ? lines.join("\n") : "—";
  }

  embed(): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setTitle(`⚔️ ${this.wingSize}v${this.wingSize} Fight`)
      .setDescription(`Host: **${this.host.name}**`)
      .setColor(this.teams ? Colors.Green : Colors.Red)
      .addFields({
        name: `Players (${this.players.size}/${this.capacity})`,
        value: FightLobby.names(this.players.values()),
      })
      .setFooter({
        text: this.closed ? "Lobby closed." : "Join to play. Host rolls teams when the lobby is full.",
      });
    if (this.teams) {
      embed.addFields(
        { name: "🔵 Team 1", value: FightLobby.names(this.teams[0]), inline: true },
        { name: "🔴 Team 2", value: FightLobby.names(this.teams[1]), inline: true },
      );
    }
    return embed;
  }

  components(): ActionRowBuilder<ButtonBuilder>[] {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("fight:join")
        .setLabel("Join")
        .setEmoji("➕")
        .setStyle(ButtonStyle.Success)
        .setDisabled(this.closed || this.full),
      new ButtonBuilder()
        .setCustomId("fight:leave")
        .setLabel("Leave")
        .setEmoji("➖")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(this.closed || this.players.size === 0),
      new ButtonBuilder()
        .setCustomId("fight:roll")
        .setLabel("Roll Teams")
        .setEmoji("🎲")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(this.closed || !this.full),
      new ButtonBuilder()
        .setCustomId("fight:cancel")
        .setLabel("Cancel")
        .setEmoji("✖️")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(this.closed),
    );
    return [row];
  }

  view() {
    return { embeds: [this.embed()], components: this.components() };
  }
}

function toPlayer(member: GuildMember): Player {
  // displayName = server nickname, falling back to global display name / username
  return { id: member.id, name: member.displayName };
}

function canManage(lobby: FightLobby, member: GuildMember): boolean {
  return member.id === lobby.host.id || member.permissions.has(PermissionFlagsBits.ManageGuild);
}

/** Applies a button click. Returns an error message to show the clicker, or null on success. */
async function applyButton(lobby: FightLobby, i: ButtonInteraction<"cached">): Promise<string | null> {
  switch (i.customId) {
    case "fight:join":
      if (lobby.players.has(i.user.id)) return "You're already in.";
      if (lobby.full) return "Lobby is full.";
      lobby.players.set(i.user.id, toPlayer(i.member));
      lobby.teams = null;
      return null;

    case "fight:leave":
      if (!lobby.players.delete(i.user.id)) return "You're not in this lobby.";
      lobby.teams = null;
      return null;

    case "fight:roll": {
      if (!canManage(lobby, i.member)) return "Only the host can roll teams.";
      if (lobby.players.size !== lobby.capacity) return `Need ${lobby.capacity} players to roll.`;
      // Re-fetch members so the latest server nicknames are shown.
      await Promise.all(
        [...lobby.players.keys()].map(async (id) => {
          const member = await i.guild.members.fetch({ user: id, force: true }).catch(() => null);
          if (member) lobby.players.set(id, toPlayer(member));
        }),
      );
      lobby.roll();
      return null;
    }

    case "fight:cancel":
      if (!canManage(lobby, i.member)) return "Only the host can cancel.";
      lobby.closed = true;
      return null;

    default:
      return "Unknown action.";
  }
}

async function startLobby(message: Message<true>, host: GuildMember, wingSize: number): Promise<void> {
  const lobby = new FightLobby(toPlayer(host), wingSize);
  activeLobbies.set(host.id, message.url);
  await message.edit({ content: "", ...lobby.view() });

  const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, idle: LOBBY_TIMEOUT_MS });
  // Serialize clicks so concurrent joins can't overfill the lobby.
  let queue: Promise<unknown> = Promise.resolve();

  collector.on("collect", (i) => {
    queue = queue.then(async () => {
      if (!i.inCachedGuild() || lobby.closed) return;
      try {
        const error = await applyButton(lobby, i);
        if (error) {
          await i.reply({ content: error, flags: MessageFlags.Ephemeral });
          return;
        }
        await i.update(lobby.view());
        if (lobby.closed) collector.stop("cancelled");
      } catch (err) {
        console.error("Button handler failed:", err);
      }
    });
  });

  collector.on("end", async (_c, reason) => {
    activeLobbies.delete(host.id);
    if (reason === "cancelled") return;
    lobby.closed = true;
    await message.edit(lobby.view()).catch(() => undefined);
  });
}

/** Returns true if a lobby was started (it frees the host's slot itself when it closes). */
async function handleFight(i: ChatInputCommandInteraction<"cached">): Promise<boolean> {
  const wingSize = i.options.getInteger("wing_size");

  if (wingSize !== null) {
    const response = await i.reply({ content: "Creating lobby…", withResponse: true });
    const message = response.resource?.message;
    if (!message?.inGuild()) return false;
    await startLobby(message, i.member, wingSize);
    return true;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("fight:size")
    .setPlaceholder("Choose wing size…")
    .addOptions(WING_SIZES.map((n) => ({ label: `${n}v${n}`, value: String(n) })));

  const response = await i.reply({
    content: "Pick a wing size:",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    withResponse: true,
  });
  const message = response.resource?.message;
  if (!message?.inGuild()) return false;

  try {
    const choice = await message.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      filter: async (c) => {
        if (c.user.id === i.user.id) return true;
        await c.reply({ content: "Only the host can choose.", flags: MessageFlags.Ephemeral }).catch(() => undefined);
        return false;
      },
      time: SELECT_TIMEOUT_MS,
    });
    await choice.deferUpdate();
    await startLobby(message, i.member, Number(choice.values[0]));
    return true;
  } catch {
    await message.edit({ content: "Wing size selection timed out.", components: [] }).catch(() => undefined);
    return false;
  }
}

/** Returns a reason to reject the command, or null if the user may start a lobby. */
function spamCheck(userId: string): string | null {
  const now = Date.now();
  for (const [id, t] of lastUsed) if (now - t >= COMMAND_COOLDOWN_MS) lastUsed.delete(id);

  const openLobby = activeLobbies.get(userId);
  if (openLobby) return `You already have an open lobby: ${openLobby}\nCancel it or wait for it to close first.`;

  const last = lastUsed.get(userId);
  if (last !== undefined) {
    const readyAt = Math.ceil((last + COMMAND_COOLDOWN_MS) / 1000);
    return `Slow down! You can use /fight again <t:${readyAt}:R>.`;
  }
  return null;
}

const fightCommand: RESTPostAPIChatInputApplicationCommandsJSONBody = {
  name: "fight",
  description: "Start a team matchmaking lobby",
  contexts: [InteractionContextType.Guild],
  options: [
    {
      name: "wing_size",
      description: "Players per team",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      choices: WING_SIZES.map((n) => ({ name: `${n}v${n}`, value: n })),
    },
  ],
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  if (GUILD_ID) {
    await c.application.commands.set([fightCommand], GUILD_ID);
  } else {
    await c.application.commands.set([fightCommand]);
  }
  console.log(`Logged in as ${c.user.tag} (${c.user.id})`);
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== "fight") return;
  if (!i.inCachedGuild()) {
    await i.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
    return;
  }

  const rejection = spamCheck(i.user.id);
  if (rejection) {
    await i.reply({ content: rejection, flags: MessageFlags.Ephemeral });
    return;
  }
  lastUsed.set(i.user.id, Date.now());
  activeLobbies.set(i.user.id, "(choosing wing size)");

  let started = false;
  try {
    started = await handleFight(i);
  } catch (err) {
    console.error("/fight failed:", err);
  } finally {
    if (!started) activeLobbies.delete(i.user.id);
  }
});

client.login(TOKEN);
