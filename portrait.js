(function (root, factory) {
	"use strict";
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	if (root) root.Portrait = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
	"use strict";

	const P_WIDTH = 40;
	const P_HEIGHT = 64;
	const WHITE = [127, 127, 127];
	const GREY = [170, 170, 170];
	const DEAD = [128, 128, 150];
	// Stand-in for a disease tint. The game uses the active disease or event colour.
	const SICK = [80, 160, 70];
	const PLATE_MAX = 5;

	const COMPARATORS = {
		LESS: function (a, b) { return a < b; },
		GREATER: function (a, b) { return a > b; },
		GREATERE: function (a, b) { return a >= b; },
		EQUAL: function (a, b) { return a === b; },
		NEQUAL: function (a, b) { return a !== b; }
	};

	function Reader(content) {
		this.content = content;
		this.length = content.length;
		this.i = 0;
		this.line = 1;
	}

	Reader.prototype.isNewline = function () {
		const c = this.content.charAt(this.i);
		if (c === "\r" && this.i < this.length - 2 && this.content.charAt(this.i + 1) === "\n") {
			this.line++;
			this.i += 2;
			return true;
		}
		if (c === "\r" || c === "\n") {
			this.line++;
			this.i += 1;
			return true;
		}
		return false;
	};

	Reader.prototype.nextChar = function () {
		let comment = false;
		while (true) {
			if (this.i >= this.length - 1) return false;
			if (this.content.charAt(this.i) === "*" && this.i < this.length - 1 && this.content.charAt(this.i + 1) === "*") {
				comment = true;
				this.i++;
				continue;
			}
			if (this.isNewline()) {
				comment = false;
				continue;
			}
			const c = this.content.charAt(this.i);
			if (comment || c === " " || c === "\t") this.i++;
			else return true;
		}
	};

	Reader.prototype.getKey = function () {
		const startLine = this.line;
		let i2 = this.i;
		while (this.content.charAt(i2) !== ":") {
			if (i2 >= this.length - 1) {
				throw parseError("Expecting a keyword followed by ':'", startLine);
			}
			i2++;
		}
		const key = this.content.substring(this.i, i2).trim();
		this.i = i2 + 1;
		this.nextChar();
		return key;
	};

	Reader.prototype.findValue = function (open, close) {
		let nesting = 0;
		const start = this.i;
		const startLine = this.line;
		this.i++;
		while (true) {
			if (this.i >= this.length) {
				throw parseError("Expecting '" + close + "' followed by a comma", startLine);
			}
			if (this.isNewline()) continue;
			const c = this.content.charAt(this.i);
			if (c === close) {
				if ((this.i === this.length - 1 || this.content.charAt(this.i + 1) === ",") && nesting === 0) {
					const s = this.content.substring(start + 1, this.i);
					this.i += 2;
					return s;
				}
				nesting--;
			}
			if (c === open) nesting++;
			this.i++;
		}
	};

	Reader.prototype.getValue = function () {
		const c = this.content.charAt(this.i);
		const startLine = this.line;
		if (c === "\"") {
			return { type: "string", text: this.findValue("\"", "\""), line: startLine };
		}
		if (c === "{") {
			return parseContent(this.findValue("{", "}"), startLine);
		}
		if (c === "[") {
			const inner = this.findValue("[", "]");
			return { type: "array", items: parseArray(inner), line: startLine };
		}
		const start = this.i;
		while (++this.i < this.length) {
			if (this.isNewline()) throw parseError("Expecting a comma", startLine);
			if (this.content.charAt(this.i) === ",") {
				const text = this.content.substring(start, this.i);
				this.i++;
				return { type: "value", text: text, line: startLine };
			}
		}
		throw parseError("Expecting a comma", startLine);
	};

	function parseError(message, line) {
		const err = new Error(message + " (line " + line + ")");
		err.line = line;
		err.parse = true;
		return err;
	}

	function parseContent(content, line) {
		const reader = new Reader(content);
		reader.line = line || 1;
		const keys = [];
		const map = new Map();
		while (reader.nextChar()) {
			const key = reader.getKey();
			if (map.has(key)) throw parseError("Duplicate key " + key, reader.line);
			const value = reader.getValue();
			map.set(key, value);
			keys.push(key);
		}
		return { type: "object", keys: keys, map: map, line: line || 1 };
	}

	function parseArray(content) {
		const reader = new Reader(content);
		const items = [];
		while (reader.nextChar()) items.push(reader.getValue());
		return items;
	}

	function parseDocument(text, warnings, fileName) {
		let body = text;
		if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1);
		try {
			return parseContent(body, 1);
		} catch (err) {
			const where = fileName ? fileName + ": " : "";
			warnings.push(where + (err.parse ? err.message : "Could not read this file"));
			return null;
		}
	}

	function mergeNodes(base, overlay, jsonAdd, arrayAdd) {
		if (!base) return overlay;
		if (base.type !== overlay.type) return overlay;
		if (base.type === "object") {
			overlay.keys.forEach(function (key) {
				if (key === "_JSON_ADD" || key === "_ARRAY_ADD") return;
				const next = overlay.map.get(key);
				if (base.map.has(key)) {
					if (jsonAdd) base.map.set(key, mergeNodes(base.map.get(key), next, jsonAdd, arrayAdd));
					else base.map.set(key, next);
				} else {
					base.keys.push(key);
					base.map.set(key, next);
				}
			});
			return base;
		}
		if (base.type === "array") {
			if (!arrayAdd) return overlay;
			return { type: "array", items: base.items.concat(overlay.items), line: base.line };
		}
		return overlay;
	}

	function mergeDocuments(docs) {
		let base = null;
		docs.forEach(function (doc) {
			if (!doc) return;
			if (!base) {
				base = doc;
				return;
			}
			const jsonAdd = doc.map.has("_JSON_ADD");
			const arrayAdd = jsonAdd && doc.map.has("_ARRAY_ADD");
			mergeNodes(base, doc, jsonAdd, arrayAdd);
		});
		return base;
	}

	// Sources are vanilla plus the mods in launcher order, where the lowest number wins.
	// Text files stack from vanilla up to mod 0. For an image, the first copy found is used.
	// _IgnoreVanilla.txt hides vanilla files that no mod supplies. It does not hide other mods.
	function layerSources(vanilla, mods) {
		const images = new Map();
		const vanillaSprites = new Map();
		if (vanilla) {
			vanilla.sprites.forEach(function (file) { vanillaSprites.set(spriteKey(file.name), file); });
			vanilla.images.forEach(function (image, name) { images.set(name, image); });
		}
		const names = new Set();
		let hideVanilla = false;
		mods.forEach(function (mod) {
			if (mod.ignoreVanilla) hideVanilla = true;
			mod.sprites.forEach(function (file) { names.add(spriteKey(file.name)); });
		});
		if (!hideVanilla) vanillaSprites.forEach(function (file, name) { names.add(name); });
		for (let m = mods.length - 1; m >= 0; m--) {
			mods[m].images.forEach(function (image, name) { images.set(name, image); });
		}
		const sprites = Array.from(names).sort().map(function (name) {
			const files = [];
			if (vanillaSprites.has(name)) files.push(vanillaSprites.get(name));
			for (let m = mods.length - 1; m >= 0; m--) {
				mods[m].sprites.forEach(function (file) {
					if (spriteKey(file.name) === name) files.push(file);
				});
			}
			return { name: name, files: files };
		});
		return { sprites: sprites, images: images };
	}

	// ModInfo.bestVersion, including its fallback when no folder matches the game.
	function bestVersion(folderNames, major) {
		let best = -1;
		const sorted = folderNames.filter(function (name) { return name.charAt(0) !== "_"; }).sort();
		for (let i = 0; i < sorted.length; i++) {
			const name = sorted[i];
			if (name.length < 2 || name.charAt(0) !== "V" || !/^[+-]?\d+$/.test(name.slice(1))) continue;
			const version = parseInt(name.slice(1), 10);
			if (major == null) {
				if (version > best) best = version;
				continue;
			}
			if (version === major) return version;
			if (major - version > best) best = version;
		}
		return best === -1 ? null : best;
	}

	function gameVersion(patchnotes) {
		const match = /^\d{4}-\d{2}-\d{2}\s+(0\.(\d+)\.\d+)/m.exec(patchnotes || "");
		return match ? { label: match[1], major: parseInt(match[2], 10) } : null;
	}

	function spriteKey(fileName) {
		const base = fileName.split(/[/\\]/).pop();
		if (!base || base.charAt(0) === "_") return null;
		if (!/\.txt$/i.test(base)) return null;
		return base.slice(0, -4);
	}

	function faceKey(fileName) {
		const base = fileName.split(/[/\\]/).pop();
		if (!base || !/\.png$/i.test(base)) return null;
		return base.slice(0, -4);
	}

	const ZIP_FACE_FOLDER = "data/assets/sprite/race/face/";
	const ZIP_SPRITE_FOLDER = "data/assets/init/race/sprite/";
	const ZIP_PATCHNOTES = "base/txt/Patchnotes.txt";
	const ZIP_EOCD_MAX = 22 + 65535;

	function zipError(message, unsupported) {
		const err = new Error(message);
		err.unsupported = !!unsupported;
		return err;
	}

	async function viewOf(blob, start, end) {
		return new DataView(await blob.slice(start, end).arrayBuffer());
	}

	// Reads the index at the end of the zip. Only the byte ranges asked for are read.
	async function openZip(blob) {
		const tailStart = Math.max(0, blob.size - ZIP_EOCD_MAX);
		const tail = await viewOf(blob, tailStart, blob.size);
		let eocd = -1;
		for (let i = tail.byteLength - 22; i >= 0; i--) {
			if (tail.getUint32(i, true) === 0x06054B50 && i + 22 + tail.getUint16(i + 20, true) <= tail.byteLength) {
				eocd = i;
				break;
			}
		}
		if (eocd < 0) throw zipError("This is not a zip file");
		const count = tail.getUint16(eocd + 10, true);
		const directorySize = tail.getUint32(eocd + 12, true);
		const directoryStart = tail.getUint32(eocd + 16, true);
		const hasLocator = eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064B50;
		if (hasLocator || count === 0xFFFF || directorySize === 0xFFFFFFFF || directoryStart === 0xFFFFFFFF) {
			throw zipError("This zip uses Zip64, which this page cannot read yet", true);
		}
		const directory = await viewOf(blob, directoryStart, directoryStart + directorySize);
		const bytes = new Uint8Array(directory.buffer, directory.byteOffset, directory.byteLength);
		const decoder = new TextDecoder("utf-8");
		const entries = new Map();
		let at = 0;
		for (let i = 0; i < count; i++) {
			if (at + 46 > directory.byteLength || directory.getUint32(at, true) !== 0x02014B50) {
				throw zipError("This zip's file list is damaged");
			}
			const nameLength = directory.getUint16(at + 28, true);
			const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
			entries.set(path, {
				path: path,
				flags: directory.getUint16(at + 8, true),
				method: directory.getUint16(at + 10, true),
				compressedSize: directory.getUint32(at + 20, true),
				localOffset: directory.getUint32(at + 42, true)
			});
			at += 46 + nameLength + directory.getUint16(at + 30, true) + directory.getUint16(at + 32, true);
		}
		return { blob: blob, entries: entries };
	}

	async function readZipEntry(blob, entry, type) {
		if (entry.flags & 1) throw zipError(entry.path + " is encrypted", true);
		if (entry.compressedSize === 0xFFFFFFFF || entry.localOffset === 0xFFFFFFFF) {
			throw zipError(entry.path + " uses Zip64, which this page cannot read yet", true);
		}
		if (entry.method !== 0 && entry.method !== 8) {
			throw zipError(entry.path + " uses a compression method this page cannot read", true);
		}
		const header = await viewOf(blob, entry.localOffset, entry.localOffset + 30);
		if (header.byteLength < 30 || header.getUint32(0, true) !== 0x04034B50) throw zipError(entry.path + " is damaged");
		const start = entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
		const data = blob.slice(start, start + entry.compressedSize, type || "");
		if (entry.method === 0) return data;
		const inflated = data.stream().pipeThrough(new DecompressionStream("deflate-raw"));
		const out = await new Response(inflated).blob();
		return out.slice(0, out.size, type || "");
	}

	function isGameZip(zip) {
		let faces = false;
		let sprites = false;
		zip.entries.forEach(function (entry, path) {
			if (path.indexOf(ZIP_FACE_FOLDER) === 0) faces = true;
			if (path.indexOf(ZIP_SPRITE_FOLDER) === 0) sprites = true;
		});
		return faces && sprites;
	}

	function zipFolderEntries(zip, folder) {
		const found = [];
		zip.entries.forEach(function (entry, path) {
			if (path.indexOf(folder) !== 0) return;
			const name = path.slice(folder.length);
			if (name && name.indexOf("/") < 0) found.push({ name: name, entry: entry });
		});
		return found;
	}

	// A dropped item. list() and read() go back to the file on disk, so edits are seen
	// on the next read. Nothing is sent anywhere.
	function entryNode(entry) {
		return {
			name: entry.name,
			isDirectory: entry.isDirectory,
			list: async function () {
				const reader = entry.createReader();
				const nodes = [];
				while (true) {
					const batch = await new Promise(function (resolve, reject) { reader.readEntries(resolve, reject); });
					if (!batch.length) return nodes;
					batch.forEach(function (child) { nodes.push(entryNode(child)); });
				}
			},
			read: function () {
				return new Promise(function (resolve, reject) { entry.file(resolve, reject); });
			}
		};
	}

	function fileNode(file) {
		return {
			name: file.name,
			isDirectory: false,
			list: function () { return Promise.resolve([]); },
			read: function () { return Promise.resolve(file); }
		};
	}

	// webkitGetAsEntry reads folders under Program Files and AppData, where the game and
	// its mods live. getAsFileSystemHandle never settles for those folders, so it is not used.
	// Browsers empty the drop's item list once the event ends, so ask for everything here.
	function dropNodes(dataTransfer) {
		const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
		const nodes = [];
		items.forEach(function (item) {
			if (item.kind !== "file") return;
			const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
			const file = !entry && item.getAsFile ? item.getAsFile() : null;
			if (entry) nodes.push(entryNode(entry));
			else if (file) nodes.push(fileNode(file));
		});
		if (!items.length && dataTransfer.files) {
			Array.from(dataTransfer.files).forEach(function (file) { nodes.push(fileNode(file)); });
		}
		return nodes;
	}

	function findNode(nodes, name, wantDirectory) {
		const kind = nodes.filter(function (node) { return node.isDirectory === wantDirectory; });
		const exact = kind.filter(function (node) { return node.name === name; })[0];
		if (exact) return exact;
		const lower = name.toLowerCase();
		return kind.filter(function (node) { return node.name.toLowerCase() === lower; })[0] || null;
	}

	async function listFolderAt(root, names) {
		let nodes = root;
		for (let i = 0; i < names.length; i++) {
			const next = findNode(nodes, names[i], true);
			if (!next) return [];
			nodes = await next.list();
		}
		return nodes;
	}

	function textOf(node) {
		if (!node) return "";
		return String(node.text == null ? "" : node.text).trim();
	}

	function readInt(node, fallback) {
		if (!node || (node.type !== "value" && node.type !== "string")) return { ok: false, value: fallback };
		const n = parseInt(textOf(node), 10);
		if (Number.isNaN(n)) return { ok: false, value: fallback };
		return { ok: true, value: n };
	}

	function readFloat(node, fallback) {
		if (!node || (node.type !== "value" && node.type !== "string")) return { ok: false, value: fallback };
		const n = parseFloat(textOf(node));
		if (Number.isNaN(n)) return { ok: false, value: fallback };
		return { ok: true, value: n };
	}

	function readBool(node, fallback, warnings, label) {
		if (!node) return fallback;
		const t = textOf(node);
		if (t === "true") return true;
		if (t === "false") return false;
		warnings.push(label + " is not true or false");
		return fallback;
	}

	function halve(n) {
		return Math.trunc(n / 2) & 255;
	}

	function parseRgbText(text, warnings, label) {
		const parts = text.trim().split("_");
		if (parts.length !== 3) {
			warnings.push(label + " should be RED_GREEN_BLUE");
			return WHITE.slice();
		}
		const nums = [];
		for (let i = 0; i < 3; i++) {
			const n = parseInt(parts[i].trim(), 10);
			if (Number.isNaN(n)) {
				warnings.push(label + " should be RED_GREEN_BLUE");
				return WHITE.slice();
			}
			nums.push(halve(n));
		}
		return nums;
	}

	function colorFromChannels(obj, warnings, label) {
		const out = [0, 0, 0];
		["R", "G", "B"].forEach(function (key, index) {
			const got = readInt(obj.map.get(key), 0);
			if (!got.ok) warnings.push(label + " is missing " + key);
			else if (got.value < 0) warnings.push(label + " " + key + " is below 0");
			out[index] = halve(got.ok ? got.value : 0);
		});
		return out;
	}

	function readSingleColor(node, warnings, label) {
		if (!node) {
			warnings.push(label + " is missing");
			return WHITE.slice();
		}
		if (node.type === "value" || node.type === "string") return parseRgbText(textOf(node), warnings, label);
		if (node.type === "object" && node.map.has("R")) return colorFromChannels(node, warnings, label);
		warnings.push(label + " is not a colour");
		return WHITE.slice();
	}

	function interpolateColors(from, to, amount) {
		if (amount <= 1) return [from.slice()];
		const res = [];
		let r = from[0];
		let g = from[1];
		let b = from[2];
		const dr = (to[0] - r) / (amount - 1);
		const dg = (to[1] - g) / (amount - 1);
		const db = (to[2] - b) / (amount - 1);
		for (let i = 0; i < amount; i++) {
			res.push([Math.trunc(r) & 255, Math.trunc(g) & 255, Math.trunc(b) & 255]);
			r += dr;
			g += dg;
			b += db;
		}
		return res;
	}

	function readColorList(node, warnings, label) {
		if (!node) {
			warnings.push(label + " is missing");
			return [WHITE.slice()];
		}
		if (node.type === "value" || node.type === "string") return [parseRgbText(textOf(node), warnings, label)];
		if (node.type === "object") {
			if (node.map.has("R") && node.map.has("G") && node.map.has("B")) return [colorFromChannels(node, warnings, label)];
			if (node.map.has("FROM") && node.map.has("TO")) {
				const amount = readInt(node.map.get("GENERATE"), 0);
				const from = readSingleColor(node.map.get("FROM"), warnings, label + " FROM");
				const to = readSingleColor(node.map.get("TO"), warnings, label + " TO");
				if (!amount.ok || amount.value < 1) {
					warnings.push(label + " GENERATE needs a count");
					return [from];
				}
				return interpolateColors(from, to, amount.value);
			}
			warnings.push(label + " is not a colour");
			return [WHITE.slice()];
		}
		if (node.type === "array") {
			let objects = 0;
			let bare = 0;
			const cols = [];
			node.items.forEach(function (item) {
				if (item.type === "object") objects++;
				else bare++;
				readColorList(item, warnings, label).forEach(function (c) { cols.push(c); });
			});
			if (objects && bare) warnings.push(label + " mixes colour forms");
			return cols.length ? cols : [WHITE.slice()];
		}
		warnings.push(label + " is not a colour");
		return [WHITE.slice()];
	}

	function shadeChannels(color, amount) {
		return color.map(function (channel) {
			return Math.trunc(channel * amount) & 255;
		});
	}

	function fillSlots(list, randomize, warnings, label) {
		const listed = list.slice(0, 16);
		if (list.length > 16) warnings.push(label + " has more than 16 colours");
		const slots = new Array(16);
		if (randomize != null) {
			for (let i = 0; i < listed.length; i++) slots[i] = listed[i].slice();
			for (let i = listed.length; i < 16; i++) {
				const src = listed[i % listed.length];
				slots[i] = shadeChannels(src, 1 - randomize * (i / 16));
			}
		} else {
			for (let i = 0; i < 16; i++) {
				let idx = Math.floor(listed.length * i / 16);
				if (idx < 0) idx = 0;
				if (idx > listed.length - 1) idx = listed.length - 1;
				slots[i] = listed[idx];
			}
		}
		return slots;
	}

	function readColors(doc, warnings) {
		const block = doc && doc.map.get("COLORS");
		const collections = [];
		const byName = new Map();
		if (!block || block.type !== "object") {
			warnings.push("COLORS is missing");
			return { list: collections, byName: byName };
		}
		block.keys.forEach(function (name, index) {
			const node = block.map.get(name);
			if (!node || node.type !== "object") {
				warnings.push("Colour " + name + " is not a block");
				return;
			}
			const values = readColorList(node.map.get("VALUES"), warnings, name);
			let randomize = null;
			if (node.map.has("GENERATE_RANDOMIZE")) {
				const got = readFloat(node.map.get("GENERATE_RANDOMIZE"), 0);
				if (got.ok) randomize = got.value;
				else warnings.push(name + " GENERATE_RANDOMIZE is not a number");
			}
			const col = {
				name: name,
				index: index,
				slots: fillSlots(values, randomize, warnings, name),
				gray: readBool(node.map.get("TURNS_GRAY_WHEN_OLD"), false, warnings, name + " TURNS_GRAY_WHEN_OLD"),
				whiteDead: readBool(node.map.get("TURNS_WHITE_WHEN_DEAD"), false, warnings, name + " TURNS_WHITE_WHEN_DEAD"),
				sick: readBool(node.map.get("TURNS_SICKLY"), false, warnings, name + " TURNS_SICKLY"),
				pick: node.map.has("PICK_BY_STAT") ? textOf(node.map.get("PICK_BY_STAT")) : null
			};
			collections.push(col);
			byName.set(name, col);
		});
		return { list: collections, byName: byName };
	}

	function readConditions(node, warnings, label) {
		if (!node) return [];
		if (node.type !== "object") {
			warnings.push(label + " CONDITIONS is not a block");
			return [];
		}
		const locks = [];
		node.keys.forEach(function (key) {
			const comp = COMPARATORS[key];
			const body = node.map.get(key);
			if (!comp || !body || body.type !== "object") {
				warnings.push(label + " has an unknown condition " + key);
				return;
			}
			body.keys.forEach(function (stat) {
				const got = readFloat(body.map.get(stat), 0);
				if (!got.ok) warnings.push(label + " " + stat + " is not a number");
				locks.push({ comp: comp, stat: stat, value: got.value });
			});
		});
		return locks;
	}

	function warnRange(warnings, label, value, min) {
		if (value < min) warnings.push(label + " is " + value + ", below " + min);
	}

	function readFace(block, warnings, label) {
		const face = block && block.map.get("FACE");
		if (!face) return [];
		if (face.type !== "array") {
			warnings.push(label + " FACE is not a list");
			return [];
		}
		const parts = [];
		face.items.forEach(function (item, index) {
			if (!item || item.type !== "object") {
				warnings.push(label + " face part " + (index + 1) + " is not a block");
				return;
			}
			const partLabel = label + " part " + (index + 1);
			let random = index % 16;
			if (item.map.has("FRAME_RANDOM")) {
				const got = readInt(item.map.get("FRAME_RANDOM"), random);
				if (!got.ok) warnings.push(partLabel + " FRAME_RANDOM is not an integer");
				else {
					random = got.value;
					warnRange(warnings, partLabel + " FRAME_RANDOM", random, 0);
				}
			}
			let occurrence = 16;
			if (item.map.has("FRAME_OCCURRENCE")) {
				const got = readFloat(item.map.get("FRAME_OCCURRENCE"), 1);
				if (!got.ok) warnings.push(partLabel + " FRAME_OCCURRENCE is not a number");
				else {
					if (got.value < 0 || got.value > 1) warnings.push(partLabel + " FRAME_OCCURRENCE is outside 0 to 1");
					occurrence = Math.trunc(16 * got.value);
				}
			}
			function optionalInt(key, fallback, min) {
				if (!item.map.has(key)) return fallback;
				const got = readInt(item.map.get(key), fallback);
				if (!got.ok) {
					warnings.push(partLabel + " " + key + " is not an integer");
					return fallback;
				}
				warnRange(warnings, partLabel + " " + key, got.value, min);
				return got.value;
			}
			let opacity = 255;
			if (item.map.has("OPACITY")) {
				const got = readInt(item.map.get("OPACITY"), 255);
				if (!got.ok) warnings.push(partLabel + " OPACITY is not an integer");
				else {
					opacity = got.value;
					if (opacity < 0 || opacity > 255) warnings.push(partLabel + " OPACITY is outside 0 to 255");
					if (opacity < 0) opacity = 0;
					if (opacity > 255) opacity = 255;
				}
			}
			parts.push({
				index: index,
				frames: readFrames(item.map.get("FRAMES"), warnings, partLabel),
				random: random,
				occurrence: occurrence,
				dx: optionalInt("OFF_X", 0, -40),
				dy: optionalInt("OFF_Y", 0, -48),
				dxr: optionalInt("OFF_X_RANDOM", 0, 0),
				dyr: optionalInt("OFF_Y_RANDOM", 0, 0),
				conditions: readConditions(item.map.get("CONDITIONS"), warnings, partLabel),
				color: item.map.has("COLOR") ? textOf(item.map.get("COLOR")) : null,
				opacity: opacity,
				stains: readBool(item.map.get("STAINS"), true, warnings, partLabel + " STAINS")
			});
		});
		return parts;
	}

	function readFrames(node, warnings, label) {
		if (!node || node.type !== "array") {
			warnings.push(label + " has no FRAMES list");
			return [];
		}
		const frames = [];
		node.items.forEach(function (item) {
			if (!item || item.type !== "value") {
				warnings.push(label + " has a frame that is not File: number");
				return;
			}
			const parts = item.text.split(":");
			if (parts.length !== 2) {
				warnings.push(label + " has a frame that is not File: number");
				return;
			}
			const file = parts[0].trim();
			const index = parseInt(parts[1].trim(), 10);
			if (!file || Number.isNaN(index)) {
				warnings.push(label + " has a frame that is not File: number");
				return;
			}
			frames.push({ file: file, index: index });
		});
		return frames;
	}

	function buildAppearance(doc, warnings, name) {
		const colors = readColors(doc, warnings);
		let blood = [0, 0, 0];
		if (doc && doc.map.has("COLOR_BLOOD")) blood = readSingleColor(doc.map.get("COLOR_BLOOD"), warnings, name + " COLOR_BLOOD");
		else warnings.push(name + " has no COLOR_BLOOD");
		const types = [];
		const typesNode = doc && doc.map.get("TYPES");
		if (!typesNode || typesNode.type !== "array") warnings.push(name + " has no TYPES list");
		else {
			typesNode.items.forEach(function (item, index) {
				if (!item || item.type !== "object") {
					warnings.push(name + " type " + (index + 1) + " is not a block");
					return;
				}
				const label = typesNode.items.length === 1 ? "Adult" : "Adult " + (index + 1);
				types.push({ kind: "adult", label: label, face: readFace(item, warnings, name + " " + label) });
			});
		}
		let childFace = [];
		if (doc && doc.map.get("CHILD") && doc.map.get("CHILD").type === "object") {
			childFace = readFace(doc.map.get("CHILD"), warnings, name + " Child");
		}
		types.push({ kind: "child", label: "Child", face: childFace });
		return { name: name, colors: colors, blood: blood, types: types };
	}

	function appearancesFromSources(groups, warnings) {
		return groups.map(function (group) {
			const docs = [];
			group.files.forEach(function (file) {
				const doc = parseDocument(file.text, warnings, group.name + ".txt");
				if (doc) docs.push(doc);
			});
			const merged = mergeDocuments(docs);
			if (!merged) return null;
			return buildAppearance(merged, warnings, group.name);
		}).filter(Boolean);
	}

	const DAYS_PER_YEAR = 16;
	const DEATH_YEARS = 100;

	function randomArrival(kind, rng) {
		const span = 1 + Math.ceil(DEATH_YEARS * DAYS_PER_YEAR);
		let days = 0;
		if (kind !== "child") {
			const min = 1;
			const max = Math.trunc(0.5 * DEATH_YEARS * DAYS_PER_YEAR);
			let width = max - min;
			if (width <= 0) width = 1;
			days = min + rng.int(width);
		}
		let age = days / span;
		if (age < 0) age = 0;
		if (age > 1) age = 1;
		let grime = 0;
		if (rng.int(8) === 7) {
			const unit = rng.float();
			let add = Math.trunc(15 * unit * unit);
			if (add === 0) add = 1;
			const dirt = Math.min(15, add);
			grime = (dirt >> 1) / 7;
		}
		return {
			age: age,
			grime: grime,
			injury: 0,
			plate: 0,
			dead: false,
			noble: false,
			slave: false,
			parent: false,
			retired: false,
			sick: false
		};
	}

	function intsFromSeed(seed) {
		let x = seed >>> 0;
		const ints = [];
		for (let i = 0; i < 4; i++) {
			x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
			let z = (x + Math.imul(i + 1, 0x9E3779B9)) >>> 0;
			z = Math.imul(z ^ (z >>> 16), 0x7FEB352D) >>> 0;
			z = Math.imul(z ^ (z >>> 15), 0x846CA68B) >>> 0;
			ints.push((z ^ (z >>> 16)) >>> 0);
		}
		return ints;
	}

	function toSigned(u) {
		return u > 0x7FFFFFFF ? u - 0x100000000 : u;
	}

	function bitGet(ints, startBit, bits) {
		startBit &= 127;
		const ii = Math.floor(startBit / 32);
		const a = BigInt(ints[ii] >>> 0);
		const b = BigInt(ints[(ii + 1) & 3] >>> 0);
		let value = a | (b << 32n);
		value >>= BigInt(startBit & 31);
		const mask = bits >= 31 ? 0x7FFFFFFFn : ((1n << BigInt(bits)) - 1n);
		value &= mask;
		return Number(value);
	}

	function writeByte(ints, bit, value) {
		const word = Math.floor(bit / 32);
		const shift = bit & 31;
		const mask = (0xFF << shift) >>> 0;
		ints[word] = ((ints[word] & (~mask >>> 0)) | (((value & 255) << shift) >>> 0)) >>> 0;
	}

	function randomByte(ints, index) {
		return bitGet(ints, 64 + 8 * index, 31) & 255;
	}

	function javaMod(a, m) {
		let remainder = a % m;
		if (remainder < 0) remainder += m;
		return remainder;
	}

	const warnedStats = new Set();

	function readStat(name, subject, warnings) {
		if (name === "POPULATION_AGE_F") return subject.age;
		if (name === "APPEARANCE_DEAD_I") return subject.dead ? 1 : 0;
		if (name === "CLASS_NOBLE") return subject.noble ? 1 : 0;
		if (name === "TYPE_SLAVE") return (subject.role || (subject.slave ? "slave" : "citizen")) === "slave" ? 1 : 0;
		if (name === "TYPE_PARENT") return subject.role === "parent" ? 1 : 0;
		if (name === "TYPE_PARENT_SLAVE") return subject.role === "parent-slave" ? 1 : 0;
		if (name === "TYPE_CHILD") return subject.role === "child" ? 1 : 0;
		if (name === "TYPE_CHILD_SLAVE") return subject.role === "child-slave" ? 1 : 0;
		if (name === "EQUIP_BATTLE_ARMOUR_PLATE_I") return subject.plate;
		let match = /^RANDOM_(\d)_F$/.exec(name);
		if (match) return randomByte(subject.ints, Number(match[1])) / 255;
		match = /^RANDOM_(\d)_I$/.exec(name);
		if (match) return randomByte(subject.ints, Number(match[1]));
		if (!warnedStats.has(name)) {
			warnedStats.add(name);
			warnings.push(name + " is not one of the subject values, so it counts as 0");
		}
		return 0;
	}

	function conditionsPass(locks, subject, warnings) {
		for (let i = 0; i < locks.length; i++) {
			const lock = locks[i];
			if (!lock.comp(readStat(lock.stat, subject, warnings), lock.value)) return false;
		}
		return true;
	}

	function frameChoice(part, subject, pick, warnings) {
		const count = part.frames.length;
		const ran = count ? (bitGet(subject.ints, part.random * 16, 31) & 255) : 0;
		const pinned = pick != null && count > 0;
		let index = 0;
		if (count) index = pinned ? ((pick % count) + count) % count : ran % count;
		const allowed = conditionsPass(part.conditions, subject, warnings || []);
		const occurs = part.occurrence > (ran & 15);
		return {
			index: index,
			count: count,
			ran: ran,
			pinned: pinned,
			shown: count > 0 && (pinned || (allowed && occurs))
		};
	}

	function colorAdd(ca, cb) {
		const ci = 1 / 127;
		return ca.map(function (channel, index) {
			let r = channel & 255;
			const r2 = cb[index] & 255;
			if (r2 > 127) r += r2 - 127;
			else r = Math.trunc(r * (r2 * ci));
			if (r > 255) r = 255;
			return r;
		});
	}

	function collectionColor(col, subject, warnings) {
		if (subject.retired && col.gray) return GREY.slice();
		let slot;
		if (col.pick) {
			if (col.pick === "EQUIP_BATTLE_ARMOUR_PLATE") {
				slot = javaMod(Math.trunc((subject.plate / PLATE_MAX) * 15), 16);
			} else {
				if (!warnedStats.has("stat:" + col.pick)) {
					warnedStats.add("stat:" + col.pick);
					warnings.push(col.pick + " is not wired to a knob, so " + col.name + " is picked at random");
				}
				const raw = bitGet(subject.ints, 64, 31);
				slot = javaMod(raw >> ((col.index & 15) * 4), 16);
			}
		} else {
			const raw = bitGet(subject.ints, 64, 31);
			slot = javaMod(raw >> ((col.index & 15) * 4), 16);
		}
		let color = col.slots[slot].slice();
		if (subject.dead && col.whiteDead) {
			color = color.map(function (channel, index) {
				return Math.round(channel * 0.7 + DEAD[index] * 0.3);
			});
		}
		if (subject.sick && col.sick) color = colorAdd(color, SICK);
		return color;
	}

	function shadeSelf(color) {
		return color.map(function (channel) {
			return Math.trunc((channel & 255) * 1.2) & 255;
		});
	}

	const frameCache = new WeakMap();

	function alphaAt(image, x, y) {
		return image.data[(y * image.width + x) * 4 + 3];
	}

	function edgePaper(image, sx, sy) {
		const paper = new Uint8Array(40 * 48);
		const tone = new Int16Array(40 * 48);
		const gray = new Uint8Array(40 * 48);
		for (let y = 0; y < 48; y++) {
			for (let x = 0; x < 40; x++) {
				const si = ((sy + y) * image.width + (sx + x)) * 4;
				const r = image.data[si];
				const g = image.data[si + 1];
				const b = image.data[si + 2];
				const a = image.data[si + 3];
				const k = y * 40 + x;
				if (a === 0) {
					tone[k] = -1;
					continue;
				}
				const hi = r > g ? (r > b ? r : b) : (g > b ? g : b);
				const lo = r < g ? (r < b ? r : b) : (g < b ? g : b);
				tone[k] = lo;
				gray[k] = hi - lo <= 12 ? 1 : 0;
			}
		}
		const stack = [];
		function flood(x, y) {
			if (x < 0 || y < 0 || x >= 40 || y >= 48) return;
			const k = y * 40 + x;
			if (paper[k] || tone[k] !== 255) return;
			paper[k] = 1;
			stack.push(k);
		}
		for (let x = 0; x < 40; x++) {
			flood(x, 0);
			flood(x, 47);
		}
		for (let y = 0; y < 48; y++) {
			flood(0, y);
			flood(39, y);
		}
		while (stack.length) {
			const k = stack.pop();
			const x = k % 40;
			const y = (k / 40) | 0;
			flood(x - 1, y);
			flood(x + 1, y);
			flood(x, y - 1);
			flood(x, y + 1);
		}
		let changed = true;
		while (changed) {
			changed = false;
			const peel = [];
			for (let y = 0; y < 48; y++) {
				for (let x = 0; x < 40; x++) {
					const k = y * 40 + x;
					if (paper[k] || tone[k] < 200 || !gray[k]) continue;
					let inward = 256;
					let touches = false;
					const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
					for (let i = 0; i < 4; i++) {
						const nx = x + dirs[i][0];
						const ny = y + dirs[i][1];
						const outside = nx < 0 || ny < 0 || nx >= 40 || ny >= 48;
						if (!outside && !paper[ny * 40 + nx]) continue;
						touches = true;
						const ix = x - dirs[i][0];
						const iy = y - dirs[i][1];
						if (ix < 0 || iy < 0 || ix >= 40 || iy >= 48) continue;
						const ik = iy * 40 + ix;
						if (paper[ik] || tone[ik] < 0) continue;
						if (tone[ik] < inward) inward = tone[ik];
					}
					if (touches && inward < 256 && tone[k] >= inward + 40) peel.push(k);
				}
			}
			for (let i = 0; i < peel.length; i++) {
				if (!paper[peel[i]]) {
					paper[peel[i]] = 1;
					changed = true;
				}
			}
		}
		return paper;
	}

	function trimFrame(image, frameIndex) {
		if (!image || image.width !== 416 || image.height < 60) return null;
		const framesY = Math.floor(image.height / 60);
		if (frameIndex < 0 || frameIndex >= framesY * 4) return null;
		let cached = frameCache.get(image);
		if (!cached) {
			cached = new Map();
			frameCache.set(image, cached);
		}
		if (cached.has(frameIndex)) return cached.get(frameIndex);
		const fx = frameIndex % 4;
		const fy = Math.floor(frameIndex / 4);
		const sx = 6 + 52 * fx;
		const sy = 6 + 60 * fy;
		let y1 = sy;
		let y2 = sy + 48;
		for (let dy = 0; dy < 48; dy++) {
			let opaque = false;
			for (let dx = 0; dx < 40; dx++) {
				if (alphaAt(image, sx + dx, y1) !== 0) {
					opaque = true;
					break;
				}
			}
			if (opaque) break;
			y1++;
		}
		for (let dy = 0; dy < 48; dy++) {
			let opaque = false;
			for (let dx = 0; dx < 40; dx++) {
				if (alphaAt(image, sx + dx, y2 - 1) !== 0) {
					opaque = true;
					break;
				}
			}
			if (opaque) break;
			y2--;
		}
		let offY = y1 - sy;
		let rows = Math.ceil((y2 - y1) / 8);
		if (rows <= 0) {
			const empty = { offY: 0, rows: 0, pixels: null };
			cached.set(frameIndex, empty);
			return empty;
		}
		if (y1 + rows * 8 > sy + 48) {
			y1 = sy + 48 - rows * 8;
			offY = y1 - sy;
		}
		const height = rows * 8;
		const pixels = new Uint8ClampedArray(40 * height * 4);
		const paper = edgePaper(image, sx, sy);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < 40; x++) {
				const si = ((y1 + y) * image.width + (sx + x)) * 4;
				const di = (y * 40 + x) * 4;
				pixels[di] = image.data[si];
				pixels[di + 1] = image.data[si + 1];
				pixels[di + 2] = image.data[si + 2];
				const localY = y1 - sy + y;
				pixels[di + 3] = paper[localY * 40 + x] ? 0 : image.data[si + 3];
			}
		}
		const frame = { offY: offY, rows: rows, pixels: pixels };
		cached.set(frameIndex, frame);
		return frame;
	}

	function blend(buf, bw, bh, x, y, r, g, b, a) {
		if (a <= 0 || x < 0 || y < 0 || x >= bw || y >= bh) return;
		const i = (y * bw + x) * 4;
		const da = buf[i + 3] / 255;
		const outA = a + da * (1 - a);
		if (outA <= 0) return;
		buf[i] = Math.round((r * a + buf[i] * da * (1 - a)) / outA);
		buf[i + 1] = Math.round((g * a + buf[i + 1] * da * (1 - a)) / outA);
		buf[i + 2] = Math.round((b * a + buf[i + 2] * da * (1 - a)) / outA);
		buf[i + 3] = Math.round(outA * 255);
	}

	function stamp(buf, bw, bh, originX, originY, pixels, rows, tint, opacity, mask, scale) {
		if (!pixels || rows <= 0) return;
		const tintR = tint[0] / 255;
		const tintG = tint[1] / 255;
		const tintB = tint[2] / 255;
		for (let row = 0; row < rows; row++) {
			for (let y = 0; y < 8; y++) {
				for (let x = 0; x < 40; x++) {
					const pi = ((row * 8 + y) * 40 + x) * 4;
					const srcA = pixels[pi + 3] / 255;
					let a;
					let r;
					let g;
					let b;
					if (mask) {
						const maskA = mask[pi + 3] / 255;
						if (maskA === 0 || srcA === 0) continue;
						a = srcA * maskA * opacity;
						r = pixels[pi] * tintR;
						g = pixels[pi + 1] * tintG;
						b = pixels[pi + 2] * tintB;
					} else {
						if (srcA === 0) continue;
						a = srcA * srcA * opacity;
						r = pixels[pi] * tintR;
						g = pixels[pi + 1] * tintG;
						b = pixels[pi + 2] * tintB;
					}
					const dx = originX + x * scale;
					const dy = originY + (row * 8 + y) * scale;
					for (let sy = 0; sy < scale; sy++) {
						for (let sx = 0; sx < scale; sx++) blend(buf, bw, bh, dx + sx, dy + sy, r, g, b, a);
					}
				}
			}
		}
	}

	function stainIndex(amount) {
		const stepped = Math.trunc(amount * 4);
		const clamped = stepped < 0 ? 0 : stepped > 4 ? 4 : stepped;
		return clamped - 1;
	}

	function lookupImage(images, file, warnings, missing) {
		if (images.has(file)) return images.get(file);
		const lower = file.toLowerCase();
		let found = null;
		let foundName = "";
		images.forEach(function (image, name) {
			if (!found && name.toLowerCase() === lower) {
				found = image;
				foundName = name;
			}
		});
		if (found) {
			warnings.push(file + " only matches the image " + foundName + " with different capitalisation. The game may not find it.");
			return found;
		}
		if (!missing.has(file)) {
			missing.add(file);
			warnings.push("No face image named " + file);
		}
		return null;
	}

	function renderPortrait(appearance, type, subject, images, scale, warnings, picks) {
		const width = P_WIDTH * scale;
		const height = P_HEIGHT * scale;
		const buf = new Uint8ClampedArray(width * height * 4);
		const face = type ? type.face : [];
		const missing = new Set();
		const badSheets = new Set();
		let drawn = 0;
		const names = [];
		const listed = [];
		face.forEach(function (part, partIndex) {
			const choice = frameChoice(part, subject, picks ? picks[partIndex] : null, warnings);
			listed.push(choice);
			if (!choice.shown) return;
			const ran = choice.ran;
			const chosen = part.frames[choice.index];
			const image = lookupImage(images, chosen.file, warnings, missing);
			if (!image) return;
			if (image.width !== 416 || image.height < 60) {
				if (!badSheets.has(chosen.file)) {
					badSheets.add(chosen.file);
					warnings.push(chosen.file + " is " + image.width + "×" + image.height + ", not 416 wide and at least 60 tall");
				}
				return;
			}
			const frame = trimFrame(image, chosen.index);
			if (!frame) {
				const key = chosen.file + ":" + chosen.index;
				if (!missing.has(key)) {
					missing.add(key);
					warnings.push(chosen.file + " has no frame " + chosen.index);
				}
				return;
			}
			if (frame.rows <= 0) return;
			const col = part.color && appearance.colors.byName.get(part.color);
			if (part.color && !col && !missing.has("color:" + part.color)) {
				missing.add("color:" + part.color);
				warnings.push("No colour named " + part.color);
			}
			const tint = shadeSelf(col ? collectionColor(col, subject, warnings) : WHITE);
			const x = Math.trunc((part.dx + (ran / 15) * part.dxr) * scale);
			const y = Math.trunc((8 + part.dy + ((ran >> 4) / 15) * part.dyr) * scale) + frame.offY * scale;
			stamp(buf, width, height, x, y, frame.pixels, frame.rows, tint, part.opacity / 255, null, scale);
			if (part.stains) {
				const overlays = lookupImage(images, "_Overlays", warnings, missing);
				const gritI = stainIndex(subject.grime);
				const bloodI = stainIndex(subject.injury);
				if (overlays && gritI >= 0) {
					const grit = trimFrame(overlays, gritI);
					if (grit && grit.pixels) stamp(buf, width, height, x, y, grit.pixels, Math.min(frame.rows, grit.rows), WHITE, 254 / 255, frame.pixels, scale);
				}
				if (overlays && bloodI >= 0) {
					const blood = trimFrame(overlays, 4 + bloodI);
					if (blood && blood.pixels) stamp(buf, width, height, x, y, blood.pixels, Math.min(frame.rows, blood.rows), appearance.blood, 254 / 255, frame.pixels, scale);
				}
			}
			drawn++;
			names.push(part.color || ("part " + (partIndex + 1)));
		});
		return { pixels: buf, width: width, height: height, drawn: drawn, total: face.length, names: names, choices: listed };
	}

	function boot() {
		const sourcesEl = document.getElementById("sources");
		const vanillaEl = document.getElementById("vanilla");
		const noticeEl = document.getElementById("drop-notice");
		const appearanceEl = document.getElementById("appearance");
		const typeEl = document.getElementById("type");
		const canvas = document.getElementById("portrait");
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		const warningsEl = document.getElementById("warnings");
		const statusEl = document.getElementById("status");
		const partsEl = document.getElementById("parts");
		const piecesEl = document.getElementById("pieces");
		const seedEl = document.getElementById("seed");
		const intsEl = document.getElementById("ints");
		const dropEl = document.getElementById("drop");
		let nextId = 1;
		const state = {
			vanilla: null,
			mods: [],
			images: new Map(),
			appearances: [],
			appearance: 0,
			type: 0,
			seed: 1,
			ints: intsFromSeed(1),
			age: 0.4,
			dead: false,
			noble: false,
			slave: false,
			parent: false,
			plate: 0,
			retired: false,
			sick: false,
			grime: 0,
			injury: 0,
			scale: 4,
			loadWarnings: [],
			picks: []
		};

		function subject() {
			const appearance = state.appearances[state.appearance];
			const type = appearance && appearance.types[state.type];
			let role = "citizen";
			if (type && type.kind === "child") role = state.slave ? "child-slave" : "child";
			else if (state.parent && state.slave) role = "parent-slave";
			else if (state.parent) role = "parent";
			else if (state.slave) role = "slave";
			return {
				ints: state.ints,
				age: state.age,
				dead: state.dead,
				noble: state.noble,
				slave: state.slave,
				parent: state.parent,
				role: role,
				plate: state.plate,
				retired: state.retired,
				sick: state.sick,
				grime: state.grime,
				injury: state.injury
			};
		}

		function modSummary(mod) {
			const major = state.vanilla ? state.vanilla.major : null;
			const parts = [mod.label];
			if (mod.error) parts.push(mod.error);
			else if (mod.version != null) {
				parts.push("V" + mod.version + (major != null && mod.version !== major ? ", game is V" + major : ""));
				if (!mod.sprites.length && !mod.images.size) parts.push("no portrait files");
			}
			return parts.join(" · ");
		}

		function renderSources() {
			if (state.vanilla) {
				const version = state.vanilla.version ? "game " + state.vanilla.version.label : "game version unknown";
				vanillaEl.textContent = state.vanilla.name + " · " + version + " · " + state.vanilla.sprites.length + " sprite files, " + state.vanilla.images.size + " images";
			} else {
				vanillaEl.textContent = "Not added yet.";
			}
			sourcesEl.innerHTML = "";
			if (!state.mods.length) {
				const empty = document.createElement("li");
				empty.className = "hint";
				empty.textContent = "No mods added. Mods are optional.";
				sourcesEl.appendChild(empty);
				return;
			}
			state.mods.forEach(function (mod, index) {
				const row = document.createElement("li");
				const label = document.createElement("span");
				label.textContent = index + ". " + modSummary(mod);
				row.appendChild(label);
				const controls = document.createElement("span");
				controls.className = "row-buttons";
				[["Up", -1], ["Down", 1]].forEach(function (pair) {
					const button = document.createElement("button");
					button.type = "button";
					button.textContent = pair[0];
					button.disabled = index + pair[1] < 0 || index + pair[1] >= state.mods.length;
					button.addEventListener("click", function () {
						const next = index + pair[1];
						const item = state.mods.splice(index, 1)[0];
						state.mods.splice(next, 0, item);
						rebuild(false);
					});
					controls.appendChild(button);
				});
				const remove = document.createElement("button");
				remove.type = "button";
				remove.textContent = "Remove";
				remove.addEventListener("click", function () {
					state.mods.splice(index, 1);
					rebuild(false);
				});
				controls.appendChild(remove);
				row.appendChild(controls);
				sourcesEl.appendChild(row);
			});
		}

		function syncRandomSliders() {
			for (let i = 0; i < 8; i++) {
				const input = document.getElementById("random-" + i);
				const out = document.getElementById("random-out-" + i);
				const byte = randomByte(state.ints, i);
				if (document.activeElement !== input) input.value = String(byte);
				out.textContent = (byte / 255).toFixed(3);
			}
		}

		function draw() {
			syncRandomSliders();
			intsEl.textContent = state.ints.map(toSigned).join(", ");
			const appearance = state.appearances[state.appearance];
			const type = appearance && appearance.types[state.type];
			const warnings = state.loadWarnings.slice();
			if (!appearance || !type) {
				canvas.width = P_WIDTH * state.scale;
				canvas.height = P_HEIGHT * state.scale;
				ctx.imageSmoothingEnabled = false;
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				statusEl.textContent = state.vanilla ? "No sprite files found." : "Drop the game's data.zip onto this page.";
				partsEl.textContent = "";
				renderPieces([], subject(), []);
				showWarnings(warnings);
				return;
			}
			const result = renderPortrait(appearance, type, subject(), state.images, state.scale, warnings, state.picks);
			canvas.width = result.width;
			canvas.height = result.height;
			ctx.imageSmoothingEnabled = false;
			ctx.putImageData(new ImageData(result.pixels, result.width, result.height), 0, 0);
			statusEl.textContent = appearance.name + " · " + type.label + " · " + result.drawn + " of " + result.total + " parts";
			partsEl.textContent = result.names.length ? result.names.join(", ") : "Nothing drawn.";
			renderPieces(type.face, subject(), result.choices);
			showWarnings(warnings);
		}

		function pieceLabel(part) {
			const files = [];
			part.frames.forEach(function (frame) {
				if (files.indexOf(frame.file) < 0) files.push(frame.file);
			});
			return files.join(", ") || ("Part " + (part.index + 1));
		}

		function pieceLabels(face) {
			const totals = {};
			const raw = face.map(pieceLabel);
			raw.forEach(function (label) { totals[label] = (totals[label] || 0) + 1; });
			const seen = {};
			return raw.map(function (label) {
				if (totals[label] === 1) return label;
				seen[label] = (seen[label] || 0) + 1;
				return label + " " + seen[label];
			});
		}

		function renderPieces(face, subj, choices) {
			piecesEl.innerHTML = "";
			const listed = [];
			for (let i = 0; i < face.length; i++) {
				if (face[i].frames.length) listed.push(i);
			}
			if (!listed.length) {
				const empty = document.createElement("p");
				empty.className = "hint";
				empty.textContent = "Drop data.zip to step through a race's pieces.";
				piecesEl.appendChild(empty);
				return;
			}
			const labels = pieceLabels(face);
			listed.forEach(function (partIndex) {
				const part = face[partIndex];
				const choice = choices[partIndex] || frameChoice(part, subj, state.picks[partIndex], []);
				const row = document.createElement("div");
				row.className = "piece" + (choice.shown ? "" : " hidden");
				const name = document.createElement("span");
				name.className = "name";
				name.textContent = labels[partIndex];
				const previous = document.createElement("button");
				previous.type = "button";
				previous.textContent = "‹";
				previous.setAttribute("aria-label", "Previous " + labels[partIndex]);
				previous.disabled = part.frames.length < 2;
				previous.addEventListener("click", function () { stepPiece(partIndex, -1); });
				const next = document.createElement("button");
				next.type = "button";
				next.textContent = "›";
				next.setAttribute("aria-label", "Next " + labels[partIndex]);
				next.disabled = part.frames.length < 2;
				next.addEventListener("click", function () { stepPiece(partIndex, 1); });
				const count = document.createElement("span");
				count.className = "count";
				count.textContent = (choice.index + 1) + " / " + choice.count + (choice.shown ? "" : " hidden");
				row.appendChild(name);
				row.appendChild(previous);
				row.appendChild(next);
				row.appendChild(count);
				piecesEl.appendChild(row);
			});
		}

		function stepPiece(partIndex, delta) {
			const appearance = state.appearances[state.appearance];
			const type = appearance && appearance.types[state.type];
			const part = type && type.face[partIndex];
			if (!part || part.frames.length < 2) return;
			const count = part.frames.length;
			let current = state.picks[partIndex];
			if (current == null) current = frameChoice(part, subject(), null, []).index;
			state.picks[partIndex] = (current + delta + count) % count;
			draw();
		}

		function showWarnings(warnings) {
			const unique = [];
			const seen = new Set();
			warnings.forEach(function (warning) {
				if (!seen.has(warning)) {
					seen.add(warning);
					unique.push(warning);
				}
			});
			warningsEl.innerHTML = "";
			if (!unique.length) {
				warningsEl.hidden = true;
				return;
			}
			warningsEl.hidden = false;
			unique.forEach(function (warning) {
				const item = document.createElement("li");
				item.textContent = warning;
				warningsEl.appendChild(item);
			});
		}

		function fillSelect(select, options, selected) {
			const previous = select.value;
			select.innerHTML = "";
			options.forEach(function (option, index) {
				const el = document.createElement("option");
				el.value = String(index);
				el.textContent = option;
				select.appendChild(el);
			});
			select.disabled = !options.length;
			if (selected != null && selected < options.length) select.value = String(selected);
			else if (previous && Number(previous) < options.length) select.value = previous;
			else select.value = options.length ? "0" : "";
		}

		// A rebuild asked for during another one waits, then one more pass applies the
		// latest state. Passes never overlap, so an old read can't replace a newer one.
		let building = null;
		let buildAgain = false;
		let buildAgainReread = false;
		function rebuild(reread) {
			if (building) {
				buildAgain = true;
				if (reread) buildAgainReread = true;
				return building;
			}
			building = (async function () {
				try {
					let pass = reread;
					while (true) {
						await rebuildOnce(pass);
						if (!buildAgain) break;
						pass = buildAgainReread;
						buildAgain = false;
						buildAgainReread = false;
					}
				} finally {
					building = null;
				}
			})();
			return building;
		}

		async function rebuildOnce(reread) {
			warnedStats.clear();
			renderSources();
			statusEl.textContent = "Reading files…";
			if (reread) {
				for (let m = 0; m < state.mods.length; m++) await refreshMod(state.mods[m]);
			}
			const raceBefore = state.appearances[state.appearance] && state.appearances[state.appearance].name;
			const typeBefore = state.type;
			const warnings = [];
			if (state.vanilla) state.vanilla.warnings.forEach(function (warning) { warnings.push(warning); });
			state.mods.forEach(function (mod) {
				mod.warnings.forEach(function (warning) { warnings.push(warning); });
			});
			const layers = layerSources(state.vanilla, state.mods);
			state.images = layers.images;
			state.loadWarnings = warnings;
			state.appearances = state.vanilla ? appearancesFromSources(layers.sprites, warnings) : [];
			const kept = state.appearances.findIndex(function (item) { return item.name === raceBefore; });
			state.appearance = kept >= 0 ? kept : 0;
			fillSelect(appearanceEl, state.appearances.map(function (item) { return item.name; }), state.appearance);
			state.appearance = appearanceEl.value ? Number(appearanceEl.value) : 0;
			const appearance = state.appearances[state.appearance];
			const types = appearance ? appearance.types : [];
			if (state.type >= types.length) state.type = 0;
			fillSelect(typeEl, types.map(function (item) { return item.label; }), state.type);
			state.type = typeEl.value ? Number(typeEl.value) : 0;
			const raceAfter = appearance && appearance.name;
			if (raceBefore !== raceAfter || typeBefore !== state.type) state.picks = [];
			renderSources();
			draw();
		}

		function decodeFile(file) {
			return createImageBitmap(file).then(function (bitmap) {
				const c = document.createElement("canvas");
				c.width = bitmap.width;
				c.height = bitmap.height;
				const context = c.getContext("2d", { willReadFrequently: true });
				context.drawImage(bitmap, 0, 0);
				const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
				bitmap.close();
				return image;
			});
		}

		async function loadZip(node, notices) {
			const file = await node.read();
			let zip;
			try {
				zip = await openZip(file);
			} catch (err) {
				notices.push(err.unsupported ? node.name + ": " + err.message + "." : node.name + " doesn't look like the game's data.zip.");
				return false;
			}
			if (!isGameZip(zip)) {
				notices.push(node.name + " doesn't look like the game's data.zip.");
				return false;
			}
			const warnings = [];
			const sprites = [];
			const images = new Map();
			const spriteEntries = zipFolderEntries(zip, ZIP_SPRITE_FOLDER);
			for (let i = 0; i < spriteEntries.length; i++) {
				if (!spriteKey(spriteEntries[i].name)) continue;
				try {
					const data = await readZipEntry(file, spriteEntries[i].entry, "text/plain");
					sprites.push({ name: spriteEntries[i].name, text: await data.text() });
				} catch (err) {
					warnings.push("Could not read " + spriteEntries[i].name + " from " + node.name);
				}
			}
			const faceEntries = zipFolderEntries(zip, ZIP_FACE_FOLDER);
			for (let i = 0; i < faceEntries.length; i++) {
				const key = faceKey(faceEntries[i].name);
				if (!key) continue;
				try {
					images.set(key, await decodeFile(await readZipEntry(file, faceEntries[i].entry, "image/png")));
				} catch (err) {
					warnings.push("Could not read " + faceEntries[i].name + " from " + node.name);
				}
			}
			let version = null;
			if (zip.entries.has(ZIP_PATCHNOTES)) {
				try {
					version = gameVersion(await (await readZipEntry(file, zip.entries.get(ZIP_PATCHNOTES), "text/plain")).text());
				} catch (err) {}
			}
			if (!version) warnings.push("Could not read the game version from " + node.name + ", so each mod uses its highest version folder.");
			state.vanilla = {
				name: node.name,
				version: version,
				major: version ? version.major : null,
				sprites: sprites,
				images: images,
				warnings: warnings
			};
			return true;
		}

		async function addMod(node, notices) {
			const root = await node.list();
			if (!findNode(root, "_Info.txt", false)) {
				if (/^V\d+$/.test(node.name)) {
					notices.push(node.name + " is a version folder. Drop the mod's main folder.");
					return false;
				}
				const folders = root.filter(function (child) { return child.isDirectory; });
				for (let i = 0; i < folders.length; i++) {
					if (findNode(await folders[i].list(), "_Info.txt", false)) {
						notices.push(node.name + " holds several mods. Drop one mod at a time.");
						return false;
					}
				}
				notices.push(node.name + " has no _Info.txt, so it isn't a mod folder.");
				return false;
			}
			const mod = {
				id: nextId++,
				node: node,
				folderName: node.name,
				label: node.name,
				version: null,
				error: "",
				sprites: [],
				ignoreVanilla: false,
				images: new Map(),
				cache: new Map(),
				warnings: []
			};
			const existing = state.mods.findIndex(function (item) { return item.folderName === node.name; });
			if (existing >= 0) state.mods[existing] = mod;
			else state.mods.push(mod);
			return true;
		}

		// Goes back to the folder on disk. Unchanged images are not decoded again.
		// If the folder can't be read, the last good copy stays in use.
		async function refreshMod(mod) {
			const major = state.vanilla ? state.vanilla.major : null;
			const warnings = [];
			try {
				const root = await mod.node.list();
				const info = findNode(root, "_Info.txt", false);
				let label = mod.folderName;
				if (info) {
					const doc = parseDocument(await (await info.read()).text(), warnings, mod.folderName + "/_Info.txt");
					if (doc && textOf(doc.map.get("NAME"))) label = textOf(doc.map.get("NAME"));
				}
				const version = bestVersion(root.filter(function (child) { return child.isDirectory; }).map(function (child) { return child.name; }), major);
				if (version == null) {
					mod.label = label;
					mod.version = null;
					mod.error = "no version folders";
					mod.sprites = [];
					mod.ignoreVanilla = false;
					mod.images = new Map();
					mod.cache = new Map();
					mod.warnings = warnings;
					return;
				}
				const folder = "V" + version;
				const spriteNodes = await listFolderAt(root, [folder, "assets", "init", "race", "sprite"]);
				const faceNodes = await listFolderAt(root, [folder, "assets", "sprite", "race", "face"]);
				const sprites = [];
				let ignoreVanilla = false;
				for (let i = 0; i < spriteNodes.length; i++) {
					const node = spriteNodes[i];
					if (node.isDirectory) continue;
					if (node.name === "_IgnoreVanilla.txt") ignoreVanilla = true;
					if (!spriteKey(node.name)) continue;
					try {
						sprites.push({ name: node.name, text: await (await node.read()).text() });
					} catch (err) {
						warnings.push("Could not read " + node.name + " from " + label);
						const last = mod.sprites.filter(function (file) { return file.name === node.name; })[0];
						if (last) sprites.push(last);
					}
				}
				const images = new Map();
				const cache = new Map();
				for (let i = 0; i < faceNodes.length; i++) {
					const node = faceNodes[i];
					const key = node.isDirectory ? null : faceKey(node.name);
					if (!key) continue;
					const before = mod.cache.get(key);
					try {
						const file = await node.read();
						let stored = before;
						if (!before || before.size !== file.size || before.lastModified !== file.lastModified) {
							stored = { size: file.size, lastModified: file.lastModified, image: await decodeFile(file) };
						}
						cache.set(key, stored);
						images.set(key, stored.image);
					} catch (err) {
						warnings.push("Could not read " + node.name + " from " + label);
						if (before) {
							cache.set(key, before);
							images.set(key, before.image);
						}
					}
				}
				mod.label = label;
				mod.version = version;
				mod.error = "";
				mod.sprites = sprites;
				mod.ignoreVanilla = ignoreVanilla;
				mod.images = images;
				mod.cache = cache;
				mod.warnings = warnings;
			} catch (err) {
				mod.warnings = ["Could not read " + mod.label + " again, so its last copy is in use."];
			}
		}

		async function acceptDrop(nodes) {
			if (!nodes.length) return;
			statusEl.textContent = "Reading files…";
			const notices = [];
			let changed = false;
			for (let i = 0; i < nodes.length; i++) {
				const node = nodes[i];
				try {
					const added = node.isDirectory ? await addMod(node, notices) : await loadZip(node, notices);
					if (added) changed = true;
				} catch (err) {
					notices.push("Could not read " + node.name + ".");
				}
			}
			noticeEl.textContent = notices.join(" ");
			noticeEl.hidden = !notices.length;
			if (changed) await rebuild(true);
			else draw();
		}

		appearanceEl.addEventListener("change", function () {
			state.appearance = Number(appearanceEl.value) || 0;
			state.type = 0;
			state.picks = [];
			const appearance = state.appearances[state.appearance];
			fillSelect(typeEl, appearance ? appearance.types.map(function (item) { return item.label; }) : [], 0);
			draw();
		});
		typeEl.addEventListener("change", function () {
			state.type = Number(typeEl.value) || 0;
			state.picks = [];
			draw();
		});

		function bindNumber(id, key, min, max, integer) {
			const input = document.getElementById(id);
			input.addEventListener("input", function () {
				let value = integer ? parseInt(input.value, 10) : parseFloat(input.value);
				if (Number.isNaN(value)) value = min;
				if (value < min) value = min;
				if (value > max) value = max;
				state[key] = value;
				if (String(input.value) !== String(value)) input.value = String(value);
				draw();
			});
		}

		bindNumber("age", "age", 0, 1, false);
		bindNumber("plate", "plate", 0, PLATE_MAX, true);
		bindNumber("grime", "grime", 0, 1, false);
		bindNumber("injury", "injury", 0, 1, false);
		["dead", "noble", "slave", "parent", "retired", "sick"].forEach(function (key) {
			document.getElementById(key).addEventListener("change", function (event) {
				state[key] = event.target.checked;
				draw();
			});
		});

		seedEl.addEventListener("change", function () {
			const value = parseInt(seedEl.value, 10);
			state.seed = Number.isNaN(value) ? 1 : value >>> 0;
			seedEl.value = String(state.seed);
			state.ints = intsFromSeed(state.seed);
			draw();
		});
		function rng() {
			const buf = new Uint32Array(1);
			return {
				int: function (max) {
					if (max <= 1) return 0;
					const limit = Math.floor(0x100000000 / max) * max;
					let value;
					do {
						crypto.getRandomValues(buf);
						value = buf[0];
					} while (value >= limit);
					return value % max;
				},
				float: function () {
					crypto.getRandomValues(buf);
					return buf[0] / 0x100000000;
				},
				uint32: function () {
					crypto.getRandomValues(buf);
					return buf[0];
				}
			};
		}

		function rollSeed(random) {
			state.seed = random.uint32();
			seedEl.value = String(state.seed);
			state.ints = intsFromSeed(state.seed);
		}

		let reading = false;
		function reroll(randomise) {
			if (reading) return;
			reading = true;
			const random = rng();
			rollSeed(random);
			if (randomise) {
				const appearance = state.appearances[state.appearance];
				const type = appearance && appearance.types[state.type];
				const arrival = randomArrival(type && type.kind === "child" ? "child" : "adult", random);
				state.age = arrival.age;
				state.grime = arrival.grime;
				state.injury = arrival.injury;
				state.plate = arrival.plate;
				state.dead = arrival.dead;
				state.noble = arrival.noble;
				state.slave = arrival.slave;
				state.parent = arrival.parent;
				state.retired = arrival.retired;
				state.sick = arrival.sick;
				document.getElementById("age").value = String(arrival.age);
				document.getElementById("grime").value = String(arrival.grime);
				document.getElementById("injury").value = String(arrival.injury);
				document.getElementById("plate").value = String(arrival.plate);
				["dead", "noble", "slave", "parent", "retired", "sick"].forEach(function (key) {
					document.getElementById(key).checked = arrival[key];
				});
			}
			rebuild(true).then(function () { reading = false; }, function () { reading = false; });
		}

		document.getElementById("roll").addEventListener("click", function () { reroll(false); });
		document.getElementById("randomise").addEventListener("click", function () { reroll(true); });
		document.getElementById("export").addEventListener("click", function () {
			const appearance = state.appearances[state.appearance];
			const type = appearance && appearance.types[state.type];
			if (!appearance || !type) {
				statusEl.textContent = "Nothing to export yet.";
				return;
			}
			const name = [appearance.name, type.label, String(state.seed)].map(function (part) {
				return String(part).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
			}).filter(Boolean).join("-") + ".png";
			canvas.toBlob(function (blob) {
				if (!blob) {
					statusEl.textContent = "Could not export the portrait.";
					return;
				}
				const url = URL.createObjectURL(blob);
				const link = document.createElement("a");
				link.href = url;
				link.download = name;
				link.click();
				setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
			}, "image/png");
		});
		document.getElementById("scale").addEventListener("input", function (event) {
			state.scale = parseInt(event.target.value, 10) || 4;
			document.getElementById("scale-out").textContent = String(state.scale);
			draw();
		});

		for (let i = 0; i < 8; i++) {
			document.getElementById("random-" + i).addEventListener("input", function (event) {
				writeByte(state.ints, 64 + 8 * i, parseInt(event.target.value, 10) || 0);
				draw();
			});
		}

		window.addEventListener("dragover", function (event) {
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
			dropEl.classList.add("hot");
		});
		window.addEventListener("dragleave", function () {
			dropEl.classList.remove("hot");
		});
		window.addEventListener("drop", function (event) {
			event.preventDefault();
			dropEl.classList.remove("hot");
			acceptDrop(dropNodes(event.dataTransfer));
		});

		seedEl.value = "1";
		renderSources();
		draw();
	}

	return {
		parseDocument: parseDocument,
		mergeDocuments: mergeDocuments,
		layerSources: layerSources,
		bestVersion: bestVersion,
		gameVersion: gameVersion,
		openZip: openZip,
		readZipEntry: readZipEntry,
		isGameZip: isGameZip,
		zipFolderEntries: zipFolderEntries,
		entryNode: entryNode,
		findNode: findNode,
		listFolderAt: listFolderAt,
		appearancesFromSources: appearancesFromSources,
		buildAppearance: buildAppearance,
		intsFromSeed: intsFromSeed,
		randomArrival: randomArrival,
		bitGet: bitGet,
		writeByte: writeByte,
		randomByte: randomByte,
		collectionColor: collectionColor,
		shadeSelf: shadeSelf,
		trimFrame: trimFrame,
		renderPortrait: renderPortrait,
		readStat: readStat,
		conditionsPass: conditionsPass,
		frameChoice: frameChoice,
		stainIndex: stainIndex,
		toSigned: toSigned,
		boot: boot,
		WHITE: WHITE,
		SICK: SICK,
		PLATE_MAX: PLATE_MAX
	};
});
