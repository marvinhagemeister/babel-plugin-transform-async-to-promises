const asyncToPromises = require("./async-to-promises");
const babel = require("babel-core");
const babylon = require("babylon");

const runTestCasesOnInput = false;
const checkTestCases = true;
const checkOutputMatches = true;
const logCompiledOutput = false;

const stripHelpersVisitor = {
	Statement(path) {
		if (path.isReturnStatement()) {
			path.skip();
		} else {
			path.remove();
		}
	}
};

const pluginUnderTest = asyncToPromises(babel);

function extractJustFunction(result) {
	const code = babel.transformFromAst(result.ast, result.code, { plugins: [{ visitor: stripHelpersVisitor }], compact: true }).code;
	return code.match(/return\s*(.*);$/)[1];
}

function compiledTest(name, { input, output, cases }) {
	describe(name, () => {
		const inputReturned = "return " + input;
		const ast = babylon.parse(inputReturned, { allowReturnOutsideFunction: true });
		const result = babel.transformFromAst(ast, inputReturned, { plugins: [pluginUnderTest], compact: true });
		const strippedResult = extractJustFunction(result);
		if (logCompiledOutput) {
			console.log(name + " input", input);
			console.log(name + " output", strippedResult);
		}
		let fn;
		test("syntax", () => {
			const code = runTestCasesOnInput ? inputReturned : result.code;
			try {
				fn = new Function(code);
			} catch (e) {
				if (e instanceof SyntaxError) {
					e.message += "\n" + code;
				}
				throw e;
			}
		});
		if (checkTestCases) {
			for (let key in cases) {
				if (cases.hasOwnProperty(key)) {
					test(key, async () => {
						if (fn) {
							return cases[key](fn());
						}
					});
				}
			}
		}
		if (checkOutputMatches) {
			test("output", () => {
				expect(strippedResult).toBe(output);
			});
		}
	});
}

compiledTest("passthrough", {
	input: `function() { return 1; }`,
	output: `function(){return 1;}`,
	cases: {
		result: async f => expect(await f()).toBe(1),
	},
});

compiledTest("basic async", {
	input: `async function() { return true; }`,
	output: `_async(function(){return true;})`,
	cases: {
		result: async f => expect(await f()).toBe(true),
	},
});

compiledTest("call chains", {
	input: `async function(a, b, c) { return await a(await b(), await c()); }`,
	output: `_async(function(a,b,c){return _call(b,function(_b){return _call(c,function(_c){return a(_b,_c);});});})`,
	cases: {
		result: async f => expect(await f((b, c) => b + c, async _ => 2, async _ => 3)).toBe(5),
	},
});

compiledTest("argument evaluation order", {
	input: `async function(a, b, c) { return await a(1, b + 1, await c()); }`,
	output: `_async(function(a,b,c){var _temp=b+1;return _call(c,function(_c){return a(1,_temp,_c);});})`,
	cases: {
		result: async f => expect(await f(async (a, b, c) => a + b + c, 1, async _ => 2)).toBe(5),
	},
});

compiledTest("assign to variable", {
	input: `async function(foo) { var result = await foo(); return result + 1; }`,
	output: `_async(function(foo){return _call(foo,function(result){return result+1;});})`,
	cases: {
		result: async f => expect(await f(async _ => 4)).toBe(5),
	},
});

compiledTest("two variables", {
	input: `async function(foo, bar) { var f = await foo(); var b = await bar(); return f + b; }`,
	output: `_async(function(foo,bar){return _call(foo,function(f){return _call(bar,function(b){return f+b;});});})`,
	cases: {
		result: async f => expect(await f(async _ => 3, async _ => 2)).toBe(5),
	},
});

compiledTest("await logical left", {
	input: `async function(left, right) { return await left() && right(); }`,
	output: `_async(function(left,right){return _call(left,function(_left){return _left&&right();});})`,
	cases: {
		false: async f => expect(await f(async _ => 0, _ => 2)).toBe(0),
		true: async f => expect(await f(async _ => 5, _ => 2)).toBe(2),
	},
});

compiledTest("await logical right", {
	input: `async function(left, right) { return left() && await right(); }`,
	output: `_async(function(left,right){var _left=left();return _await(_left?right():0,function(_right){return _left&&_right;});})`,
	cases: {
		false: async f => expect(await f(_ => 0, async _ => 2)).toBe(0),
		true: async f => expect(await f(_ => 5, async _ => 2)).toBe(2),
	},
});

compiledTest("await logical statement scope", {
	input: `async function(left, right) { if (true) return left() && await right(); else return false; }`,
	output: `_async(function(left,right){if(true){var _left=left();return _await(_left?right():0,function(_right){return _left&&_right;});}else return false;})`,
	cases: {
		false: async f => expect(await f(_ => 0, async _ => 2)).toBe(0),
		true: async f => expect(await f(_ => 5, async _ => 2)).toBe(2),
		order: async f => {
			let lastCalled = 0;
			await f(() => lastCalled = 1, () => lastCalled = 2);
			expect(lastCalled).toBe(2);
		}
	},
});

compiledTest("await logical both", {
	input: `async function(left, right) { return await left() && await right(); }`,
	output: `_async(function(left,right){return _call(left,function(_left){return _await(_left?right():0,function(_right){return _left&&_right;});});})`,
	cases: {
		false: async f => expect(await f(async _ => 0, async _ => 2)).toBe(0),
		true: async f => expect(await f(async _ => 5, async _ => 2)).toBe(2),
	},
});

