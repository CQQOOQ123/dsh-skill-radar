const registered = [];
const fakeReact = {
  createElement: (...args) => ({ type: args[0], props: { ...(args[1] || {}), children: args.slice(2) } }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  Component: class Component { constructor(props) { this.props = props || {}; this.state = {}; } setState() {} },
  useState: (v) => [v, () => {}],
};
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      const mod = factory((name) => (name === 'react' ? fakeReact : null));
      if (!mod || !Array.isArray(mod.inject) || typeof mod.apply !== 'function') throw new Error('bad module shape');
      mod.apply({
        slots: {
          inject(slot, cb) {
            if (!['settings.section', 'shell.overlay', 'tool.call.toolview'].includes(slot)) throw new Error('wrong slot: ' + slot);
            cb();
          },
          register(options, component) {
            const ok = ['settings.section', 'shell.overlay', 'tool.call.toolview'].includes(options.name)
              && (options.id || options.key);
            if (!ok) throw new Error('bad registration');
            if (typeof component !== 'function') throw new Error('component missing');
            registered.push({ slot: options.name, id: options.id || options.key, label: options.label, order: options.order, component });
            return () => {};
          },
        },
      });
      console.log('module id:', id);
    },
  },
};
await import('./client.js');
console.log('registered:', JSON.stringify(registered));
if (!registered.length) throw new Error('nothing registered');
// 首屏渲染冒烟：data=null 时也必须返回树，不能抛错（防空白页回归）。
const tree = registered[0].component();
if (!tree || typeof tree !== 'object') throw new Error('component returned no tree');
let nodes = 0;
const walk = (node) => {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') return;
  if (Array.isArray(node)) { for (const item of node) walk(item); return; }
  nodes += 1;
  if (node.type && node.type.name === 'PanelBoundary') { walk(node.props && node.props.children); return; }
  if (typeof node.type === 'function') {
    try { walk(node.type(node.props || {})); } catch (err) { console.error('component render failed:', err && err.message); }
    return;
  }
  if (node.props) walk(node.props.children);
};
walk(tree);
if (nodes < 5) throw new Error(`render tree too small: ${nodes}`);
console.log('render smoke nodes:', nodes);
console.log('CLIENT HARNESS OK');
