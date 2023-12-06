require('dotenv').config();
const Discord = require('discord.js');
const client = new Discord.Client({
	intents: [
		Discord.GatewayIntentBits.Guilds,
		Discord.GatewayIntentBits.GuildMembers,
		Discord.GatewayIntentBits.GuildInvites,
	]
});

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = '1181322376957407242';
const CLIENT_ID = '1181338959285075981';
const ADMIN_ROLE_ID = '1181347796234805338';
const DEFAULT_ROLES = [];

const inviteMap = new Map();

class HierarchyNode {
	constructor(member, level = 0, parent = null) {
		this.member = member;
		this.children = [];
		this.level = level;
		this.parent = parent;
		this.downline = getMemberRoleValue(member, 'Downline');

		idToHierarchyNode.set(member.id, this);
	}

	addChild(child) {
		this.children.push(child);
	}

	async backpropagateSponsored(personal = true) {
		this.member.roles.remove(await getOrCreateRoleByIndex(this.member.guild, 'Downline', this.downline));
		this.member.roles.add(await getOrCreateRoleByIndex(this.member.guild, 'Downline', ++this.downline));
	
		if (personal) {
			this.member.roles.remove(await getOrCreateRoleByIndex(this.member.guild, 'Personally Sponsored', this.children.length - 1));
			this.member.roles.add(await getOrCreateRoleByIndex(this.member.guild, 'Personally Sponsored', this.children.length));
		}

		if (this.parent) this.parent.backpropagateSponsored(false);
	}

	print() {
		console.log(`Member: ${this.member.displayName}, Parent: ${this.parent ? this.parent.member.displayName : 'None'} (${this.level}), Downline: ${this.downline}`);
		
		if (this.children.length === 0) return;

		console.log(`Personally Sponsored ${this.children.length}:`);

		for (const child of this.children)
			console.log(`- ${child.member.displayName} (Downline: ${child.downline})`);

		console.log();

		for (const child of this.children)
			child.print();
	}
}

const idToHierarchyNode = new Map();

const roleMap = new Map();
const ROLE_TYPES = ['BFS', 'Downline', 'Instructed', 'Personally Sponsored'];


const getRoleByName = async (guild, name) => {
	const roles = await guild.roles.fetch();
	return roles.find(role => role.name === name);
}

const getAndSetUpdatedInvite = async (guild) => {
	const invites = await guild.invites.fetch();
	const invite = invites.find(invite => {
		const cachedInvite = inviteMap.get(invite.code);
		return cachedInvite.uses < invite.uses;
	});

	inviteMap.set(invite.code, {
		inviter: invite.inviter,
		uses: invite.uses,
	});

	return invite;
}

const getOrCreateParentRole = async (guild, parentId) => {
	const parentRoleName = `Parent ${parentId}`;
	const parentRole = await getRoleByName(guild, parentRoleName);

	if (parentRole)
		return parentRole;

	return await guild.roles.create({
		name: parentRoleName,
		mentionable: true,
	});
}

const getRoleValue = role => parseInt(role.name.split(' ').pop());

const compareRoles = (role1, role2) => getRoleValue(role1) - getRoleValue(role2);

const getMemberRoleValue = (member, roleType) => {
	for (const role of member.roles.cache.values())
		if (role.name.startsWith(roleType))
			return getRoleValue(role);

	return -1;
}

const getMemberParentId = (member) => {
	for (const role of member.roles.cache.values())
		if (role.name.startsWith('Parent'))
			return role.name.split(' ')[1];

	return '';
}

const getOrCreateRoleByIndex = async (guild, roleType, index) => {
	if (index >= roleMap.get(roleType).length) {
		const role = await guild.roles.create({
			name: `${roleType} ${index}`,
			mentionable: true,
		});
	
		roleMap.get(roleType).push(role);
	}
	
	return roleMap.get(roleType)[index];
}