compiledTest("await binary left", {
	input: `async function(left, right) { return await left() + right(); }`,
	output: `_async(function(left,right){return _call(left,function(_left){return _left+right();});})`,
	cases: {
		two: async f => expect(await f(async _ => 0, _ => 2)).toBe(2),
		seven: async f => expect(await f(async _ => 5, _ => 2)).toBe(7),
	},
});

compiledTest("await binary right", {
	input: `async function(left, right) { return left() + await right(); }`,
	output: `_async(function(left,right){var _left=left();return _call(right,function(_right){return _left+_right;});})`,
	cases: {
		two: async f => expect(await f(_ => 0, async _ => 2)).toBe(2),
		seven: async f => expect(await f(_ => 5, async _ => 2)).toBe(7),
	},
});

compiledTest("await binary statement scope", {
	input: `async function(left, right) { if (true) return left() + await right(); else return false; }`,
	output: `_async(function(left,right){if(true){var _left=left();return _call(right,function(_right){return _left+_right;});}else return false;})`,
	cases: {
		two: async f => expect(await f(_ => 0, async _ => 2)).toBe(2),
		seven: async f => expect(await f(_ => 5, async _ => 2)).toBe(7),
		order: async f => {
			let lastCalled = 0;
			await f(() => lastCalled = 1, () => lastCalled = 2);
			expect(lastCalled).toBe(2);
		}
	},
});

compiledTest("await binary both", {
	input: `async function(left, right) { return await left() + await right(); }`,
	output: `_async(function(left,right){return _call(left,function(_left){return _call(right,function(_right){return _left+_right;});});})`,
	cases: {
		two: async f => expect(await f(async _ => 0, async _ => 2)).toBe(2),
		seven: async f => expect(await f(async _ => 5, async _ => 2)).toBe(7),
	},
});

compiledTest("await binary and logical", {
	input: `async function(left, middle, right) { return await left() + !(await middle()) && await right(); }`,
	output: `_async(function(left,middle,right){return _call(left,function(_left){return _call(middle,function(_middle){var _temp=_left+!_middle;return _await(_temp?right():0,function(_right){return _temp&&_right;});});});})`,
	cases: {
		two: async f => expect(await f(async _ => 3, async _ => false, async _ => 5)).toBe(5),
		seven: async f => expect(await f(async _ => 0, async _ => true, async _ => 2)).toBe(0),
	},
});

compiledTest("if prefix", {
	input: `async function(foo) { const result = await foo(); if (result) { return 1; } else { return 0; } }`,
	output: `_async(function(foo){return _call(foo,function(result){if(result){return 1;}else{return 0;}});})`,
	cases: {
		consequent: async f => expect(await f(async _ => true)).toBe(1),
		alternate: async f => expect(await f(async _ => 0)).toBe(0),
	},
});

compiledTest("if predicate", {
	input: `async function(foo) { if (await foo()) { return 1; } else { return 0; } }`,
	output: `_async(function(foo){return _call(foo,function(_foo){if(_foo){return 1;}else{return 0;}});})`,
	cases: {
		consequent: async f => expect(await f(async _ => true)).toBe(1),
		alternate: async f => expect(await f(async _ => 0)).toBe(0),
	},
});

compiledTest("if body returns", {
	input: `async function(foo, bar, baz) { if (foo()) { return await bar(); } else { return await baz(); } }`,
	output: `_async(function(foo,bar,baz){if(foo()){return bar();}else{return baz();}})`,
	cases: {
		consequent: async f => expect(await f(_ => true, async _ => 1, async _ => 0)).toBe(1),
		alternate: async f => expect(await f(_ => false, async _ => 1, async _ => 0)).toBe(0),
	},
});

compiledTest("if body assignments", {
	input: `async function(foo, bar, baz) { var result; if (foo()) { result = await bar(); } else { result = await baz(); }; return result; }`,
	output: `_async(function(foo,bar,baz){var result;return _call(function(){if(foo()){return _call(bar,function(_bar){result=_bar;});}else{return _call(baz,function(_baz){result=_baz;});}},function(){return result;});})`,
	cases: {
		consequent: async f => expect(await f(_ => true, async _ => 1, async _ => 0)).toBe(1),
		alternate: async f => expect(await f(_ => false, async _ => 1, async _ => 0)).toBe(0),
	},
});

compiledTest("ternary consequent", {
	input: `async function(foo, bar, baz) { return foo() ? await bar() : baz(); }`,
	output: `_async(function(foo,bar,baz){var _foo=foo();return _await(_foo?bar():0,function(_bar){return _foo?_bar:baz();});})`,
	cases: {
		consequent: async f => expect(await f(_ => true, async _ => 1, _ => 0)).toBe(1),
		alternate: async f => expect(await f(_ => false, async _ => 1, _ => 0)).toBe(0),
	},
});

compiledTest("ternary alternate", {
	input: `async function(foo, bar, baz) { return foo() ? bar() : await baz(); }`,
	output: `_async(function(foo,bar,baz){var _foo=foo();return _await(_foo?0:baz(),function(_baz){return _foo?bar():_baz;});})`,
	cases: {
		consequent: async f => expect(await f(_ => true, _ => 1, async _ => 0)).toBe(1),
		alternate: async f => expect(await f(_ => false, _ => 1, async _ => 0)).toBe(0),
	},
});

