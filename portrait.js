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

	function groupSprites(sources) {
		const byName = new Map();
		const order = [];
		sources.forEach(function (src) {
			if (!src || src.kind !== "sprites") return;
			if (src.ignoreVanilla) {
				const keep = new Set();
				src.files.forEach(function (file) {
					const name = spriteKey(file.name);
					if (name) keep.add(name);
				});
				for (let i = order.length - 1; i >= 0; i--) {
					if (!keep.has(order[i])) {
						byName.delete(order[i]);
						order.splice(i, 1);
					}
				}
			}
			src.files.forEach(function (file) {
				const name = spriteKey(file.name);
				if (!name) return;
				if (!byName.has(name)) {
					byName.set(name, []);
					order.push(name);
				}
				byName.get(name).push(file);
			});
		});
		return order.map(function (name) {
			return { name: name, files: byName.get(name) };
		});
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

	function appearancesFromSources(sources, warnings) {
		return groupSprites(sources).map(function (group) {
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
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < 40; x++) {
				const si = ((y1 + y) * image.width + (sx + x)) * 4;
				const di = (y * 40 + x) * 4;
				pixels[di] = image.data[si];
				pixels[di + 1] = image.data[si + 1];
				pixels[di + 2] = image.data[si + 2];
				pixels[di + 3] = image.data[si + 3];
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
		images.forEach(function (image, name) {
			if (!found && name.toLowerCase() === lower) found = image;
		});
		if (found) return found;
		if (!missing.has(file)) {
			missing.add(file);
			warnings.push("No face image named " + file);
		}
		return null;
	}

	function renderPortrait(appearance, type, subject, images, scale, warnings) {
		const width = P_WIDTH * scale;
		const height = P_HEIGHT * scale;
		const buf = new Uint8ClampedArray(width * height * 4);
		const face = type ? type.face : [];
		const missing = new Set();
		const badSheets = new Set();
		let drawn = 0;
		const names = [];
		face.forEach(function (part, partIndex) {
			if (!part.frames.length) return;
			if (!conditionsPass(part.conditions, subject, warnings)) return;
			const ran = bitGet(subject.ints, (part.random * 16), 31) & 255;
			if (part.occurrence <= (ran & 15)) return;
			const chosen = part.frames[ran % part.frames.length];
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
		return { pixels: buf, width: width, height: height, drawn: drawn, total: face.length, names: names };
	}

	function boot() {
		const sourcesEl = document.getElementById("sources");
		const appearanceEl = document.getElementById("appearance");
		const typeEl = document.getElementById("type");
		const canvas = document.getElementById("portrait");
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		const warningsEl = document.getElementById("warnings");
		const statusEl = document.getElementById("status");
		const partsEl = document.getElementById("parts");
		const seedEl = document.getElementById("seed");
		const intsEl = document.getElementById("ints");
		const dropEl = document.getElementById("drop");
		let nextId = 1;
		const state = {
			sources: [],
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
			loadWarnings: []
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

		function renderSources() {
			sourcesEl.innerHTML = "";
			if (!state.sources.length) {
				const empty = document.createElement("p");
				empty.className = "hint";
				empty.textContent = "Nothing added yet.";
				sourcesEl.appendChild(empty);
				return;
			}
			state.sources.forEach(function (src, index) {
				const row = document.createElement("li");
				const label = document.createElement("span");
				label.textContent = (index + 1) + ". " + (src.kind === "faces" ? "Faces" : "Sprites") + " · " + src.label;
				row.appendChild(label);
				const controls = document.createElement("span");
				controls.className = "row-buttons";
				[["Up", -1], ["Down", 1]].forEach(function (pair) {
					const button = document.createElement("button");
					button.type = "button";
					button.textContent = pair[0];
					button.disabled = index + pair[1] < 0 || index + pair[1] >= state.sources.length;
					button.addEventListener("click", function () {
						const next = index + pair[1];
						const item = state.sources.splice(index, 1)[0];
						state.sources.splice(next, 0, item);
						rebuild();
					});
					controls.appendChild(button);
				});
				const remove = document.createElement("button");
				remove.type = "button";
				remove.textContent = "Remove";
				remove.addEventListener("click", function () {
					state.sources.splice(index, 1);
					rebuild();
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
				statusEl.textContent = state.sources.length ? "No sprite file in the list." : "Add the face folder, then a sprite file.";
				partsEl.textContent = "";
				showWarnings(warnings);
				return;
			}
			const result = renderPortrait(appearance, type, subject(), state.images, state.scale, warnings);
			canvas.width = result.width;
			canvas.height = result.height;
			ctx.imageSmoothingEnabled = false;
			ctx.putImageData(new ImageData(result.pixels, result.width, result.height), 0, 0);
			statusEl.textContent = appearance.name + " · " + type.label + " · " + result.drawn + " of " + result.total + " parts";
			partsEl.textContent = result.names.length ? result.names.join(", ") : "Nothing drawn.";
			showWarnings(warnings);
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

		async function rebuild() {
			warnedStats.clear();
			renderSources();
			statusEl.textContent = "Reading files…";
			const warnings = [];
			const images = new Map();
			const spriteSources = [];
			for (let s = 0; s < state.sources.length; s++) {
				const src = state.sources[s];
				if (src.kind === "faces") {
					for (let f = 0; f < src.files.length; f++) {
						const file = src.files[f];
						const key = faceKey(file.name);
						if (!key) continue;
						try {
							images.set(key, await decodeFile(file.file));
						} catch (err) {
							warnings.push("Could not read " + file.name);
						}
					}
				} else {
					const files = [];
					for (let f = 0; f < src.files.length; f++) {
						const file = src.files[f];
						if (!spriteKey(file.name)) continue;
						files.push({ name: file.name, text: await file.file.text() });
					}
					spriteSources.push({ kind: "sprites", ignoreVanilla: src.ignoreVanilla, files: files });
				}
			}
			state.images = images;
			state.loadWarnings = warnings;
			state.appearances = appearancesFromSources(spriteSources, warnings);
			if (state.appearance >= state.appearances.length) state.appearance = 0;
			fillSelect(appearanceEl, state.appearances.map(function (item) { return item.name; }), state.appearance);
			state.appearance = appearanceEl.value ? Number(appearanceEl.value) : 0;
			const appearance = state.appearances[state.appearance];
			const types = appearance ? appearance.types : [];
			if (state.type >= types.length) state.type = 0;
			fillSelect(typeEl, types.map(function (item) { return item.label; }), state.type);
			state.type = typeEl.value ? Number(typeEl.value) : 0;
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

		function addSource(kind, files, label, ignoreVanilla) {
			const kept = [];
			for (let i = 0; i < files.length; i++) {
				const file = files[i];
				const name = file.name;
				if (kind === "faces" && faceKey(name)) kept.push({ name: name, file: file });
				if (kind === "sprites" && spriteKey(name)) kept.push({ name: name, file: file });
			}
			if (!kept.length) return;
			state.sources.push({
				id: nextId++,
				kind: kind,
				label: label || (kept.length === 1 ? kept[0].name : kept.length + " files"),
				ignoreVanilla: !!ignoreVanilla,
				files: kept
			});
		}

		function folderLabel(files) {
			const rel = files[0] && files[0].webkitRelativePath;
			if (rel) return rel.split(/[/\\]/)[0];
			return files.length === 1 ? files[0].name : files.length + " files";
		}

		function takeFiles(fileList) {
			const files = Array.from(fileList);
			const pngs = files.filter(function (file) { return faceKey(file.name); });
			const txts = files.filter(function (file) { return spriteKey(file.name); });
			const ignore = files.some(function (file) { return file.name === "_IgnoreVanilla.txt"; });
			if (pngs.length) addSource("faces", pngs, folderLabel(pngs), false);
			if (txts.length) addSource("sprites", txts, folderLabel(txts), ignore);
			return pngs.length + txts.length;
		}

		function bindFile(id, kind) {
			const input = document.getElementById(id);
			input.addEventListener("change", function () {
				if (kind) {
					const files = Array.from(input.files);
					const ignore = files.some(function (file) { return file.name === "_IgnoreVanilla.txt"; });
					addSource(kind, files, folderLabel(files), kind === "sprites" && ignore);
					if (files.length) rebuild();
				} else if (takeFiles(input.files)) {
					rebuild();
				}
				input.value = "";
			});
		}

		bindFile("face-folder", "faces");
		bindFile("sprite-files", "sprites");
		bindFile("sprite-folder", "sprites");

		async function filesInDirectory(handle) {
			const files = [];
			const pending = [handle];
			while (pending.length) {
				const dir = pending.pop();
				for await (const entry of dir.values()) {
					if (entry.kind === "file") files.push(await entry.getFile());
					else if (entry.kind === "directory") pending.push(entry);
				}
			}
			return files;
		}

		function cancelled(err) {
			return err && (err.name === "AbortError" || err.name === "NotAllowedError");
		}

		// A file input makes Chrome say the files are being uploaded. The read-only
		// picker asks to view them instead, and the page still only reads them locally.
		async function pickDirectory(kind, fallbackId) {
			if (!window.showDirectoryPicker) {
				document.getElementById(fallbackId).click();
				return;
			}
			let handle;
			try {
				handle = await window.showDirectoryPicker({ mode: "read" });
			} catch (err) {
				if (!cancelled(err)) document.getElementById(fallbackId).click();
				return;
			}
			statusEl.textContent = "Reading files…";
			const files = await filesInDirectory(handle);
			const ignore = files.some(function (file) { return file.name === "_IgnoreVanilla.txt"; });
			addSource(kind, files, handle.name, kind === "sprites" && ignore);
			if (files.length) rebuild();
			else draw();
		}

		async function pickSpriteFiles() {
			if (!window.showOpenFilePicker) {
				document.getElementById("sprite-files").click();
				return;
			}
			let handles;
			try {
				handles = await window.showOpenFilePicker({
					multiple: true,
					types: [{ description: "Sprite text", accept: { "text/plain": [".txt"] } }]
				});
			} catch (err) {
				if (!cancelled(err)) document.getElementById("sprite-files").click();
				return;
			}
			statusEl.textContent = "Reading files…";
			const files = [];
			for (let i = 0; i < handles.length; i++) files.push(await handles[i].getFile());
			const ignore = files.some(function (file) { return file.name === "_IgnoreVanilla.txt"; });
			addSource("sprites", files, folderLabel(files), ignore);
			if (files.length) rebuild();
			else draw();
		}

		document.getElementById("add-faces").addEventListener("click", function () {
			pickDirectory("faces", "face-folder");
		});
		document.getElementById("add-sprites").addEventListener("click", function () {
			pickSpriteFiles();
		});
		document.getElementById("add-sprite-folder").addEventListener("click", function () {
			pickDirectory("sprites", "sprite-folder");
		});

		appearanceEl.addEventListener("change", function () {
			state.appearance = Number(appearanceEl.value) || 0;
			state.type = 0;
			const appearance = state.appearances[state.appearance];
			fillSelect(typeEl, appearance ? appearance.types.map(function (item) { return item.label; }) : [], 0);
			draw();
		});
		typeEl.addEventListener("change", function () {
			state.type = Number(typeEl.value) || 0;
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

		document.getElementById("roll").addEventListener("click", function () {
			rollSeed(rng());
			draw();
		});
		document.getElementById("randomise").addEventListener("click", function () {
			const random = rng();
			rollSeed(random);
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
			draw();
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

		async function entriesOf(entry) {
			if (entry.isFile) {
				const file = await new Promise(function (resolve, reject) { entry.file(resolve, reject); });
				return [file];
			}
			if (!entry.isDirectory) return [];
			const reader = entry.createReader();
			const nested = [];
			while (true) {
				const batch = await new Promise(function (resolve, reject) { reader.readEntries(resolve, reject); });
				if (!batch.length) break;
				for (let i = 0; i < batch.length; i++) {
					const found = await entriesOf(batch[i]);
					found.forEach(function (file) { nested.push(file); });
				}
			}
			return nested;
		}

		window.addEventListener("dragover", function (event) {
			event.preventDefault();
			dropEl.classList.add("hot");
		});
		window.addEventListener("dragleave", function () {
			dropEl.classList.remove("hot");
		});
		window.addEventListener("drop", function (event) {
			event.preventDefault();
			dropEl.classList.remove("hot");
			const items = event.dataTransfer.items;
			if (!items || !items.length) {
				if (takeFiles(event.dataTransfer.files)) rebuild();
				return;
			}
			const jobs = [];
			for (let i = 0; i < items.length; i++) {
				const entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
				if (entry) jobs.push(entriesOf(entry));
			}
			if (!jobs.length) {
				if (takeFiles(event.dataTransfer.files)) rebuild();
				return;
			}
			Promise.all(jobs).then(function (groups) {
				let added = 0;
				groups.forEach(function (files) { added += takeFiles(files); });
				if (added) rebuild();
			});
		});

		seedEl.value = "1";
		renderSources();
		draw();
	}

	return {
		parseDocument: parseDocument,
		mergeDocuments: mergeDocuments,
		groupSprites: groupSprites,
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
		stainIndex: stainIndex,
		toSigned: toSigned,
		boot: boot,
		WHITE: WHITE,
		SICK: SICK,
		PLATE_MAX: PLATE_MAX
	};
});
