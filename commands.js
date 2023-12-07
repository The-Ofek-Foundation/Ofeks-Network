const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = '1181322376957407242';
const CLIENT_ID = '1181338959285075981';

const commands = [
	new SlashCommandBuilder()
		.setName('refresh')
		.setDescription('Refreshes the server data.')
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator), // Restrict to admins only
	new SlashCommandBuilder()
		.setName('incrementinstructed')
		.setDescription('Increments the instructed count.'),
	new SlashCommandBuilder()
		.setName('decrementinstructed')
		.setDescription('Decrements the instructed count.'),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
	try {
		console.log('Started refreshing application (/) commands.');

		await rest.put(
			Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
			{ body: commands },
		);

		console.log('Successfully reloaded application (/) commands.');
	} catch (error) {
		console.error(error);
	}
})();