compiledTest("ternary body", {
	input: `async function(foo, bar, baz) { return foo() ? await bar() : await baz(); }`,
	output: `_async(function(foo,bar,baz){var _foo=foo();return _foo?bar():baz();})`,
	cases: {
		consequent: async f => expect(await f(_ => true, async _ => 1, async _ => 0)).toBe(1),
		alternate: async f => expect(await f(_ => false, async _ => 1, async _ => 0)).toBe(0),
	},
});

compiledTest("ternary predicate", {
	input: `async function(foo, bar, baz) { return await foo() ? bar() : baz(); }`,
	output: `_async(function(foo,bar,baz){return _call(foo,function(_foo){return _foo?bar():baz();});})`,
	cases: {
		consequent: async f => expect(await f(async _ => true, _ => 1, _ => 0)).toBe(1),
		alternate: async f => expect(await f(async _ => false, _ => 1, _ => 0)).toBe(0),
	},
});

compiledTest("return in consequent", {
	input: `async function(foo, bar) { if (foo) { var baz = await bar(); if (baz) { return baz; } }; return 0; }`,
	output: `_async(function(foo,bar){var _exit;return _call(function(){if(foo){return _call(bar,function(baz){if(baz){_exit=1;return baz;}});}},function(_result){if(_exit)return _result;return 0;});})`,
	cases: {
		"inner if": async f => expect(await f(true, async _ => 1)).toBe(1),
		"outer if": async f => expect(await f(true, async _ => 0)).toBe(0),
		"no entry": async f => expect(await f(false, async _ => 1)).toBe(0),
	},
});

compiledTest("arguments expression", {
	input: `async function() { var result = false; for (var i = 0; i < arguments.length; i++) { if (await arguments[i]()) result = true; }; return result; }`,
	output: `_async(function(){var _arguments=arguments;var result=false;return _await(_forTo(_arguments,function(i){return _await(_arguments[i](),function(_arguments$i){if(_arguments$i)result=true;});}),function(){return result;});})`,
	cases: {
		none: async f => expect(await f()).toBe(false),
		one: async f => expect(await f(async () => true)).toBe(true),
		two: async f => expect(await f(async () => false, async () => true)).toBe(true),
	},
});

compiledTest("this expressions", {
	input: `async function() { return await this.foo() + await this.bar() }`,
	output: `_async(function(){var _this=this;return _await(_this.foo(),function(_this$foo){return _await(_this.bar(),function(_this$bar){return _this$foo+_this$bar;});});})`,
	cases: {
		direct: async f => expect(await f.call({ foo: _ => 1, bar: _ => 2 })).toBe(3),
		async: async f => expect(await f.call({ foo: async _ => 2, bar: async _ => 4 })).toBe(6),
	},
});

compiledTest("this call property", {
	// Use || to avoid optimizations
	input: `async function(foo) { var result = await foo.bar(); return result || result; }`,
	output: `_async(function(foo){return _await(foo.bar(),function(result){return result||result;});})`,
	cases: {
		present: async f => expect(await f({ bar: function() { return this.baz; }, baz: 1})).toBe(1),
		missing: async f => expect(await f({ bar: function() { return this.baz; }})).toBe(undefined),
	},
});

compiledTest("this call subscript", {
	// Use || to avoid optimizations
	input: `async function(foo) { var result = await foo["bar"](); return result || result; }`,
	output: `_async(function(foo){return _await(foo["bar"](),function(result){return result||result;});})`,
	cases: {
		present: async f => expect(await f({ bar: function() { return this.baz; }, baz: 1})).toBe(1),
		missing: async f => expect(await f({ bar: function() { return this.baz; }})).toBe(undefined),
	},
});

compiledTest("arrow functions", {
	input: `async foo => foo`,
	output: `_async(function(foo){return foo;})`,
	cases: {
		true: async f => expect(await f(true)).toBe(true),
		false: async f => expect(await f(false)).toBe(false),
	},
});

compiledTest("arrow functions with this", {
	input: `function () { return async () => this; }`,
	output: `function(){var _this=this;return _async(function(){return _this;});}`,
	cases: {
		true: async f => {
			const object = {};
			expect(await f.call(object)()).toBe(object);
		}
	},
});

compiledTest("inner functions", {
	input: `function (value) { return async other => value + other; }`,
	output: `function(value){return _async(function(other){return value+other;});}`,
	cases: {
		result: async f => expect(await f(1)(2)).toBe(3),
	},
});

compiledTest("compound variable declarator", {
	input: `async function(foo) { var a = 1, b = await foo(), c = 3; return a + b + c; }`,
	output: `_async(function(foo){var a=1;return _call(foo,function(b){var c=3;return a+b+c;});})`,
	cases: {
		result: async f => expect(await f(async _ => 2)).toBe(6),
	},
});

compiledTest("calling member functions", {
	input: `async function(foo, bar) { return bar.baz(await foo()); }`,
	output: `_async(function(foo,bar){var _baz=bar.baz;return _call(foo,function(_foo){return _baz.call(bar,_foo);});})`,
	cases: {
		normal: async f => expect(await f(async _ => true, { baz: arg => arg })).toBe(true),
		reassign: async f => {
			const bar = {
				baz: () => true,
			};
			expect(await f(() => bar.baz = () => false, bar)).toBe(true)
		}
	},
});

compiledTest("catch and recover via return", {
	input: `async function(foo) { try { return await foo(); } catch(e) { return "fallback"; } }`,
	output: `_async(function(foo){return _call(foo,void 0,function(e){return"fallback";});})`,
	cases: {
		success: async f => expect(await f(async _ => "success")).toBe("success"),
		fallback: async f => expect(await f(async _ => { throw "test"; })).toBe("fallback"),
	},
});

