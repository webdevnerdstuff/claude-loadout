const BLOCK_SCALAR = /^([|>])([+-]?)\s*$/;

const unquote = (value: string): string => {
	const isDouble = value.startsWith('"') && value.endsWith('"');
	const isSingle = value.startsWith("'") && value.endsWith("'");
	if (value.length >= 2 && isDouble) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
	}
	if (value.length >= 2 && isSingle) {
		return value.slice(1, -1).replace(/''/g, "'");
	}

	return value;
};

const indentOf = (line: string): number =>
	line.length - line.trimStart().length;

// Reads the top-level `key: value` pairs of a SKILL.md frontmatter, enough YAML
// for names and descriptions: plain, quoted, folded (>) and literal (|) values.
export const parseFrontmatter = (text: string): Record<string, string> => {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	if (lines[0]?.trim() !== '---') return {};
	const end = lines.findIndex(
		(line, index) => index > 0 && line.trim() === '---',
	);
	const body = lines.slice(1, end < 0 ? lines.length : end);
	const fields: Record<string, string> = {};

	for (let index = 0; index < body.length; index++) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(body[index] ?? '');
		if (!match) continue;
		const key = match[1] ?? '';
		const rest = (match[2] ?? '').trim();
		const more: string[] = [];
		while (index + 1 < body.length) {
			const next = body[index + 1] ?? '';
			if (next.trim() !== '' && indentOf(next) === 0) break;
			more.push(next);
			index++;
		}
		const filled = more.filter((line) => line.trim() !== '');
		const indent = filled.length ? Math.min(...filled.map(indentOf)) : 0;
		const block = more.map((line) => line.slice(indent).trimEnd());
		const scalar = BLOCK_SCALAR.exec(rest);

		if (scalar?.[1] === '|') {
			fields[key] = block.join('\n').trim();
			continue;
		}
		if (scalar?.[1] === '>') {
			fields[key] = block
				.join('\n')
				.split(/\n\s*\n/)
				.map((paragraph) => paragraph.split('\n').join(' ').trim())
				.join('\n')
				.trim();
			continue;
		}
		const joined = [rest, ...block.filter((line) => line !== '')]
			.join(' ')
			.trim();
		fields[key] = unquote(joined);
	}

	return fields;
};

// Whether the text opens with a closed `---` frontmatter block.
export const hasFrontmatter = (text: string): boolean => {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	if (lines[0]?.trim() !== '---') return false;

	return lines.slice(1).some((line) => line.trim() === '---');
};

// The instructions under the frontmatter, or the whole text when it has none.
export const bodyOf = (text: string): string => {
	if (!hasFrontmatter(text)) return text;
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const end = lines.findIndex(
		(line, index) => index > 0 && line.trim() === '---',
	);

	return lines.slice(end + 1).join('\n');
};

// Relative files a SKILL.md links to (`[text](path)`), anchors and queries
// dropped; web, mail and in-page links left out.
export const linkedFiles = (text: string): string[] => {
	const found = [
		...bodyOf(text).matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g),
	]
		.map((match) => (match[1] ?? '').split('#')[0]?.split('?')[0] ?? '')
		.filter(
			(path) =>
				path !== '' &&
				!/^[a-z][a-z0-9+.-]*:/i.test(path) &&
				!path.startsWith('/') &&
				!path.startsWith('~'),
		)
		.map((path) => path.replace(/^\.\//, ''));

	return [...new Set(found)];
};

// Roughly how many tokens a text costs: about four characters each.
export const tokensOf = (text: string): number => Math.ceil(text.length / 4);
