const YIELD_EXPRESSION = /\(([A-Za-z_$][\w$]*)\+1\)%25===0&&await new Promise\(([A-Za-z_$][\w$]*)=>self\.setTimeout\(\2,0\)\)/g;

export function findYieldMatches(source) {
	return [...source.matchAll(YIELD_EXPRESSION)].map((match) => ({
		index: match.index,
		text: match[0],
	}));
}

export function parseGeneratedJavaScript(source) {
	return new Function('require', 'module', 'exports', source);
}

export function instrumentWorkerSource(source) {
	const matches = findYieldMatches(source);
	if (matches.length !== 1) {
		throw new Error(`Expected exactly one compiled 25-file yield, found ${matches.length}.`);
	}

	const transformed = source.replace(YIELD_EXPRESSION, (_match, index) => `(${index}+1)%25===0&&await new Promise(__resume => {
	const __gate = new SharedArrayBuffer(4);
	self.postMessage({ type: 'paused', gate: __gate });
	Atomics.wait(new Int32Array(__gate), 0, 0);
	__resume();
})`);
	parseGeneratedJavaScript(transformed);
	return transformed;
}