compiledTest("catch and ignore", {
	input: `async function(foo) { try { return await foo(); } catch(e) { } }`,
	output: `_async(function(foo){return _call(foo,void 0,_empty);})`,
	cases: {
		success: async f => expect(await f(async _ => "success")).toBe("success"),
		fallback: async f => expect(await f(async _ => { throw "test"; })).toBe(undefined),
	},
});

compiledTest("catch and await", {
	input: `async function(foo, bar) { try { return await foo(); } catch(e) { await bar(); } }`,
	output: `_async(function(foo,bar){return _call(foo,void 0,function(e){return _callIgnored(bar);});})`,
	cases: {
		success: async f => expect(await f(async _ => "success", async _ => false)).toBe("success"),
		fallback: async f => expect(await f(async _ => { throw "test"; }, async _ => false)).toBe(undefined),
	},
});

compiledTest("catch and recover via variable", {
	input: `async function(value, log) { var result; try { result = await value(); } catch (e) { result = "an error"; }; log("result:", result); return result; }`,
	output: `_async(function(value,log){var result;return _await(_call(function(){return _call(value,function(_value){result=_value;});},void 0,function(e){result="an error";}),function(){log("result:",result);return result;});})`,
	cases: {
		success: async f => expect(await f(async _ => "success", async _ => false)).toBe("success"),
		recover: async f => expect(await f(async _ => { throw "test"; }, async _ => false)).toBe("an error"),
	},
});

compiledTest("finally passthrough", {
	input: `async function(value, log) { try { return await value(); } finally { log("finished value(), might rethrow"); } }`,
	output: `_async(function(value,log){return _finallyRethrows(_call(value),function(_wasThrown,_result){log("finished value(), might rethrow");return _rethrow(_wasThrown,_result);});})`,
	cases: {
		success: async f => expect(await f(async _ => "success", _ => undefined)).toBe("success"),
		throw: async f => {
			let result = false;
			try {
				await f(async _ => { throw "test"; }, _ => undefined);
			} catch (e) {
				result = true;
			}
			expect(result).toBe(true);
		}
	},
});

compiledTest("finally suppress original return", {
	input: `async function(value) { try { return await value(); } finally { return "suppressed"; } }`,
	output: `_async(function(value){return _finally(_call(value),function(){return"suppressed";});})`,
	cases: {
		success: async f => expect(await f(async _ => "success", _ => undefined)).toBe("suppressed"),
		recover: async f => expect(await f(async _ => { throw "test"; }, _ => undefined)).toBe("suppressed"),
	},
});

compiledTest("finally double", {
	input: `async function(func) { try { try { return await value(); } finally { if (0) { return "not this"; } } } finally { return "suppressed"; } }`,
	output: `_async(function(func){return _finally(_call(function(){return _finallyRethrows(_call(value),function(_wasThrown,_result){if(0){return"not this";}return _rethrow(_wasThrown,_result);});}),function(){return"suppressed";});})`,
	cases: {
		success: async f => expect(await f(async _ => "success", _ => undefined)).toBe("suppressed"),
		recover: async f => expect(await f(async _ => { throw "test"; }, _ => undefined)).toBe("suppressed"),
	},
});

compiledTest("try catch finally", {
	input: `async function(foo, bar, baz) { var result; try { return await foo(); } catch (e) { return await bar(); } finally { baz(); } }`,
	output: `_async(function(foo,bar,baz){var result;return _finallyRethrows(_call(foo,void 0,function(e){return bar();}),function(_wasThrown,_result){baz();return _rethrow(_wasThrown,_result);});})`,
	cases: {
		normal: async f => {
			const foo = async () => true;
			let barCalled = false;
			const bar = async () => {
				barCalled = true;
				return false;
			}
			let bazCalled = false;
			const baz = async () => {
				bazCalled = true;
			}
			expect(await f(foo, bar, baz)).toBe(true);
			expect(barCalled).toBe(false);
			expect(bazCalled).toBe(true);
		},
		throws: async f => {
			const foo = async () => {
				throw new Error();
			};
			let barCalled = false;
			const bar = async () => {
				barCalled = true;
				return false;
			}
			let bazCalled = false;
			const baz = async () => {
				bazCalled = true;
			}
			expect(await f(foo, bar, baz)).toBe(false);
			expect(barCalled).toBe(true);
			expect(bazCalled).toBe(true);
		},
	},
});

compiledTest("throw test", {
	input: `async function() { throw true; }`,
	output: `_async(function(){throw true;})`,
	cases: {
		throws: async f => {
			var result;
			try {
				await f()
				result = false;
			} catch (e) {
				result = e;
			}
			expect(result).toBe(true);
		}
	},
});


compiledTest("for to length iteration", {
	input: `async function(list) { var result = 0; for (var i = 0; i < list.length; i++) { result += await list[i](); } return result;}`,
	// input: `async function(list) { for (var i = 0; i < list.length; i++) { await list[i](); }}`,
	output: `_async(function(list){var result=0;return _await(_forTo(list,function(i){return _await(list[i](),function(_list$i){result+=_list$i;});}),function(){return result;});})`,
	cases: {
		zero: async f => expect(await f([])).toBe(0),
		one: async f => expect(await f([async _ => 1])).toBe(1),
		four: async f => expect(await f([async _ => 1, async _ => 3])).toBe(4),
		nine: async f => expect(await f([async _ => 1, async _ => 3, async _ => 5])).toBe(9),
	},
});

