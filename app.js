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
const PERFORMANCE_CHART_CHANNEL_ID = '1181830899504001074';
const PERFORMANCE_CHART_MESSAGE_ID = '1182090580348645436';
const ORG_CHART_CHANNEL_ID = '1182131401047429240';
const ORG_CHART_MESSAGE_ID = '1182131704534667384';
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
		await this.member.roles.remove(await getOrCreateRoleByIndex(this.member.guild, 'Downline', this.downline));
		await this.member.roles.add(await getOrCreateRoleByIndex(this.member.guild, 'Downline', ++this.downline));
	
		if (personal) {
			await this.member.roles.remove(await getOrCreateRoleByIndex(this.member.guild, 'Personally Sponsored', this.children.length - 1));
			await this.member.roles.add(await getOrCreateRoleByIndex(this.member.guild, 'Personally Sponsored', this.children.length));
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

	printHierarchy(indent = '') {
		const isLastChild = !this.parent || this.parent.children[this.parent.children.length - 1] === this;
		const prefix = indent + (isLastChild ? '└─ ' : '├─ ');
		let representation = `\`${prefix}\`<@${this.member.id}>\n`; // Adjust according to how member details are stored

		for (let i = 0; i < this.children.length; i++) {
			const child = this.children[i];
			const nextIndent = indent + (isLastChild ? '   ' : '│  ');
			representation += child.printHierarchy(nextIndent);
		}

		return representation;
	}
}

const idToHierarchyNode = new Map();

const roleMap = new Map();
const ROLE_TYPES = ['BFS', 'Downline', 'Instructed', 'Personally Sponsored'];


const getRoleByName = async (guild, name) => {
	const roles = await guild.roles.fetch();
	return roles.find(role => role.name === name);
}

const getAndSetUpdatedInvite = async guild => {
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

const getMemberParentId = member => {
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
	await updatePerformanceChart(guild);
	
	const channel = await guild.channels.fetch(ORG_CHART_CHANNEL_ID);
	const message = await channel.messages.fetch(ORG_CHART_MESSAGE_ID);

	await message.edit(root.printHierarchy());
	console.log('Org chart updated!');
};

const updatePerformanceChart = async guild => {
	const members = await guild.members.fetch();
	const categories = ['Downline', 'Personally Sponsored', 'Instructed', 'BFS'];
	const memberMaps = new Map(categories.map(category => [category, new Map()]));

	for (const member of members.values()) {
		if (member.user.bot) continue;

		categories.forEach(category => {
			const value = getMemberRoleValue(member, category);
			if (!memberMaps.get(category).has(value))
				memberMaps.get(category).set(value, []);
			memberMaps.get(category).get(value).push(member);
		});
	}

	const channel = await guild.channels.fetch(PERFORMANCE_CHART_CHANNEL_ID);

	const embeds = [];
	const images = [];

	for (const category of categories) {
		const attachmentPath = `${category}.png`.replace(/ /g, '-');

		const embed = new Discord.EmbedBuilder()
			.setTitle(`${category} Leaderboard`)
			.setDescription(`This is the current leaderboard for **${category}**.`)
			.setColor(0x1ABC9C)
			.setTimestamp()
			.setFooter({ text: 'Last updated', iconUrl: `attachment://${attachmentPath}` })
			.setThumbnail(`attachment://${attachmentPath}`);

		// Sort members; if BFS, sort from min to max, else max to min
		const sortedMembers = [...memberMaps.get(category).entries()]
			.sort((a, b) => category === 'BFS' ? a[0] - b[0] : b[0] - a[0]);

		for (const [value, members] of sortedMembers) {
			const memberString = members.map(member => `<@${member.id}>`).join('\n');
			embed.addFields({ name: `Level ${value}`, value: memberString || 'No members', inline: true });
		}

		embeds.push(embed);
		images.push(new Discord.AttachmentBuilder(`images/${category}.png`, { name: `${attachmentPath}` }));

		// const message = await channel.messages.fetch(PERFORMANCE_CHART_MESSAGE_IDS.get(category));
		// await message.edit({
		// 	content: '🏆 **Leaderboard Update!** 🏆',
		// 	embeds: [embed],
		// 	files: [imageAttachment]
		// });
	}

	const message = await channel.messages.fetch(PERFORMANCE_CHART_MESSAGE_ID);
	await message.edit({
		content: '🏆 **Leaderboard Update!** 🏆',
		embeds: embeds,
		files: images,
	});

	console.log('All leaderboards updated!');
};

client.on('ready', async () => {	
	console.log(`Logged in as ${client.user.tag}`);

	await refresh();
});

client.on('guildMemberAdd', async member => {
	console.log(`New member ${member.user.tag} has joined the server!`);

	await member.roles.add(DEFAULT_ROLES);

	const updatedInvite = await getAndSetUpdatedInvite(member.guild);
	const parentId = updatedInvite.inviter.id;
	const parentNode = idToHierarchyNode.get(parentId);
	
	await member.roles.add(await getOrCreateParentRole(member.guild, parentId));

	const node = new HierarchyNode(member, parentNode.level + 1, parentNode);
	parentNode.addChild(node);

	await member.roles.add(await getOrCreateRoleByIndex(member.guild, 'BFS', parentNode.level + 1));

	await parentNode.backpropagateSponsored();
	await updatePerformanceChart(member.guild);
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

				await member.roles.remove(await getOrCreateRoleByIndex(member.guild, 'Instructed', instructed));
				await member.roles.add(await getOrCreateRoleByIndex(member.guild, 'Instructed', instructed + 1));

				console.log(`Instructed incremented to ${instructed + 1} for ${member.displayName}!`);
				await interaction.reply(`Instructed incremented to ${instructed + 1} for ${member.displayName}!`);
				await updatePerformanceChart(member.guild);
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

				await member.roles.remove(await getOrCreateRoleByIndex(member.guild, 'Instructed', instructed));
				await member.roles.add(await getOrCreateRoleByIndex(member.guild, 'Instructed', instructed - 1));

				console.log(`Instructed decremented to ${instructed - 1} for ${member.displayName}!`);
				await interaction.reply(`Instructed decremented to ${instructed - 1} for ${member.displayName}!`);
				await updatePerformanceChart(member.guild);
				break;
			}

	}
});

client.login(TOKEN);
