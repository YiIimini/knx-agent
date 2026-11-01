/**
 * Client half: the KNX commissioning panel.
 *
 * Two registrations, both plain React (no JSX, no build step):
 *   - `sidebar.panellist` id `knx` — the nav icon; the sidebar projects its label
 *     and dispatches main-panel key `knx`.
 *   - `main` key `knx` — the panel body.
 *
 * All data comes from the Host half over `/knx/api` (same origin), which routes
 * into the same operations the agent tools call.
 */

window.__ModuleLoader__.load({
  id: '@local/knx-agent',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const NS = 'knxAgent';

    const TEXT = {
      zh: {
        title: 'KNX 调试',
        subtitle: 'KNXnet/IP 现场调试与验收',
        connected: '已连接',
        disconnected: '未连接',
        gateway: '网关',
        connect: '连接',
        disconnect: '断开',
        simulator: '模拟器',
        simulatorStart: '启动模拟器',
        simulatorStop: '停止模拟器',
        scanTitle: '扫线',
        line: '线路',
        scan: '扫描',
        devices: '设备',
        noDevices: '未发现设备',
        maskVersion: '掩码',
        info: '信息',
        groupTitle: '组值',
        address: '组地址',
        dpt: 'DPT',
        value: '值',
        write: '写入',
        read: '读取',
        downloadTitle: '下载',
        recipe: '配方 JSON',
        ia: '个体地址',
        dryRun: '预演',
        run: '执行',
        step: '步骤',
        result: '结果',
        monitorTitle: '监听',
        seconds: '秒',
        start: '开始',
        frames: '帧',
        diagTitle: '诊断',
        diagnose: '诊断',
        findings: '结论',
        readOnly: '只读模式',
        busy: '执行中…',
        ok: '成功',
        failed: '失败',
        empty: '暂无数据',
        needConnection: '先连接网关或启动模拟器',
        next: '下一步',
        libraryTitle: '产品数据 / 工程',
        importFile: '导入',
        resolve: '解析设备',
        parameters: '参数',
        buildRecipe: '生成配方',
        proxyTitle: 'ETS 录制代理',
        proxyHint: 'ETS 连到本代理端口，代理转发到真实网关并落盘',
        listening: '监听',
        channels: '通道',
        captures: '捕获文件',
        buildFromCapture: '从捕获生成配方',
        catalogTitle: '配方库',
        installRecipe: '入库当前配方',
        installed: '已入库',
        apply: '套用',
        applied: '已套用',
        uses: '次数',
        start: '启动',
        stop: '停止',
      },
      en: {
        title: 'KNX',
        subtitle: 'KNXnet/IP commissioning and acceptance',
        connected: 'connected',
        disconnected: 'disconnected',
        gateway: 'Gateway',
        connect: 'Connect',
        disconnect: 'Disconnect',
        simulator: 'Simulator',
        simulatorStart: 'Start simulator',
        simulatorStop: 'Stop simulator',
        scanTitle: 'Line scan',
        line: 'Line',
        scan: 'Scan',
        devices: 'devices',
        noDevices: 'no device answered',
        maskVersion: 'mask',
        info: 'Info',
        groupTitle: 'Group value',
        address: 'Address',
        dpt: 'DPT',
        value: 'Value',
        write: 'Write',
        read: 'Read',
        downloadTitle: 'Download',
        recipe: 'Recipe JSON',
        ia: 'Individual address',
        dryRun: 'Dry run',
        run: 'Run',
        step: 'step',
        result: 'result',
        monitorTitle: 'Monitor',
        seconds: 'seconds',
        start: 'Start',
        frames: 'frames',
        diagTitle: 'Diagnose',
        diagnose: 'Diagnose',
        findings: 'findings',
        readOnly: 'read-only',
        busy: 'working…',
        ok: 'ok',
        failed: 'failed',
        empty: 'no data',
        needConnection: 'connect a gateway or start the simulator first',
        next: 'next',
        libraryTitle: 'Product data / project',
        importFile: 'Import',
        resolve: 'Resolve device',
        parameters: 'parameters',
        buildRecipe: 'Build recipe',
        proxyTitle: 'ETS recording proxy',
        proxyHint: 'point ETS at this port; frames are forwarded to the gateway and recorded',
        listening: 'listening',
        channels: 'channels',
        captures: 'Captures',
        buildFromCapture: 'Recipe from capture',
        catalogTitle: 'Recipe catalog',
        installRecipe: 'Store current recipe',
        installed: 'stored',
        apply: 'Apply',
        applied: 'applied',
        uses: 'uses',
        start: 'Start',
        stop: 'Stop',
      },
    };

    const css = `
.knx-panel { display:flex; flex-direction:column; gap:16px; padding:20px 24px 28px; height:100%; overflow:auto; box-sizing:border-box; color:var(--dsw-alias-label-primary); }
.knx-head { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
.knx-title { font-size:16px; line-height:24px; font-weight:600; margin:0; }
.knx-sub { font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary); }
.knx-pill { display:inline-flex; align-items:center; gap:6px; padding:2px 9px; border-radius:999px; font-size:12px; line-height:18px; border:1px solid var(--dsw-alias-border-l1); }
.knx-dot { width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-state-idle-primary); }
.knx-dot.on { background:var(--dsw-alias-state-success-primary); }
.knx-dot.bad { background:var(--dsw-alias-state-error-primary); }
.knx-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.knx-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); gap:14px; align-items:start; }
.knx-card { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:12px; padding:14px; display:flex; flex-direction:column; gap:10px; min-width:0; }
.knx-card h3 { margin:0; font-size:13px; line-height:20px; font-weight:600; letter-spacing:.01em; }
.knx-card .knx-note { font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary); }
.knx-input { height:30px; padding:0 9px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:13px; min-width:0; }
.knx-input:focus { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.knx-textarea { min-height:88px; padding:8px 9px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; line-height:16px; resize:vertical; }
.knx-btn { height:30px; padding:0 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:13px; cursor:pointer; transition:background-color .2s ease; }
.knx-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)); }
.knx-btn:disabled { opacity:.45; cursor:not-allowed; }
/* primary: fill and text come from the same button pair as the rest of the UI. A
   hard-coded white would be invisible in the dark theme, where the brand fill is
   near-white and the contrast fill is dark. */
.knx-btn.primary { border-color:transparent; background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); color:var(--dsw-alias-button-contrast-fill, var(--dsw-alias-bg-base)); }
.knx-btn.primary:hover:not(:disabled) { background:var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); }
.knx-btn.ghost { border-color:transparent; background:transparent; color:var(--dsw-alias-label-secondary); }
.knx-btn.ghost:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover, transparent); color:var(--dsw-alias-label-primary); }
.knx-table { width:100%; border-collapse:collapse; font-size:12px; line-height:18px; }
.knx-table th { text-align:left; font-weight:500; color:var(--dsw-alias-label-secondary); padding:4px 6px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.knx-table td { padding:4px 6px; border-bottom:1px solid var(--dsw-alias-border-l1); vertical-align:top; }
.knx-table tr:last-child td { border-bottom:none; }
.knx-table td.mono, .knx-mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; }
.knx-tag { font-size:11px; padding:1px 6px; border-radius:6px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.knx-tag.high { color:var(--dsw-alias-state-error-primary); border-color:currentColor; }
.knx-tag.medium { color:var(--dsw-alias-state-warn-primary); border-color:currentColor; }
.knx-tag.info { color:var(--dsw-alias-label-secondary); }
.knx-tag.ok { color:var(--dsw-alias-state-success-primary); border-color:currentColor; }
.knx-banner { border:1px solid var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); border-radius:8px; padding:8px 10px; font-size:12px; line-height:18px; }
.knx-scroll { max-height:230px; overflow:auto; }
.knx-empty { font-size:12px; color:var(--dsw-alias-label-secondary); padding:6px 0; }
.knx-kv { display:flex; justify-content:space-between; gap:10px; font-size:12px; line-height:18px; }
.knx-kv span:first-child { color:var(--dsw-alias-label-secondary); }
`;

    const api = {
      async get(path) {
        const response = await fetch(path, { headers: { accept: 'application/json' } });
        return response.json();
      },
      async op(name, args) {
        const response = await fetch('/knx/api/op', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ name, args: args ?? {} }),
        });
        return response.json();
      },
    };

    function Pill({ state, t }) {
      const on = Boolean(state?.connection?.connected);
      const sim = Boolean(state?.simulator?.running);
      return h('span', { className: 'knx-pill' },
        h('span', { className: `knx-dot${on ? ' on' : ''}` }),
        on ? t('connected') : t('disconnected'),
        sim ? h('span', { className: 'knx-tag', style: { marginLeft: 4 } }, `${t('simulator')} :${state.simulator.port}`) : null);
    }

    function Table({ columns, rows, empty }) {
      if (!rows || !rows.length) return h('div', { className: 'knx-empty' }, empty);
      return h('div', { className: 'knx-scroll' },
        h('table', { className: 'knx-table' },
          h('thead', null, h('tr', null, columns.map((column) => h('th', { key: column.key }, column.label)))),
          h('tbody', null, rows.map((row, index) => h('tr', { key: index },
            columns.map((column) => h('td', {
              key: column.key,
              className: column.mono ? 'mono' : undefined,
            }, column.render ? column.render(row) : String(row[column.key] ?? ''))))))));
    }

    function ScanCard({ t, state, call, busy }) {
      const [line, setLine] = useState('1.1');
      const [result, setResult] = useState(null);
      const scan = () => call('scan', { line, start: 0, end: 256, window: 48 }).then((value) => {
        setResult(value);
        return value;
      });
      return h('div', { className: 'knx-card' },
        h('h3', null, t('scanTitle')),
        h('div', { className: 'knx-row' },
          h('label', { className: 'knx-sub' }, t('line')),
          h('input', {
            className: 'knx-input', style: { width: 90 }, value: line,
            onChange: (event) => setLine(event.target.value),
          }),
          h('button', { className: 'knx-btn primary', disabled: busy || !state?.connection?.connected, onClick: scan }, t('scan'))),
        result && result.ok === false ? h('div', { className: 'knx-banner' }, result.error) : null,
        result && result.ok
          ? h(Table, {
            columns: [
              { key: 'iaText', label: 'IA', mono: true },
              { key: 'descriptor', label: t('maskVersion'), mono: true, render: (row) => (row.descriptor === null || row.descriptor === undefined ? '—' : `0x${row.descriptor.toString(16).toUpperCase().padStart(4, '0')}`) },
            ],
            rows: result.devices,
            empty: t('noDevices'),
          })
          : h('div', { className: 'knx-empty' }, t('empty')),
        h('div', { className: 'knx-note' }, `${t('devices')}: ${result?.count ?? 0}`));
    }

    function GroupCard({ t, state, call, busy, initialAddress }) {
      const [address, setAddress] = useState(initialAddress ?? '1/2/3');
      const [dpt, setDpt] = useState('9.001');
      const [value, setValue] = useState('21.5');
      const [result, setResult] = useState(null);
      useEffect(() => { if (initialAddress) setAddress(initialAddress); }, [initialAddress]);
      const write = () => call('gaWrite', { ga: address, dpt, value: Number.isNaN(Number(value)) ? value : Number(value) }).then(setResult);
      const read = () => call('gaRead', { ga: address, dpt }).then(setResult);
      return h('div', { className: 'knx-card' },
        h('h3', null, t('groupTitle')),
        h('div', { className: 'knx-row' },
          h('input', { className: 'knx-input', style: { width: 92 }, value: address, onChange: (event) => setAddress(event.target.value) }),
          h('input', { className: 'knx-input', style: { width: 74 }, value: dpt, onChange: (event) => setDpt(event.target.value) }),
          h('input', { className: 'knx-input', style: { width: 84 }, value, onChange: (event) => setValue(event.target.value) })),
        h('div', { className: 'knx-row' },
          h('button', { className: 'knx-btn primary', disabled: busy || !state?.connection?.connected || state?.config?.allowWrites === false, onClick: write }, t('write')),
          h('button', { className: 'knx-btn', disabled: busy || !state?.connection?.connected, onClick: read }, t('read'))),
        result
          ? (result.ok
            ? h('div', { className: 'knx-kv' },
              h('span', null, `${result.ga} ${result.dpt ?? ''}`),
              h('span', { className: 'knx-mono' }, `${String(result.value ?? '')} ${result.raw ? `(${result.raw})` : ''}`))
            : h('div', { className: 'knx-banner' }, result.error))
          : h('div', { className: 'knx-empty' }, t('empty')));
    }

    function DownloadCard({ t, state, call, busy, seed }) {
      const example = JSON.stringify({
        device: { ia: '1.1.2' },
        steps: [
          { op: 'memory_write', address: '0x4700', data: '0a00ff10' },
          { op: 'memory_expect', address: '0x4700', data: '0a00ff10' },
          { op: 'restart', master: false },
          { op: 'group_expect', ga: '1/2/3', dpt: '1.001', value: 1, timeout: 3 },
        ],
      }, null, 2);
      const [text, setText] = useState(example);
      useEffect(() => { if (seed) setText(seed); }, [seed]);
      const [result, setResult] = useState(null);
      const [valid, setValid] = useState(null);
      const parse = () => {
        try {
          return { recipe: JSON.parse(text) };
        } catch (error) {
          setResult({ ok: false, error: `JSON: ${error.message}` });
          return null;
        }
      };
      const validate = () => {
        const parsed = parse();
        if (parsed) call('validateRecipe', parsed).then(setValid);
      };
      const run = (dryRun) => {
        const parsed = parse();
        if (parsed) call('download', { ...parsed, dryRun }).then(setResult);
      };
      return h('div', { className: 'knx-card' },
        h('h3', null, t('downloadTitle')),
        h('textarea', { className: 'knx-textarea', value: text, onChange: (event) => setText(event.target.value), spellCheck: false }),
        h('div', { className: 'knx-row' },
          h('button', { className: 'knx-btn ghost', onClick: validate }, 'validate'),
          h('button', { className: 'knx-btn', disabled: busy || !state?.connection?.connected, onClick: () => run(true) }, t('dryRun')),
          h('button', {
            className: 'knx-btn primary',
            disabled: busy || !state?.connection?.connected || state?.config?.allowWrites === false,
            onClick: () => run(false),
          }, t('run'))),
        valid ? h('div', { className: 'knx-note' }, valid.ok ? `${valid.steps} ${t('step')} · ${Object.entries(valid.ops ?? {}).map(([op, n]) => `${op}×${n}`).join(' ')}` : `✗ ${valid.error}`) : null,
        result && result.ok === false && result.error ? h('div', { className: 'knx-banner' }, result.error) : null,
        result && Array.isArray(result.steps)
          ? h(Table, {
            columns: [
              { key: 'index', label: '#', mono: true },
              { key: 'op', label: t('step'), mono: true },
              { key: 'ok', label: t('result'), render: (row) => h('span', { className: `knx-tag ${row.ok ? 'ok' : 'high'}` }, row.ok ? t('ok') : t('failed')) },
              { key: 'detail', label: '', mono: true },
            ],
            rows: result.steps,
            empty: t('empty'),
          })
          : h('div', { className: 'knx-empty' }, t('empty')));
    }

    function LibraryCard({ t, state, call, busy, onRecipe }) {
      const [file, setFile] = useState('plugins/knx-agent/examples/acme-dimmer.knxprod');
      const [ia, setIa] = useState('1.1.2');
      const [values, setValues] = useState('{"P-dim-time": 300}');
      const [listing, setListing] = useState(null);
      const [resolved, setResolved] = useState(null);
      const [built, setBuilt] = useState(null);

      const load = useCallback(() => call('library', { action: 'list' }).then(setListing), [call]);
      useEffect(() => { load(); }, [load]);

      const importFile = () => call('import', { path: file }).then(load);
      const resolve = () => call('library', { action: 'resolve', ia }).then((value) => { setResolved(value); return value; });
      const build = () => {
        let parsed = {};
        try { parsed = JSON.parse(values); } catch (error) { setBuilt({ ok: false, error: `JSON: ${error.message}` }); return; }
        call('buildDownload', { values: parsed, ia }).then((value) => {
          setBuilt(value);
          onRecipe?.(value?.recipe);
          return value;
        });
      };

      return h('div', { className: 'knx-card' },
        h('h3', null, t('libraryTitle')),
        h('div', { className: 'knx-row' },
          h('input', { className: 'knx-input', style: { flex: 1, minWidth: 160 }, value: file, onChange: (event) => setFile(event.target.value) }),
          h('button', { className: 'knx-btn', disabled: busy, onClick: importFile }, t('importFile'))),
        listing
          ? h('div', { className: 'knx-scroll', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            [...(listing.products ?? []), ...(listing.projects ?? [])].map((entry) => h('div', { key: entry.id, className: 'knx-kv' },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${entry.kind === 'knxprod' ? 'PM' : 'PRJ'} ${entry.name}`),
              h('span', { className: 'knx-mono', title: entry.id }, `${entry.summary?.applications ?? entry.summary?.devices ?? '?'} · ${entry.id.slice(-12)}`))))
          : h('div', { className: 'knx-empty' }, t('empty')),
        h('div', { className: 'knx-row' },
          h('input', { className: 'knx-input', style: { width: 90 }, value: ia, onChange: (event) => setIa(event.target.value) }),
          h('button', { className: 'knx-btn', disabled: busy, onClick: resolve }, t('resolve'))),
        resolved && resolved.ok
          ? h('div', { className: 'knx-note' },
            `${resolved.application?.name ?? '—'} · ${resolved.application?.maskVersion ?? ''} · ${t('parameters')} ${(resolved.application?.parameters ?? []).filter((p) => p.address).length}/${(resolved.application?.parameters ?? []).length}`)
          : (resolved && resolved.error ? h('div', { className: 'knx-banner' }, resolved.error) : null),
        h('textarea', { className: 'knx-textarea', style: { minHeight: 54 }, value: values, onChange: (event) => setValues(event.target.value), spellCheck: false }),
        h('div', { className: 'knx-row' },
          h('button', { className: 'knx-btn primary', disabled: busy, onClick: build }, t('buildRecipe'))),
        built && built.ok
          ? h(Table, {
            columns: [
              { key: 'parameter', label: 'param', mono: true },
              { key: 'address', label: 'addr', mono: true },
              { key: 'bits', label: 'bits', mono: true },
              { key: 'bytes', label: 'bytes', mono: true },
            ],
            rows: built.plan,
            empty: t('empty'),
          })
          : (built && built.error ? h('div', { className: 'knx-banner' }, built.error) : null));
    }

    function CatalogCard({ t, call, busy, seed, onRecipe }) {
      const [entries, setEntries] = useState([]);
      const [ia, setIa] = useState('1.1.2');
      const [product, setProduct] = useState('AKH-0401.02');
      const [note, setNote] = useState('');

      const load = useCallback(() => call('catalog', { action: 'list' }).then((value) => {
        if (value?.ok) setEntries(value.entries ?? []);
        return value;
      }), [call]);
      useEffect(() => { load(); }, [load]);

      const install = () => {
        let recipe;
        try { recipe = JSON.parse(seed || '{}'); } catch (error) { setNote(`JSON: ${error.message}`); return; }
        if (!recipe.steps) { setNote(t('empty')); return; }
        call('catalog', { action: 'install', recipe, orderNumber: product || undefined, ia }).then((value) => {
          setNote(value?.ok ? `${t('installed')} ${value.id}` : (value?.error ?? 'failed'));
          load();
          return value;
        });
      };
      const apply = (id) => call('catalog', { action: 'apply', recipeId: id, ia }).then((value) => {
        if (value?.recipe) { onRecipe?.(value.recipe); setNote(`${t('applied')} ${value.id} · ${t('uses')} ${value.uses}`); }
        else setNote(value?.error ?? 'failed');
        load();
        return value;
      });

      return h('div', { className: 'knx-card' },
        h('h3', null, t('catalogTitle')),
        h('div', { className: 'knx-row' },
          h('input', { className: 'knx-input', style: { flex: 1, minWidth: 120 }, placeholder: 'AKH-0401.02',
            value: product, onChange: (event) => setProduct(event.target.value) }),
          h('input', { className: 'knx-input', style: { width: 84 }, value: ia, onChange: (event) => setIa(event.target.value) }),
          h('button', { className: 'knx-btn', disabled: busy || !seed, onClick: install }, t('installRecipe'))),
        entries.length
          ? h('div', { className: 'knx-scroll', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            entries.map((entry) => h('div', { key: entry.id, className: 'knx-kv', style: { alignItems: 'center' } },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: entry.id },
                `${entry.orderNumber ?? entry.applicationId ?? entry.deviceName ?? '—'}`),
              h('span', { className: 'knx-row', style: { gap: 4 } },
                h('span', { className: 'knx-tag' }, `${entry.steps} ${t('step')}`),
                h('span', { className: 'knx-tag' }, `×${entry.uses ?? 0}`),
                h('button', { className: 'knx-btn ghost', style: { height: 22, padding: '0 8px' }, onClick: () => apply(entry.id) }, t('apply'))))))
          : h('div', { className: 'knx-empty' }, t('empty')),
        note ? h('div', { className: 'knx-note', style: { wordBreak: 'break-all' } }, note) : null);
    }

    function ProxyCard({ t, state, call, busy, onRecipe }) {
      const [port, setPort] = useState('3671');
      const [upstream, setUpstream] = useState('');
      const [status, setStatus] = useState(null);
      const [captures, setCaptures] = useState(null);
      const [capturePath, setCapturePath] = useState('');
      const [ia, setIa] = useState('1.1.2');
      const [built, setBuilt] = useState(null);

      const refresh = useCallback(() => call('proxy', { action: 'status' }).then(setStatus), [call]);
      useEffect(() => { refresh(); }, [refresh]);

      const start = () => {
        const [host, hostPort] = upstream.split(':');
        return call('proxy', {
          action: 'start',
          port: Number(port) || 3671,
          upstream: host ? { host, port: Number(hostPort) || 3671 } : undefined,
        }).then(setStatus);
      };
      const stop = () => call('proxy', { action: 'stop' }).then(setStatus);
      const listCaptures = () => call('proxy', { action: 'captures' }).then((value) => {
        setCaptures(value);
        if (value.captures?.[0]) setCapturePath(value.captures[0].path);
        return value;
      });
      const build = () => call('recipeFromCapture', { capturePath, ia }).then((value) => {
        setBuilt(value);
        if (value?.recipe) onRecipe?.(value.recipe);
        return value;
      });

      return h('div', { className: 'knx-card' },
        h('h3', null, t('proxyTitle')),
        h('div', { className: 'knx-row' },
          h('input', { className: 'knx-input', style: { width: 70 }, value: port, onChange: (event) => setPort(event.target.value) }),
          h('input', { className: 'knx-input', style: { flex: 1, minWidth: 120 }, placeholder: '192.168.1.50:3671',
            value: upstream, onChange: (event) => setUpstream(event.target.value) }),
          h('button', { className: 'knx-btn primary', disabled: busy || status?.running, onClick: start }, t('start')),
          h('button', { className: 'knx-btn', disabled: busy || !status?.running, onClick: stop }, t('stop'))),
        status?.running
          ? h('div', { className: 'knx-note' }, `${t('listening')} :${status.listenPort} → ${status.upstream?.host}:${status.upstream?.port} · ${t('frames')} ${status.stats?.framesFromClient ?? 0}/${status.stats?.framesToClient ?? 0} · ${status.channels?.length ?? 0} ${t('channels')}`)
          : h('div', { className: 'knx-empty' }, t('proxyHint')),
        h('div', { className: 'knx-row' },
          h('button', { className: 'knx-btn ghost', disabled: busy, onClick: listCaptures }, t('captures'))),
        captures
          ? h('div', { className: 'knx-scroll', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            (captures.captures ?? []).slice(0, 8).map((entry) => h('button', {
              key: entry.path, className: 'knx-btn ghost', title: entry.path,
              style: { textAlign: 'left', height: 'auto', padding: '4px 8px', fontFamily: 'ui-monospace,monospace', fontSize: 11 },
              onClick: () => setCapturePath(entry.path),
            }, `${entry.name.slice(-28)} · ${entry.size}B`)))
          : null,
        h('div', { className: 'knx-row' },
          h('input', { className: 'knx-input', style: { width: 90 }, value: ia, onChange: (event) => setIa(event.target.value) }),
          h('button', { className: 'knx-btn', disabled: busy || !capturePath, onClick: build }, t('buildFromCapture'))),
        built && built.ok
          ? h('div', { className: 'knx-note' }, `${built.frames} ${t('frames')} → ${built.steps} ${t('step')}`)
          : (built && built.error ? h('div', { className: 'knx-banner' }, built.error) : null));
    }

    function MonitorCard({ t, state, call, busy, onFrames }) {
      const [seconds, setSeconds] = useState('5');
      const [result, setResult] = useState(null);
      const start = () => call('monitor', { seconds: Number(seconds) || 5, groupOnly: false }).then((value) => {
        setResult(value);
        onFrames?.(value.frames ?? []);
        return value;
      });
      return h('div', { className: 'knx-card' },
        h('h3', null, t('monitorTitle')),
        h('div', { className: 'knx-row' },
          h('input', { className: 'knx-input', style: { width: 64 }, value: seconds, onChange: (event) => setSeconds(event.target.value) }),
          h('span', { className: 'knx-sub' }, t('seconds')),
          h('button', { className: 'knx-btn', disabled: busy || !state?.connection?.connected, onClick: start }, t('start'))),
        result && result.ok
          ? h(Table, {
            columns: [
              { key: 'src', label: 'src', mono: true },
              { key: 'dst', label: 'dst', mono: true },
              { key: 'service', label: 'service', mono: true, render: (row) => String(row.service ?? '').replace('A_GroupValue_', 'GV_') },
              { key: 'value', label: 'value', mono: true },
            ],
            rows: (result.frames ?? []).slice(-40).reverse(),
            empty: t('empty'),
          })
          : h('div', { className: 'knx-empty' }, t('empty')));
    }

    function DiagCard({ t, call, busy, scan, frames }) {
      const [result, setResult] = useState(null);
      const run = () => call('diagnose', { scan: scan ?? [], frames: frames ?? [] }).then(setResult);
      return h('div', { className: 'knx-card' },
        h('h3', null, t('diagTitle')),
        h('div', { className: 'knx-row' },
          h('button', { className: 'knx-btn', disabled: busy, onClick: run }, t('diagnose'))),
        result && result.ok
          ? h('div', { className: 'knx-scroll', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            result.findings.map((finding, index) => h('div', { key: index, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { className: 'knx-row' },
                h('span', { className: `knx-tag ${finding.severity}` }, finding.code),
                h('span', { className: 'knx-sub' }, finding.evidence)),
              h('div', { className: 'knx-note' }, `${t('next')}: ${finding.next}`))))
          : h('div', { className: 'knx-empty' }, t('empty')));
    }

    function Panel({ locale }) {
      const t = locale;
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [pending, setPending] = useState('');
      const [gateway, setGateway] = useState('');
      const [frames, setFrames] = useState([]);
      const [recipeText, setRecipeText] = useState('');
      const [devices, setDevices] = useState(null);
      const mounted = useRef(true);

      const refresh = useCallback(async () => {
        try {
          const next = await api.get('/knx/api/state');
          if (mounted.current) setState(next);
        } catch (failure) {
          if (mounted.current) setError(String(failure.message ?? failure));
        }
      }, []);

      useEffect(() => {
        mounted.current = true;
        refresh();
        const id = setInterval(refresh, 5000);
        return () => { mounted.current = false; clearInterval(id); };
      }, [refresh]);

      const call = useCallback(async (name, args) => {
        setPending(name);
        setError('');
        try {
          const result = await api.op(name, args);
          if (result && result.ok === false && result.error) setError(result.error);
          if (name === 'scan' && result?.devices) setDevices(result.devices);
          await refresh();
          return result;
        } catch (failure) {
          setError(String(failure.message ?? failure));
          return { ok: false, error: String(failure.message ?? failure) };
        } finally {
          if (mounted.current) setPending('');
        }
      }, [refresh]);

      const busy = Boolean(pending);
      const connected = Boolean(state?.connection?.connected);
      const running = Boolean(state?.simulator?.running);

      return h('div', { className: 'knx-panel' },
        h('style', null, css),
        h('div', { className: 'knx-head' },
          h('h2', { className: 'knx-title' }, t('title')),
          h('span', { className: 'knx-sub' }, t('subtitle')),
          h(Pill, { state, t }),
          state?.config?.allowWrites === false ? h('span', { className: 'knx-tag medium' }, t('readOnly')) : null,
          h('span', { style: { marginLeft: 'auto' } }),
          h('label', { className: 'knx-sub' }, t('gateway')),
          h('input', {
            className: 'knx-input', style: { width: 160 }, placeholder: '192.168.1.50:3671',
            value: gateway, onChange: (event) => setGateway(event.target.value),
          }),
          h('button', {
            className: 'knx-btn primary', disabled: busy,
            onClick: () => call('connect', gateway ? { gateway } : {}),
          }, t('connect')),
          h('button', { className: 'knx-btn', disabled: busy || !connected, onClick: () => call('disconnect', {}) }, t('disconnect')),
          h('button', {
            className: 'knx-btn', disabled: busy,
            onClick: () => call('simulator', { action: running ? 'stop' : 'start' }),
          }, running ? t('simulatorStop') : t('simulatorStart'))),
        error ? h('div', { className: 'knx-banner' }, error) : null,
        !connected ? h('div', { className: 'knx-note' }, t('needConnection')) : null,
        h('div', { className: 'knx-grid' },
          h(ScanCard, { t, state, call, busy, key: 'scan' }),
          h(GroupCard, { t, state, call, busy, key: 'group' }),
          h(DownloadCard, { t, state, call, busy, seed: recipeText, key: 'download' }),
          h(LibraryCard, { t, state, call, busy, onRecipe: (recipe) => recipe && setRecipeText(JSON.stringify(recipe, null, 2)), key: 'library' }),
          h(ProxyCard, { t, state, call, busy, onRecipe: (recipe) => recipe && setRecipeText(JSON.stringify(recipe, null, 2)), key: 'proxy' }),
          h(CatalogCard, { t, call, busy, seed: recipeText, onRecipe: (recipe) => recipe && setRecipeText(JSON.stringify(recipe, null, 2)), key: 'catalog' }),
          h(MonitorCard, { t, state, call, busy, onFrames: setFrames, key: 'monitor' }),
          h(DiagCard, { t, call, busy, scan: devices, frames, key: 'diag' })),
        h('div', { className: 'knx-row' },
          h('span', { className: 'knx-sub' },
            state?.connection?.channel !== null && state?.connection?.channel !== undefined
              ? `channel ${state.connection.channel} · rx ${state.connection.stats?.rx ?? 0} · frames ${state.connection.stats?.frames ?? 0} · ack timeouts ${state.connection.stats?.ackTimeouts ?? 0}`
              : '')));
    }

    function NavIcon({ size = 20, active = false }) {
      const stroke = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor';
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': true, style: { display: 'block' },
      },
      h('path', { d: 'M3 7h18', stroke, strokeWidth: 1.6, strokeLinecap: 'round' }),
      h('path', { d: 'M3 17h18', stroke, strokeWidth: 1.6, strokeLinecap: 'round', opacity: 0.55 }),
      h('path', { d: 'M7 7v4M12 7v4M17 7v4', stroke, strokeWidth: 1.6, strokeLinecap: 'round' }),
      h('rect', { x: 5.2, y: 11, width: 3.6, height: 4, rx: 1, fill: stroke }),
      h('rect', { x: 10.2, y: 11, width: 3.6, height: 4, rx: 1, fill: stroke }),
      h('rect', { x: 15.2, y: 11, width: 3.6, height: 4, rx: 1, fill: stroke }),
      h('path', { d: 'M7 17v3M17 17v3', stroke, strokeWidth: 1.4, strokeLinecap: 'round', opacity: 0.5 }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const localeService = ctx.get('locale');
        let t;
        if (localeService && typeof localeService.register === 'function') {
          try {
            localeService.register(NS, 'zh', TEXT.zh);
            localeService.register(NS, 'en', TEXT.en);
            const bound = localeService.bind(NS);
            t = (key) => bound(key);
          } catch (error) {
            console.error('knx-agent locale registration failed', error);
          }
        }
        if (!t) t = (key) => TEXT.zh[key] ?? key;

        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'knx' },
          () => h(Panel, { locale: t }),
        ));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'knx', order: 20, label: () => t('title') },
          NavIcon,
        ));
      },
    };
  },
});