compiledTest("for to length with break", {
	input: `async function(list) { for (var i = 0; i < list.length; i++) { if (await list[i]()) { break; } }}`,
	output: `_async(function(list){var _interrupt;var i=0;return _awaitIgnored(_for(function(){return!_interrupt&&i<list.length;},function(){return i++;},function(){return _await(list[i](),function(_list$i){if(_list$i){_interrupt=1;}});}));})`,
	cases: {
		none: async f => expect(await f([])).toBe(undefined),
		single: async f => {
			let called = false;
			await f([async _ => called = true]);
			expect(called).toBe(true);
		},
		both: async f => {
			let called1 = false;
			let called2 = false;
			await f([async _ => { called1 = true }, async _ => called2 = true]);
			expect(called1).toBe(true);
			expect(called2).toBe(true);
		},
		stop: async f => {
			let called1 = false;
			let called2 = false;
			await f([async _ => called1 = true, async _ => called2 = true]);
			expect(called1).toBe(true);
			expect(called2).toBe(false);
		},
	},
});

compiledTest("for to length with continue", {
	input: `async function(list) { for (var i = 0; i < list.length; i++) { if (await list[i]()) { continue; } return false; } return true; }`,
	output: `_async(function(list){var _exit;var i=0;return _await(_for(function(){return!_exit&&i<list.length;},function(){return i++;},function(){return _await(list[i](),function(_list$i){if(_list$i){return;}_exit=1;return false;});}),function(_result){if(_exit)return _result;return true;});})`,
	cases: {
		none: async f => expect(await f([])).toBe(true),
		"single true": async f => expect(await f([async _ => false])).toBe(false),
		"single false": async f => expect(await f([async _ => true])).toBe(true),
		"true and false": async f => expect(await f([async _ => true, async _ => false])).toBe(false),
	},
});

compiledTest("for to length with mutation", {
	input: `async function(list) { for (var i = 0; i < list.length; i++) { if (await list[i]()) { i = list.length; } }}`,
	output: `_async(function(list){var i=0;return _awaitIgnored(_for(function(){return i<list.length;},function(){return i++;},function(){return _await(list[i](),function(_list$i){if(_list$i){i=list.length;}});}));})`,
	cases: {
		none: async f => expect(await f([])).toBe(undefined),
		single: async f => {
			let called = false;
			await f([async _ => called = true]);
			expect(called).toBe(true);
		},
		both: async f => {
			let called1 = false;
			let called2 = false;
			await f([async _ => { called1 = true }, async _ => called2 = true]);
			expect(called1).toBe(true);
			expect(called2).toBe(true);
		},
		stop: async f => {
			let called1 = false;
			let called2 = false;
			await f([async _ => called1 = true, async _ => called2 = true]);
			expect(called1).toBe(true);
			expect(called2).toBe(false);
		},
	},
});

compiledTest("for of await in body", {
	input: `async function(iter) { var result = 0; for (var value of iter) result += await value; return result; }`,
	output: `_async(function(iter){var result=0;return _await(_forOf(iter,function(value){return _await(value,function(_value){result+=_value;});}),function(){return result;});})`,
	cases: {
		empty: async f => expect(await f([])).toBe(0),
		single: async f => expect(await f([1])).toBe(1),
		multiple: async f => expect(await f([1,2])).toBe(3),
		error: async f => {
			try {
				await f({});
				// Should not get here
				expect(false).toBe(true);
			} catch (e) {
				expect(e.constructor).toBe(TypeError);
				expect(/\ is\ not\ iterable$/.test(e.message)).toBe(true);
			}
		}
	},
});

compiledTest("for of await in value", {
	input: `async function(foo) { var result = 0; for (var value of await foo()) result += value; return result; }`,
	output: `_async(function(foo){var result=0;return _call(foo,function(_foo){for(var value of _foo)result+=value;return result;});})`,
	cases: {
		empty: async f => expect(await f(async () => [])).toBe(0),
		single: async f => expect(await f(async () => [1])).toBe(1),
		multiple: async f => expect(await f(async () => [1,2])).toBe(3),
	},
});

compiledTest("for of await in body with break", {
	input: `async function(iter) { var result = 0; for (var value of iter) { result += await value; if (result > 10) break; } return result; }`,
	output: `_async(function(iter){var _interrupt;var result=0;return _await(_forOf(iter,function(value){return _await(value,function(_value){result+=_value;if(result>10){_interrupt=1;}});},function(){return _interrupt;}),function(){return result;});})`,
	cases: {
		empty: async f => expect(await f([])).toBe(0),
		single: async f => expect(await f([1])).toBe(1),
		multiple: async f => expect(await f([1,2])).toBe(3),
		break: async f => expect(await f([1,10,4])).toBe(11),
	},
});


compiledTest("while loop", {
	input: `async function(foo) { let shouldContinue = true; while (shouldContinue) { shouldContinue = await foo(); } }`,
	output: `_async(function(foo){let shouldContinue=true;return _awaitIgnored(_for(function(){return shouldContinue;},void 0,function(){return _call(foo,function(_foo){shouldContinue=_foo;});}));})`,
	cases: {
		one: async f => {
			var count = 0;
			expect(await f(async _ => { ++count })).toBe(undefined);
			expect(count).toBe(1);
		},
		two: async f => {
			var count = 0;
			expect(await f(async _ => { ++count; return count < 2; })).toBe(undefined);
			expect(count).toBe(2);
		},
		seven: async f => {
			var count = 0;
			expect(await f(async _ => { ++count; return count < 7; })).toBe(undefined);
			expect(count).toBe(7);
		},
	},
});

