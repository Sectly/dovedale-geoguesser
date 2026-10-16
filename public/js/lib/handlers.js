/**
 * Runs the handlers written in data-on-<event> attributes, so pages need no inline scripts.
 * Each one is a short chain of calls on page globals, such as `openUserPanel(12)` or
 * `el('row').classList.add('hidden'); return false`. It is parsed, never passed to eval.
 */

const EVENTS = ["click", "change", "input", "submit", "keydown", "toggle", "error"];
/** These do not bubble, so they are caught on the way down instead. */
const CAPTURED = new Set(["toggle", "error"]);
const BLOCKED = new Set(["constructor", "__proto__", "prototype"]);

/** Splits a handler into tokens: names, numbers, strings and punctuation. */
function tokenize(src) {
	const tokens = [];
	const re = /\s*(?:([A-Za-z_$][\w$]*)|(-?\d+(?:\.\d+)?)|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(\S))/gy;
	let m;
	while (re.lastIndex < src.length && (m = re.exec(src))) {
		if (m[1] !== undefined) tokens.push({ t: "name", v: m[1] });
		else if (m[2] !== undefined) tokens.push({ t: "num", v: Number(m[2]) });
		else if (m[3] !== undefined || m[4] !== undefined)
			tokens.push({ t: "str", v: (m[3] ?? m[4]).replace(/\\(.)/g, "$1") });
		else if (m[5]) tokens.push({ t: "punc", v: m[5] });
	}
	return tokens;
}

export function parse(src) {
	const tokens = tokenize(src);
	let i = 0;
	const peek = (v) => tokens[i] && tokens[i].v === v && tokens[i].t !== "str";
	const take = (v) => {
		if (!peek(v)) throw new SyntaxError(`Expected "${v}" in handler: ${src}`);
		i++;
	};

	function primary() {
		const tok = tokens[i++];
		if (!tok) throw new SyntaxError(`Handler ends early: ${src}`);
		if (tok.t === "num" || tok.t === "str") return { k: "lit", v: tok.v };
		if (tok.v === "!") return { k: "not", e: primary() };
		if (tok.v === "{") {
			const props = [];
			while (!peek("}")) {
				const key = tokens[i++].v;
				take(":");
				props.push([key, expr()]);
				if (!peek("}")) take(",");
			}
			take("}");
			return { k: "obj", props };
		}
		if (tok.t !== "name") throw new SyntaxError(`Unexpected "${tok.v}" in handler: ${src}`);
		if (tok.v === "true" || tok.v === "false") return { k: "lit", v: tok.v === "true" };
		if (tok.v === "null") return { k: "lit", v: null };
		return { k: "name", v: tok.v };
	}

	function expr() {
		let node = primary();
		for (;;) {
			if (peek(".")) {
				i++;
				node = { k: "get", o: node, p: tokens[i++].v };
			} else if (peek("(")) {
				i++;
				const args = [];
				while (!peek(")")) {
					args.push(expr());
					if (!peek(")")) take(",");
				}
				take(")");
				node = { k: "call", f: node, args };
			} else return node;
		}
	}

	const statements = [];
	while (i < tokens.length) {
		if (peek(";")) {
			i++;
			continue;
		}
		if (peek("return")) {
			i++;
			take("false");
			statements.push({ k: "cancel" });
			if (i < tokens.length) take(";");
			continue;
		}
		statements.push(expr());
		if (i < tokens.length) take(";");
	}
	return statements;
}

const cache = new Map();

function compiled(src) {
	if (!cache.has(src)) cache.set(src, parse(src));
	return cache.get(src);
}

function evaluate(node, scope) {
	switch (node.k) {
		case "lit":
			return node.v;
		case "not":
			return !evaluate(node.e, scope);
		case "obj":
			return Object.fromEntries(node.props.map(([key, value]) => [key, evaluate(value, scope)]));
		case "name":
			if (node.v === "this") return scope.self;
			if (node.v === "event") return scope.event;
			if (!(node.v in window)) throw new ReferenceError(`${node.v} is not defined`);
			return window[node.v];
		case "get": {
			if (BLOCKED.has(node.p)) throw new TypeError(`"${node.p}" is not allowed in handlers`);
			return evaluate(node.o, scope)?.[node.p];
		}
		case "call": {
			const args = node.args.map((a) => evaluate(a, scope));
			if (node.f.k === "get") {
				if (BLOCKED.has(node.f.p)) throw new TypeError(`"${node.f.p}" is not allowed in handlers`);
				const target = evaluate(node.f.o, scope);
				return target[node.f.p](...args);
			}
			return evaluate(node.f, scope)(...args);
		}
	}
}

function run(type, element, event) {
	const src = element.getAttribute(`data-on-${type}`);
	if (!src) return;
	try {
		for (const statement of compiled(src)) {
			if (statement.k === "cancel") event.preventDefault();
			else evaluate(statement, { self: element, event });
		}
	} catch (err) {
		console.error(`[handlers] data-on-${type} failed:`, err);
		/** Reported like any other script error on the page. */
		setTimeout(() => {
			throw err;
		});
	}
}

for (const type of typeof document === "undefined" ? [] : EVENTS) {
	const attr = `data-on-${type}`;
	document.addEventListener(
		type,
		(event) => {
			if (!(event.target instanceof Element)) return;
			if (CAPTURED.has(type)) {
				if (event.target.hasAttribute(attr)) run(type, event.target, event);
				return;
			}
			/** Innermost first, as inline handlers would run, until one stops the event going further. */
			let stopped = false;
			const stop = event.stopPropagation;
			event.stopPropagation = function () {
				stopped = true;
				stop.call(this);
			};
			for (
				let node = event.target.closest(`[${attr}]`);
				node && !stopped;
				node = node.parentElement?.closest(`[${attr}]`)
			)
				run(type, node, event);
		},
		CAPTURED.has(type)
	);
}