const refresh = async () => {
	const guild = await client.guilds.fetch(GUILD_ID);

	// Initialize invite map
	const invites = await guild.invites.fetch();

	for (const invite of invites.values()) {
		inviteMap.set(invite.code, {
			inviter: invite.inviter,
			uses: invite.uses,
		});
	}

	// Initialize role map
	const roles = await guild.roles.fetch();

	for (const roleType of ROLE_TYPES)
		roleMap.set(roleType, []);

	for (const role of roles.values())
		for (const roleType of ROLE_TYPES)
			if (role.name.startsWith(roleType))
				roleMap.get(roleType).push(role);

	for (const roleType of ROLE_TYPES)
		roleMap.get(roleType).sort(compareRoles);

	DEFAULT_ROLES.length = 0;
	DEFAULT_ROLES.push(
		roleMap.get('Downline')[0],
		roleMap.get('Instructed')[0],
		roleMap.get('Personally Sponsored')[0],
	);
	
	// Initialize hierarchy
	const members = await guild.members.fetch();

	const membersByLevel = new Map();

	for (const member of members.values()) {
		const level = getMemberRoleValue(member, 'BFS');

		if (!membersByLevel.has(level))
			membersByLevel.set(level, []);

		membersByLevel.get(level).push(member);
	}

	const root = new HierarchyNode(membersByLevel.get(0)[0]);

	for (let level = 1; membersByLevel.has(level); ++level) {
		for (const member of membersByLevel.get(level)) {
			const parentId = getMemberParentId(member);
			const parentNode = idToHierarchyNode.get(parentId);
			const node = new HierarchyNode(member, level, parentNode);
			parentNode.addChild(node);
		}
	}

	root.print();
};

client.on('ready', async () => {	
	console.log(`Logged in as ${client.user.tag}`);

	await refresh();
});

client.on('guildMemberAdd', async member => {
	console.log(`New member ${member.user.tag} has joined the server!`);

	member.roles.add(DEFAULT_ROLES);

	const updatedInvite = await getAndSetUpdatedInvite(member.guild);
	const parentId = updatedInvite.inviter.id;
	const parentNode = idToHierarchyNode.get(parentId);
	
	member.roles.add(await getOrCreateParentRole(member.guild, parentId));

	const node = new HierarchyNode(member, parentNode.level + 1, parentNode);
	parentNode.addChild(node);

	member.roles.add(await getOrCreateRoleByIndex(member.guild, 'BFS', parentNode.level + 1));

	await parentNode.backpropagateSponsored();
});

client.on('inviteCreate', async invite => {
	console.log(`Invite ${invite.code} has been created!`);

	inviteMap.set(invite.code, {
		inviter: invite.inviter,
		uses: invite.uses,
	});
});

client.on('interactionCreate', async interaction => {
	if (!interaction.isCommand()) return;

	const { commandName, member } = interaction;

	switch (commandName) {
		case 'refresh':
			console.log('\nRefreshing server data...');

			await refresh();

			await interaction.reply('Server data refreshed!');
			break;

		case 'incrementinstructed':
			{
				// can only increment instructed if instructed is at least 1
				const instructed = getMemberRoleValue(member, 'Instructed');
				
				if (instructed < 1) {
					await interaction.reply({ content: 'You do not have permission to increment instructed!', ephemeral: true });
					return;
				}

				member.roles.remove(await getOrCreateRoleByIndex(member.guild, 'Instructed', instructed));
				member.roles.add(await getOrCreateRoleByIndex(member.guild, 'Instructed', instructed + 1));

				console.log(`Instructed incremented to ${instructed + 1}!`);
				await interaction.reply(`Instructed incremented to ${instructed + 1}!`);
				break;
			}
		
		case 'decrementinstructed':
			{
				// can only decrement instructed if instructed is at least 1
				const instructed = getMemberRoleValue(member, 'Instructed');

				if (instructed < 1) {
					await interaction.reply({ content: 'You do not have any instructed to decrement!', ephemeral: true });
					return;
				}

				member.roles.remove(await getOrCreateRoleByIndex(member.guild, 'Instructed', instructed));
				member.roles.add(await getOrCreateRoleByIndex(member.guild, 'Instructed', instructed - 1));

				console.log(`Instructed decremented to ${instructed - 1}!`);
				await interaction.reply(`Instructed decremented to ${instructed - 1}!`);
				break;
			}

	}
});

client.login(TOKEN);

const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

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