compiledTest("while predicate", {
	input: `async function(foo) { var count = 0; while(await foo()) { count++; } return count }`,
	output: `_async(function(foo){var count=0;return _await(_for(foo,void 0,function(){count++;}),function(){return count;});})`,
	cases: {
		one: async f => {
			var count = 0;
			expect(await f(async _ => { ++count })).toBe(0);
			expect(count).toBe(1);
		},
		two: async f => {
			var count = 0;
			expect(await f(async _ => { ++count; return count < 2; })).toBe(1);
			expect(count).toBe(2);
		},
		seven: async f => {
			var count = 0;
			expect(await f(async _ => { ++count; return count < 7; })).toBe(6);
			expect(count).toBe(7);
		},
	},
});

compiledTest("do while loop", {
	input: `async function(foo) { let shouldContinue; do { shouldContinue = await foo(); } while(shouldContinue); }`,
	output: `_async(function(foo){let shouldContinue;return _awaitIgnored(_do(function(){return _call(foo,function(_foo){shouldContinue=_foo;});},function(){return shouldContinue;}));})`,
	cases: {
		one: async f => {
			var count = 0;
			expect(await f(async _ => { ++count })).toBe(undefined);
			expect(count).toBe(1);
		},
		two: async f => {
			var count = 0;
			expect(await f(async _ => { ++count; return count < 2; })).toBe(undefined);
			expect(count).toBe(2);
		},
		seven: async f => {
			var count = 0;
			expect(await f(async _ => { ++count; return count < 7; })).toBe(undefined);
			expect(count).toBe(7);
		},
	},
});

compiledTest("do while return loop", {
	input: `async function(foo) { let shouldContinue; do { if (!await foo()) return true; } while(true); }`,
	output: `_async(function(foo){var _exit;let shouldContinue;return _await(_do(function(){return _call(foo,function(_foo){if(!_foo){_exit=1;return true;}});},function(){return!_exit;}),function(_result){if(_exit)return _result;});})`,
	cases: {
		one: async f => {
			var count = 0;
			expect(await f(async _ => { ++count })).toBe(true);
			expect(count).toBe(1);
		},
		two: async f => {
			var count = 0;
			expect(await f(async _ => { ++count; return count < 2; })).toBe(true);
			expect(count).toBe(2);
		},
		seven: async f => {
			var count = 0;
			expect(await f(async _ => { ++count; return count < 7; })).toBe(true);
			expect(count).toBe(7);
		},
	},
});

compiledTest("for in await object", {
	input: `async function(foo) { var keys = []; for (var key in await foo()) { keys.push(key); }; return keys.sort(); }`,
	output: `_async(function(foo){var keys=[];return _call(foo,function(_foo){for(var key in _foo){keys.push(key);}return keys.sort();});})`,
	cases: {
		two: async f => {
			var obj = { bar: 0, baz: 0 };
			expect(JSON.stringify(await f(async _ => obj))).toBe(`["bar","baz"]`);
		},
	},
});

compiledTest("for in await value", {
	input: `async function(foo) { var values = []; for (var key in foo) { values.push(await foo[key]()); }; return values.sort(); }`,
	output: `_async(function(foo){var values=[];return _await(_forIn(foo,function(key){var _push=values.push;return _await(foo[key](),function(_foo$key){_push.call(values,_foo$key);});}),function(){return values.sort();});})`,
	cases: {
		two: async f => {
			var obj = { bar: async _ => 0, baz: async _ => 1 };
			expect(JSON.stringify(await f(obj))).toBe(`[0,1]`);
		},
	},
});

compiledTest("for in own await value", {
	input: `async function(foo) { var values = []; for (var key in foo) { if (Object.prototype.hasOwnProperty.call(foo, key)) { values.push(await foo[key]()); } } return values.sort(); }`,
	output: `_async(function(foo){var values=[];return _await(_forOwn(foo,function(key){var _push=values.push;return _await(foo[key](),function(_foo$key){_push.call(values,_foo$key);});}),function(){return values.sort();});})`,
	cases: {
		two: async f => {
			var obj = { bar: async _ => 0, baz: async _ => 1 };
			expect(JSON.stringify(await f(obj))).toBe(`[0,1]`);
		},
	},
});

compiledTest("for in await value with return", {
	input: `async function(foo) { for (var key in foo) { if (await foo[key]()) return true }; return false }`,
	output: `_async(function(foo){var _exit;return _await(_forIn(foo,function(key){return _await(foo[key](),function(_foo$key){if(_foo$key){_exit=1;return true;}});},function(){return _exit;}),function(_result){if(_exit)return _result;return false;});})`,
	cases: {
		true: async f => {
			var obj = { foo: async _ => 0, bar: async _ => 1, baz: async _ => 0 };
			expect(await f(obj)).toBe(true);
		},
		false: async f => {
			var obj = { foo: async _ => 0, bar: async _ => 0, baz: async _ => 0 };
			expect(await f(obj)).toBe(false);
		},
	},
});

compiledTest("await for discriminant", {
	input: `async function(foo) { switch (await foo()) { case 1: return true; default: return false; } }`,
	output: `_async(function(foo){return _call(foo,function(_foo){switch(_foo){case 1:return true;default:return false;}});})`,
	cases: {
		true: async f => {
			expect(await f(async () => 1)).toBe(true);
		},
		false: async f => {
			expect(await f(async () => 0)).toBe(false);
		},
	},
});

compiledTest("await for body", {
	input: `async function(foo, bar) { switch (foo()) { case 1: return await bar(); default: return false; } }`,
	output: `_async(function(foo,bar){switch(foo()){case 1:return bar();default:return false;}})`,
	cases: {
		zero: async f => {
			expect(await f(() => 1, async () => 0)).toBe(0);
		},
		one: async f => {
			expect(await f(() => 1, async () => 1)).toBe(1);
		},
		false: async f => {
			expect(await f(() => 0)).toBe(false);
		},
	},
});

compiledTest("await for body indirect optimized", {
	input: `async function(foo, bar) { switch (foo()) { case 1: var result = await bar(); return result; default: return false; } }`,
	output: `_async(function(foo,bar){switch(foo()){case 1:return bar();default:return false;}})`,
	cases: {
		zero: async f => {
			expect(await f(() => 1, async () => 0)).toBe(0);
		},
		one: async f => {
			expect(await f(() => 1, async () => 1)).toBe(1);
		},
		false: async f => {
			expect(await f(() => 0)).toBe(false);
		},
	},
});

compiledTest("await for body indirect unoptimized", {
	input: `async function(foo, bar) { switch (foo()) { case 1: var result = await bar(); return result || null; default: return false; } }`,
	output: `_async(function(foo,bar){switch(foo()){case 1:return _call(bar,function(result){return result||null;});default:return false;}})`,
	cases: {
		zero: async f => {
			expect(await f(() => 1, async () => 0)).toBe(null);
		},
		one: async f => {
			expect(await f(() => 1, async () => 1)).toBe(1);
		},
		false: async f => {
			expect(await f(() => 0)).toBe(false);
		},
	},
});

compiledTest("await case", {
	input: `async function(foo, bar) { switch (await foo()) { case await bar(): return true; default: return false; } }`,
	output: `_async(function(foo,bar){return _call(foo,function(_foo){return _switch(_foo,[[function(){return bar();},function(){return true;}],[void 0,function(){return false;}]]);});})`,
	cases: {
		true: async f => {
			expect(await f(async () => 1, async () => 1)).toBe(true);
		},
		false: async f => {
			expect(await f(async () => 1, async () => 0)).toBe(false);
		},
	},
});

compiledTest("await break", {
	input: `async function(foo, bar) { var result; switch (await foo()) { case await bar(): result = true; break; default: result = false; break; } return result; }`,
	// output: `_async(function(foo,bar){var result;return _call(foo,function(_foo){return _await(_switch(_foo,[[function(){return bar();},function(){result=true;return;}],[void 0,function(){result=false;return;}]]),function(){return result;});});})`,
	output: `_async(function(foo,bar){var result;return _call(foo,function(_foo){var _interrupt;return _await(_switch(_foo,[[function(){return bar();},function(){result=true;_interrupt=1;}],[void 0,function(){result=false;_interrupt=1;}]]),function(){return result;});});})`,
	cases: {
		true: async f => {
			expect(await f(async () => 1, async () => 1)).toBe(true);
		},
		false: async f => {
			expect(await f(async () => 1, async () => 0)).toBe(false);
		},
	},
});

compiledTest("await complex switch", {
	input: `async function(foo, bar) { switch (foo) { case 1: case 2: return 0; case await bar(): if (foo) break; if (foo === 0) return 1; default: return 2; } return 3; }`,
	// output: `_async(function(foo,bar){var _exit,_break;return _await(_switch(foo,[[function(){return 1;}],[function(){return 2;},function(){_exit=1;return 0;}],[function(){return bar();},function(){if(foo){_break=1;return;}if(foo===0){_exit=1;return 1;}},function(){return _break||_exit;}],[void 0,function(){_exit=1;return 2;}]]),function(_result){if(_exit)return _result;return 3;});})`,
	output: `_async(function(foo,bar){var _exit,_interrupt;return _await(_switch(foo,[[function(){return 1;}],[function(){return 2;},function(){_exit=1;return 0;}],[function(){return bar();},function(){if(foo){_interrupt=1;return;}if(foo===0){_exit=1;return 1;}},function(){return _interrupt||_exit;}],[void 0,function(){_exit=1;return 2;}]]),function(_result){if(_exit)return _result;return 3;});})`,
	cases: {
		fallthrough: async f => {
			expect(await f(1)).toBe(0);
		},
		direct: async f => {
			expect(await f(2)).toBe(0);
		},
		break: async f => {
			expect(await f(3, async () => 3)).toBe(3);
		},
		return: async f => {
			expect(await f(0, async () => 0)).toBe(1);
		},
		default: async f => {
			expect(await f(0, async () => 2)).toBe(2);
		},
	},
});

compiledTest("for break with identifier", {
	input: `async function(foo) { loop: for (;;) { await foo(); break loop; } }`,
	output: `_async(function(foo){var _loopInterrupt;loop:return _awaitIgnored(_for(function(){return!_loopInterrupt;},void 0,function(){return _call(foo,function(){_loopInterrupt=1;});}));})`,
});

compiledTest("switch break with identifier", {
	input: `async function(foo) { exit: switch (0) { default: await foo(); break exit; } }`,
	// output: `_async(function(foo){return _awaitIgnored(_switch(0,[[void 0,function(){return _callIgnored(foo);}]]));})`,
	output: `_async(function(foo){var _exitInterrupt;return _awaitIgnored(_switch(0,[[void 0,function(){return _call(foo,function(){_exitInterrupt=1;});}]]));})`,
});

compiledTest("fetch example", {
	input: `async function(url) { var response = await fetch(url); var blob = await response.blob(); return URL.createObjectURL(blob); }`,
	output: `_async(function(url){return _await(fetch(url),function(response){return _await(response.blob(),function(blob){return URL.createObjectURL(blob);});});})`,
});

compiledTest("array literal", {
	input: `async function(left, right) { return [0, left(), 2, await right(), 4] }`,
	output: `_async(function(left,right){var _left=left();return _call(right,function(_right){return[0,_left,2,_right,4];});})`,
	cases: {
		value: async f => {
			expect(await f(() => 1, async () => 3)).toEqual([0, 1, 2, 3, 4]);
		},
		order: async f => {
			var leftCalled = false;
			await f(() => (expect(leftCalled).toBe(false), leftCalled = true), () => expect(leftCalled).toBe(true));
			expect(leftCalled).toBe(true);
		},
	}
});

compiledTest("object literal", {
	input: `async function(left, right) { return { zero: 0, one: left(), two: 2, three: await right(), four: 4 } }`,
	output: `_async(function(left,right){var _left=left();return _call(right,function(_right){return{zero:0,one:_left,two:2,three:_right,four:4};});})`,
	cases: {
		value: async f => {
			expect(await f(() => 1, async () => 3)).toEqual({ zero: 0, one: 1, two: 2, three: 3, four: 4 });
		},
		order: async f => {
			var leftCalled = false;
			await f(() => (expect(leftCalled).toBe(false), leftCalled = true), () => expect(leftCalled).toBe(true));
			expect(leftCalled).toBe(true);
		},
	}
});

compiledTest("sequence expression", {
	input: `async function(left, right) { return ((await left()), 1, (await right())) }`,
	output: `_async(function(left,right){return _call(left,function(_left){return _call(right,function(_right){return _right;});});})`,
	cases: {
		value: async f => {
			expect(await f(async () => false, async () => true)).toEqual(true);
		},
		order: async f => {
			var leftCalled = false;
			await f(() => (expect(leftCalled).toBe(false), leftCalled = true), () => expect(leftCalled).toBe(true));
			expect(leftCalled).toBe(true);
		},
	}
});

compiledTest("class methods", {
	input: `function() { return class { async foo(baz) { return await baz(); } static async bar(baz) { return await baz(); } } }`,
	output: `function(){return class{foo(baz){return _call(function(){return baz();});}static bar(baz){return _call(function(){return baz();});}};}`,
	cases: {
		method: async f => expect(await (new (f())).foo(async () => true)).toBe(true),
		"class method": async f => expect(await f().bar(async () => true)).toBe(true),
	}
});

compiledTest("class methods with pseudo-variables", {
	input: `function() { return class { async testThis() { return this; } async testArguments() { return arguments[0]; } }; }`,
	output: `function(){return class{testThis(){var _this=this;return _call(function(){return _this;});}testArguments(){var _arguments=arguments;return _call(function(){return _arguments[0];});}};}`,
	cases: {
		"this": async f => {
			const object = new (f());
			expect(await object.testThis()).toBe(object);
		},
		"arguments": async f => {
			const object = new (f());
			expect(await object.testArguments(1)).toBe(1);
		},
	}
});

compiledTest("object method syntax", {
	input: `function() { return { async foo(bar) { return await bar(); } }; }`,
	output: `function(){return{foo:_async(function(bar){return bar();})};}`,
	cases: {
		method: async f => expect(await f().foo(async () => true)).toBe(true),
	}
});

compiledTest("variable hoisting", {
	input: `async function(foo) { function baz() { return bar; } var bar = await foo(); return baz(); }`,
	output: `_async(function(foo){var bar;function baz(){return bar;}return _call(foo,function(_foo){bar=_foo;return baz();});})`,
	cases: {
		value: async f => expect(await f(() => true)).toBe(true),
	}
});

compiledTest("complex hoisting", {
	input: `async function(foo, baz) { if (foo()) { var result = await bar(); function bar() { return 1; } } else { result = await baz(); }; return result; }`,
	output: `_async(function(foo,baz){var result;return _call(function(){if(foo()){function bar(){return 1;}return _call(bar,function(_bar){result=_bar;});}else{return _call(baz,function(_baz){result=_baz;});}},function(){return result;});})`,
	cases: {
		consequent: async f => expect(await f(_ => true, async _ => 0)).toBe(1),
		alternate: async f => expect(await f(_ => false, async _ => 0)).toBe(0),
	},
});

compiledTest("helper names", {
	input: `async function(_async, _await) { return await _async(0) && _await(); }`,
	output: `_async3(function(_async,_await){return _await2(_async(0),function(_async2){return _async2&&_await();});})`,
	cases: {
		value: async f => expect(await f(_ => true, _ => true)).toBe(true),
	},
});

compiledTest("for of await double with break", {
	input: `async function(matrix) { var result = 0; outer: for (var row of matrix) { for (var value of row) { result += await value; if (result > 10) break outer; } } return result; }`,
	output: `_async(function(matrix){var _outerInterrupt;var result=0;return _await(_forOf(matrix,function(row){return _awaitIgnored(_forOf(row,function(value){return _await(value,function(_value){result+=_value;if(result>10){_outerInterrupt=1;}});},function(){return _outerInterrupt;}));},function(){return _outerInterrupt;}),function(){return result;});})`,
	cases: {
		empty: async f => expect(await f([])).toBe(0),
		single: async f => expect(await f([[1]])).toBe(1),
		multiple: async f => expect(await f([[1,2],[3,4]])).toBe(10),
		break: async f => expect(await f([[1,10,4],[5,4]])).toBe(11),
	},
});
