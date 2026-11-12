/**
 * Skill Pilot 设置页（Settings → 技能领航员）。
 *
 * Host half 暴露 /skill-pilot/{data,skill,plugin,reset-stats}；
 * 这里只负责渲染和调用，不直接碰状态文件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-radar',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const LITE = true;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const SafeSettings = (props) => h(PanelBoundary, null, h(SkillPilotSettings, props));

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: '' };
      }

      static getDerivedStateFromError(error) {
        return { error: String((error && error.message) || error || 'unknown') };
      }

      render() {
        if (this.state.error) {
          return h('div', {
            style: { padding: 20, border: '1px solid #fecaca', borderRadius: 12, background: '#fef2f2', color: '#991b1b', fontSize: 13 },
          },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '技能领航员面板渲染异常'),
            h('div', { style: { marginBottom: 10, whiteSpace: 'pre-wrap' } }, this.state.error),
            h('button', {
              style: { padding: '6px 12px', borderRadius: 8, border: '1px solid #991b1b', background: '#fff', color: '#991b1b', cursor: 'pointer' },
              onClick: () => { try { location.reload(); } catch { /* ignore */ } },
            }, '重新加载'));
        }
        return this.props.children;
      }
    }

    const COLORS = {
      text: '#0f172a',
      sub: '#64748b',
      border: '#e2e8f0',
      layer: '#ffffff',
      base: '#f8fafc',
      brand: '#2563eb',
      ok: '#059669',
      err: '#dc2626',
      idle: '#94a3b8',
    };

    const MODES = [
      { id: 'manual', label: '人工', desc: 'Host 不自动检索、不自动加载；AI 只在明确需要时调用 skill_scout，开关只在本文界面操作。' },
      { id: 'suggest', label: 'AI 建议', desc: '每轮开始自动给 AI 一份 3 条候选雷达（约 60–100 token），不自动加载正文。' },
      { id: 'standard', label: 'AI 自主', desc: '雷达 + 强匹配时自动加载 1 个技能正文（≤4k 字符），AI 可置顶/取消置顶。' },
      { id: 'full', label: '完全自主', desc: '在自主基础上，AI 可自行启用/禁用技能；插件开关需另外勾选允许。' },
    ];

    const S = {
      page: { padding: '24px 28px', maxWidth: 900, color: COLORS.text, fontSize: 13 },
      head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 18, fontWeight: 600 },
      sub: { margin: '4px 0 0', fontSize: 12, color: COLORS.sub, lineHeight: 1.6 },
      card: { border: `1px solid ${COLORS.border}`, borderRadius: 10, background: COLORS.layer, padding: '14px 18px', marginTop: 16 },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 },
      cardTitle: { margin: 0, fontSize: 13, fontWeight: 600 },
      chips: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 },
      chip: (tone) => ({
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 10px', borderRadius: 999,
        fontSize: 11.5, border: `1px solid ${COLORS.border}`, color: tone === 'ok' ? COLORS.ok : COLORS.sub,
      }),
      dot: (tone) => ({ width: 6, height: 6, borderRadius: 999, background: tone === 'ok' ? COLORS.ok : COLORS.idle }),
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      search: {
        flex: '1 1 220px', minWidth: 160, padding: '7px 10px', borderRadius: 8, fontSize: 12.5,
        border: `1px solid ${COLORS.border}`, background: COLORS.base, color: 'inherit', outline: 'none',
      },
      seg: { display: 'inline-flex', border: `1px solid ${COLORS.border}`, borderRadius: 8, overflow: 'hidden' },
      segBtn: (active) => ({
        padding: '6px 11px', fontSize: 12, border: 'none', cursor: 'pointer',
        background: active ? COLORS.brand : 'transparent',
        color: active ? COLORS.base : COLORS.sub,
      }),
      ghost: {
        padding: '6px 12px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
        border: `1px solid ${COLORS.border}`, background: 'transparent', color: 'inherit',
      },
      row: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0', borderTop: `1px solid ${COLORS.border}` },
      rowMain: { flex: 1, minWidth: 0 },
      rowTop: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      name: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, fontWeight: 600 },
      nameBtn: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, fontWeight: 600,
        background: 'none', border: 'none', padding: 0, color: 'inherit', cursor: 'pointer', textAlign: 'left',
      },
      detail: { margin: '0 0 10px 34px', padding: '10px 12px', borderRadius: 8, background: COLORS.base, border: `1px solid ${COLORS.border}` },
      pre: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, lineHeight: 1.55, color: COLORS.sub, maxHeight: 320, overflow: 'auto' },
      host: { padding: 16 },
      modalOverlay: {
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(4, 10, 20, 0.66)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1vh 1.5vw',
      },
      modal: {
        width: 'min(92vw, calc(78vh * 1.5))', maxWidth: 'none', aspectRatio: '3 / 2',
        height: '78vh', overflow: 'auto',
        background: COLORS.base, border: `1px solid ${COLORS.border}`, borderRadius: 12,
        boxShadow: '0 18px 60px rgba(0, 0, 0, 0.45)', padding: 12,
      },
      modalBar: {
        position: 'sticky', top: 0, zIndex: 2, display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: 12, padding: '2px 4px 8px',
        background: COLORS.base, borderBottom: `1px solid ${COLORS.border}`, marginBottom: 8,
      },
      sideNav: {
        position: 'sticky', top: 44, display: 'flex', flexDirection: 'column', gap: 4,
        width: 132, flex: 'none',
      },
      sideBtn: {
        textAlign: 'left', border: `1px solid transparent`, background: 'transparent',
        color: COLORS.sub, fontSize: 11.5, padding: '5px 8px', borderRadius: 7, cursor: 'pointer',
      },
      sourceCard: {
        borderRadius: 8, padding: '7px 9px', marginTop: 6, background: COLORS.base,
        border: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', gap: 4,
      },
      sourceMeta: { fontSize: 10.5, color: COLORS.sub, wordBreak: 'break-all', lineHeight: 1.5 },
      grid: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: 12, marginTop: 10, alignItems: 'start', width: '100%',
      },
      skillCard: {
        border: `1px solid ${COLORS.border}`, borderRadius: 10, background: COLORS.layer,
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
      },
      skillHead: { display: 'flex', alignItems: 'center', gap: 8 },
      badgeRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      cardDesc: {
        margin: 0, fontSize: 12, color: COLORS.sub, lineHeight: 1.55,
        display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      },
      cardMeta: { fontSize: 11, color: COLORS.sub },
      cardFoot: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto' },
      bundleCard: {
        border: `1px solid ${COLORS.border}`, borderRadius: 10, background: COLORS.layer,
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
      },
      bundleName: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, wordBreak: 'break-all' },
      sourceRow: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px',
        border: `1px solid ${COLORS.border}`, borderRadius: 999, fontSize: 11.5,
      },
      priorityInput: {
        width: 42, padding: '1px 4px', borderRadius: 5, border: `1px solid ${COLORS.border}`,
        background: COLORS.base, color: 'inherit', fontSize: 11,
      },
      linkDanger: {
        border: 'none', background: 'transparent', cursor: 'pointer', color: COLORS.err,
        fontSize: 14, lineHeight: 1, padding: 0,
      },
      badge: (tone) => ({
        fontSize: 10.5, padding: '0 6px', borderRadius: 5, border: `1px solid ${COLORS.border}`,
        color: tone === 'ok' ? COLORS.ok : tone === 'brand' ? COLORS.brand : COLORS.sub,
      }),
      desc: {
        margin: '3px 0 0', fontSize: 12, color: COLORS.sub, lineHeight: 1.55,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      },
      meta: { marginTop: 3, fontSize: 11, color: COLORS.sub },
      rowSide: { display: 'flex', alignItems: 'center', gap: 10, flex: 'none' },
      star: (on) => ({
        border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15, lineHeight: 1,
        color: on ? 'var(--dsw-alias-brand-primary)' : COLORS.sub, padding: 2,
      }),
      switchWrap: { position: 'relative', width: 34, height: 20, flex: 'none' },
      switchInput: { position: 'absolute', inset: 0, opacity: 0, margin: 0, cursor: 'pointer' },
      track: (on) => ({
        position: 'absolute', inset: 0, borderRadius: 999, transition: 'background 120ms',
        background: on ? COLORS.brand : COLORS.border, pointerEvents: 'none',
      }),
      knob: (on) => ({
        position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: 999,
        background: '#fff', transition: 'left 120ms', pointerEvents: 'none',
      }),
      empty: { padding: '18px 0', fontSize: 12, color: COLORS.sub, textAlign: 'center' },
      err: { marginTop: 10, fontSize: 12, color: COLORS.err, whiteSpace: 'pre-wrap' },
      hint: { fontSize: 11.5, color: COLORS.sub, lineHeight: 1.6 },
      pluginRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: `1px solid ${COLORS.border}` },
      modeRow: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 0', borderTop: `1px solid ${COLORS.border}`, cursor: 'pointer' },
      radio: { marginTop: 2, accentColor: COLORS.brand },
      modeLabel: { fontSize: 13, fontWeight: 600 },
      modeDesc: { fontSize: 11.5, color: COLORS.sub, lineHeight: 1.55, marginTop: 2 },
      writeRow: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${COLORS.border}` },
      select: {
        marginLeft: 'auto', padding: '5px 8px', borderRadius: 6, fontSize: 12.5,
        border: `1px solid ${COLORS.border}`, background: COLORS.base, color: 'inherit',
      },
      switchRow: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${COLORS.border}` },
      chartWrap: { marginTop: 10 },
      chartSvg: { width: '100%', height: 150, display: 'block' },
      chartBox: { position: 'relative' },
      chartTip: {
        position: 'absolute', top: 4, transform: 'translateX(-50%)', zIndex: 5,
        background: COLORS.layer, border: `1px solid ${COLORS.border}`, borderRadius: 8,
        padding: '6px 8px', fontSize: 11, lineHeight: 1.6, color: 'inherit',
        whiteSpace: 'nowrap', pointerEvents: 'none', boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
      },
      legend: { display: 'flex', gap: 14, fontSize: 11, color: COLORS.sub, marginTop: 4 },
      legendDot: (color) => ({ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block', marginRight: 5 }),
      barRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' },
      barName: { width: 170, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      barTrack: { flex: 1, height: 14, borderRadius: 4, background: COLORS.base, border: `1px solid ${COLORS.border}`, overflow: 'hidden' },
      barFill: (width) => ({ width: `${Math.max(2, width)}%`, height: '100%', background: COLORS.brand, opacity: 0.85 }),
      barCount: { width: 36, textAlign: 'right', fontSize: 11.5, color: COLORS.sub },
      pluginName: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5 },
      details: { marginTop: 10 },
    };

    // —— 产品化视觉覆盖：更接近 Linear / Vercel 的清爽控制台 ——
    Object.assign(COLORS, {
      text: '#0f172a',
      sub: '#64748b',
      border: '#e2e8f0',
      layer: '#ffffff',
      base: '#f8fafc',
      brand: '#2563eb',
      ok: '#059669',
      err: '#dc2626',
      idle: '#94a3b8',
    });
    Object.assign(S, {
      page: { padding: 0, color: COLORS.text, fontSize: 13, lineHeight: 1.5 },
      card: {
        border: `1px solid ${COLORS.border}`, borderRadius: 16, background: COLORS.layer,
        padding: '16px 18px', marginTop: 14, boxShadow: '0 1px 0 rgba(255,255,255,0.03) inset',
      },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 },
      cardTitle: { margin: 0, fontSize: 14, fontWeight: 650, letterSpacing: 0.1 },
      hint: { fontSize: 11.5, color: COLORS.sub, lineHeight: 1.65 },
      ghost: {
        padding: '7px 12px', borderRadius: 10, fontSize: 12, cursor: 'pointer',
        border: `1px solid ${COLORS.border}`, background: 'rgba(255,255,255,0.02)', color: 'inherit',
      },
      primaryBtn: {
        padding: '7px 14px', borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: 'pointer',
        border: `1px solid ${COLORS.brand}`, background: COLORS.brand, color: '#fff',
      },
      dangerBtn: {
        padding: '7px 14px', borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: 'pointer',
        border: '1px solid rgba(255,107,107,0.55)', background: 'rgba(255,107,107,0.14)', color: COLORS.err,
      },
      search: {
        flex: '1 1 220px', minWidth: 160, padding: '9px 11px', borderRadius: 10, fontSize: 12.5,
        border: `1px solid ${COLORS.border}`, background: 'rgba(0,0,0,0.16)', color: 'inherit', outline: 'none',
      },
      chips: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 },
      chip: (tone) => ({
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999,
        fontSize: 11.5, border: `1px solid ${COLORS.border}`, background: 'rgba(255,255,255,0.03)',
        color: tone === 'ok' ? COLORS.ok : COLORS.sub,
      }),
      dot: (tone) => ({ width: 7, height: 7, borderRadius: 999, background: tone === 'ok' ? COLORS.ok : COLORS.idle }),
      title: { margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: -0.2 },
      sub: { margin: '5px 0 0', fontSize: 12, color: COLORS.sub, lineHeight: 1.6 },
      modalOverlay: {
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(4, 8, 16, 0.72)',
        backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1.5vh 1.5vw',
      },
      modal: {
        width: 'min(94vw, calc(82vh * 1.55))', maxWidth: 'none', height: '82vh', overflow: 'hidden',
        background: COLORS.base, border: `1px solid ${COLORS.border}`, borderRadius: 18,
        boxShadow: '0 30px 90px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.03)',
        padding: 0, display: 'flex', flexDirection: 'column',
      },
      modalBar: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '12px 16px', background: 'rgba(15,19,25,0.86)', backdropFilter: 'blur(10px)',
        borderBottom: `1px solid ${COLORS.border}`, cursor: 'move', flex: 'none',
      },
      sideNav: {
        display: 'flex', flexDirection: 'column', gap: 2, width: 178, flex: 'none',
        padding: 8, borderRadius: 14, border: `1px solid ${COLORS.border}`,
        background: 'rgba(255,255,255,0.02)', alignSelf: 'flex-start',
        position: 'sticky', top: 0,
      },
      sideBtn: {
        textAlign: 'left', border: '1px solid transparent', background: 'transparent',
        color: COLORS.sub, fontSize: 12, padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
      },
      grid: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
        gap: 12, marginTop: 10, alignItems: 'start', width: '100%',
      },
      skillCard: {
        border: `1px solid ${COLORS.border}`, borderRadius: 14, background: 'rgba(255,255,255,0.02)',
        padding: '13px 14px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
      },
      bundleCard: {
        border: `1px solid ${COLORS.border}`, borderRadius: 14, background: 'rgba(255,255,255,0.02)',
        padding: '13px 14px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
      },
      sourceCard: {
        borderRadius: 12, padding: '10px 12px', marginTop: 8, background: 'rgba(255,255,255,0.02)',
        border: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', gap: 5,
      },
      star: (on) => ({
        border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15, lineHeight: 1,
        color: on ? COLORS.brand : COLORS.sub, padding: 2,
      }),
      row: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0', borderTop: `1px solid ${COLORS.border}` },
      empty: { padding: '20px 0', fontSize: 12, color: COLORS.sub, textAlign: 'center' },
      // 新增：控制台组件
      hero: {
        position: 'relative', overflow: 'hidden', border: `1px solid ${COLORS.border}`,
        borderRadius: 18, padding: '18px 20px',
        background: 'linear-gradient(135deg, rgba(79,140,255,0.16), rgba(139,92,246,0.10) 55%, rgba(255,255,255,0.02) 100%)',
      },
      heroRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' },
      heroTitle: { margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: -0.2 },
      heroSub: { margin: '5px 0 0', fontSize: 12, color: COLORS.sub, lineHeight: 1.6, maxWidth: 620 },
      metricGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 10, marginTop: 16 },
      metric: {
        border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: '10px 12px',
        background: 'rgba(0,0,0,0.14)', display: 'flex', flexDirection: 'column', gap: 3,
      },
      metricValue: { fontSize: 20, fontWeight: 700, letterSpacing: -0.3 },
      metricLabel: { fontSize: 10.5, color: COLORS.sub },
      statusPill: (on) => ({
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999,
        fontSize: 11, fontWeight: 600,
        color: on ? COLORS.err : COLORS.ok,
        border: `1px solid ${on ? 'rgba(255,107,107,0.4)' : 'rgba(62,207,142,0.35)'}`,
        background: on ? 'rgba(255,107,107,0.10)' : 'rgba(62,207,142,0.08)',
      }),
      sectionLabel: { margin: '2px 0 6px', fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: COLORS.sub },
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      textarea: {
        width: '100%', minHeight: 110, resize: 'vertical', padding: '10px 12px', borderRadius: 10,
        border: `1px solid ${COLORS.border}`, background: 'rgba(0,0,0,0.16)', color: 'inherit',
        fontSize: 12, lineHeight: 1.55, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', outline: 'none',
      },
      codeBox: {
        margin: '8px 0 0', padding: '10px 12px', borderRadius: 10, border: `1px solid ${COLORS.border}`,
        background: 'rgba(0,0,0,0.20)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontSize: 11, lineHeight: 1.55, color: COLORS.sub, maxHeight: 220, overflow: 'auto',
      },
      split: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 8 },
    });

    // —— 浅色未来感：固定弹窗、玻璃卡片、清爽高对比 ——
    Object.assign(S, {
      host: { padding: 16, color: COLORS.text },
      modalOverlay: {
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'color-mix(in srgb, #0b1220 34%, transparent)',
        backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '2vh 2vw',
      },
      modal: {
        width: 'min(1180px, 94vw)', maxWidth: 'none', height: '84vh', overflow: 'hidden',
        background: COLORS.base, border: `1px solid ${COLORS.border}`, borderRadius: 20,
        boxShadow: '0 24px 80px rgba(15, 23, 42, 0.18), 0 2px 10px rgba(15, 23, 42, 0.08)',
        padding: 0, display: 'flex', flexDirection: 'column',
      },
      modalBar: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14,
        padding: '14px 18px', background: COLORS.layer, borderBottom: `1px solid ${COLORS.border}`,
        flex: 'none',
      },
      modalContent: {
        display: 'flex', gap: 18, alignItems: 'flex-start', flex: '1 1 auto',
        minHeight: 0, overflow: 'auto', padding: 18,
      },
      hero: {
        position: 'relative', overflow: 'hidden', border: `1px solid ${COLORS.border}`,
        borderRadius: 20, padding: '20px 22px',
        background: 'linear-gradient(135deg, rgba(79,140,255,0.16), rgba(168,85,247,0.11) 52%, rgba(34,211,238,0.12) 100%)',
      },
      metric: {
        border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: '12px 14px',
        background: 'color-mix(in srgb, ' + COLORS.layer + ' 76%, transparent)',
        display: 'flex', flexDirection: 'column', gap: 3,
      },
      chip: (tone) => ({
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999,
        fontSize: 11.5, border: `1px solid ${COLORS.border}`,
        background: `color-mix(in srgb, ${COLORS.brand} 7%, ${COLORS.layer})`,
        color: tone === 'ok' ? COLORS.ok : tone === 'brand' ? COLORS.brand : COLORS.sub,
      }),
      sideNav: {
        display: 'flex', flexDirection: 'column', gap: 2, width: 180, flex: 'none',
        padding: 10, borderRadius: 16, border: `1px solid ${COLORS.border}`,
        background: `color-mix(in srgb, ${COLORS.layer} 88%, transparent)`,
        alignSelf: 'flex-start', position: 'sticky', top: 0,
      },
      skillCard: {
        border: `1px solid ${COLORS.border}`, borderRadius: 16, background: COLORS.base,
        padding: '14px 15px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
      },
      bundleCard: {
        border: `1px solid ${COLORS.border}`, borderRadius: 16, background: COLORS.base,
        padding: '14px 15px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
      },
      sourceCard: {
        borderRadius: 14, padding: '11px 13px', marginTop: 8, background: COLORS.base,
        border: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', gap: 5,
      },
      ghost: {
        padding: '8px 13px', borderRadius: 10, fontSize: 12, cursor: 'pointer',
        border: `1px solid ${COLORS.border}`, background: COLORS.base, color: 'inherit',
      },
      search: {
        flex: '1 1 220px', minWidth: 160, padding: '9px 12px', borderRadius: 11, fontSize: 12.5,
        border: `1px solid ${COLORS.border}`, background: COLORS.base, color: 'inherit', outline: 'none',
      },
      textarea: {
        width: '100%', minHeight: 120, resize: 'vertical', padding: '11px 13px', borderRadius: 12,
        border: `1px solid ${COLORS.border}`, background: COLORS.base, color: 'inherit',
        fontSize: 12, lineHeight: 1.55, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', outline: 'none',
      },
      codeBox: {
        margin: '8px 0 0', padding: '11px 13px', borderRadius: 12, border: `1px solid ${COLORS.border}`,
        background: COLORS.base, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontSize: 11, lineHeight: 1.55, color: COLORS.sub, maxHeight: 240, overflow: 'auto',
      },
    });

    function relTime(ts) {
      if (!ts) return '未用过';
      const minutes = Math.round((Date.now() - ts) / 60000);
      if (minutes < 1) return '刚刚';
      if (minutes < 60) return `${minutes} 分钟前`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours} 小时前`;
      return `${Math.round(hours / 24)} 天前`;
    }

    function Switch({ checked, onChange, label }) {
      return h('span', { style: S.switchWrap, role: 'switch', 'aria-checked': checked, 'aria-label': label },
        h('input', {
          style: S.switchInput, type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { style: S.track(checked) }),
        h('span', { style: S.knob(checked) }),
      );
    }

    function SkillRow({ skill, busy, selected, onSelect, onToggle, onPin, onDetail, detail }) {
      return h('div', { style: S.skillCard },
        h('div', { style: S.skillHead },
          h('input', {
            type: 'checkbox', style: S.radio, checked: selected === true,
            onChange: () => onSelect(skill.name), 'aria-label': `选择 ${skill.name}`,
          }),
          h('button', { style: S.nameBtn, onClick: () => onDetail(skill.name), title: '查看技能正文' }, '`' + skill.name + '`'),
        ),
        h('div', { style: S.badgeRow },
          skill.pin ? h('span', { style: S.badge('brand') }, '置顶') : null,
          h('span', { style: S.badge(skill.enabled ? 'ok' : '') }, skill.enabled ? '开启' : '关闭'),
          h('span', { style: S.badge('') }, skill.source || 'unknown'),
        ),
        h('p', { style: S.cardDesc }, skill.whenToUse || skill.description || '（无描述）'),
        h('div', { style: S.cardMeta }, `加载 ${skill.count} 次 · ${relTime(skill.last)}`),
        h('div', { style: S.cardFoot },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
            h(Switch, {
              checked: skill.enabled, label: `${skill.name} 开关`, onChange: (next) => onToggle(skill, next),
            }),
            h('span', { style: { fontSize: 11.5, color: COLORS.sub } }, skill.enabled ? '已开启' : '已关闭'),
          ),
          h('button', {
            style: S.star(skill.pin), title: skill.pin ? '取消置顶' : '置顶（检索加权）',
            disabled: busy, onClick: () => onPin(skill, !skill.pin),
          }, skill.pin ? '★' : '☆'),
          h('button', { style: S.ghost, onClick: () => onDetail(skill.name) }, '详情'),
        ),
        detail
          ? h('div', { style: S.detail },
              detail.loading
                ? '读取中…'
                : detail.error
                  ? h('span', { style: S.err }, detail.error)
                  : h('pre', { style: S.pre }, detail.content || '（空）'))
          : null,
      );
    }

    function SkillPilotSettings({ onClose } = {}) {
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [query, setQuery] = useState('');
      const [filter, setFilter] = useState('all');
      const [busyName, setBusyName] = useState('');
      const [modeBusy, setModeBusy] = useState(false);
      const [range, setRange] = useState('7d');
      const [usage, setUsage] = useState(null);
      const [usageBusy, setUsageBusy] = useState(false);
      const [selected, setSelected] = useState([]);
      const [detail, setDetail] = useState({});
      const [bulkBusy, setBulkBusy] = useState(false);
      const [ioBusy, setIoBusy] = useState(false);
      const [groupName, setGroupName] = useState('');
      const [groupBusy, setGroupBusy] = useState(false);
      const [onlineQuery, setOnlineQuery] = useState('');
      const [onlineResults, setOnlineResults] = useState(null);
      const [onlineBusy, setOnlineBusy] = useState(false);
      const [sourceForm, setSourceForm] = useState(null);
      const [sourceTokenRevealed, setSourceTokenRevealed] = useState(false);
      const [quickQuery, setQuickQuery] = useState('');
      const [quickResult, setQuickResult] = useState(null);
      const [quickBusy, setQuickBusy] = useState(false);
      const [categoryFilter, setCategoryFilter] = useState('all');
      const [customCategory, setCustomCategory] = useState('');
      const [searchTab, setSearchTab] = useState('skills');
      const [localSkills, setLocalSkills] = useState(null);
      const [localBusy, setLocalBusy] = useState(false);
      const [customRoot, setCustomRoot] = useState('');
      const [editingDir, setEditingDir] = useState(-1);
      const [editingDirValue, setEditingDirValue] = useState('');
      const [nativeBusy, setNativeBusy] = useState(false);
      const [discoverBusy, setDiscoverBusy] = useState(false);
      const [discoverCandidates, setDiscoverCandidates] = useState([]);
      const [discoverSelected, setDiscoverSelected] = useState([]);
      const [discoverRoot, setDiscoverRoot] = useState('');
      const [activeSection, setActiveSection] = useState('sec-status');
      const [resourcePath, setResourcePath] = useState('');
      const [resourcePlan, setResourcePlan] = useState(null);
      const [resourceAck, setResourceAck] = useState(false);
      const [metrics, setMetrics] = useState(null);
      const [benchmarkReport, setBenchmarkReport] = useState(null);
      const [mcpReport, setMcpReport] = useState(null);
      const [updatesReport, setUpdatesReport] = useState(null);
      const [taskReport, setTaskReport] = useState(null);
      const [abReport, setAbReport] = useState(null);
      const [teamPolicyText, setTeamPolicyText] = useState('');
      const [teamInfo, setTeamInfo] = useState(null);
      const [platformReport, setPlatformReport] = useState(null);
      const [marketReport, setMarketReport] = useState(null);
      const [alerts, setAlerts] = useState(null);
      const [backups, setBackups] = useState(null);
      const [perfReport, setPerfReport] = useState(null);
      const [narrow, setNarrow] = useState(false);
      const [activeGroup, setActiveGroup] = useState('运行');
      const [onboardDismissed, setOnboardDismissed] = useState(() => {
        try { return typeof localStorage !== 'undefined' && localStorage.getItem('skill-pilot-onboard') === '1'; } catch { return false; }
      });
      const contentRef = useRef(null);
      const addedDirs = (data && data.settings && Array.isArray(data.settings.extraSkillDirs))
        ? data.settings.extraSkillDirs : [];
      const defaultDirs = (data && Array.isArray(data.defaultDirs)) ? data.defaultDirs : [];
      const primaryDir = (data && data.settings && data.settings.primarySkillDir) || '';
      const allDirs = (() => {
        const seen = new Set();
        const rows = [];
        for (const dir of defaultDirs) {
          const key = String(dir.path).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ ...dir, isDefault: true, primary: primaryDir ? dir.path === primaryDir : dir.primary });
        }
        for (const dir of addedDirs) {
          const key = String(dir).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ path: dir, platform: '自定义', exists: true, isDefault: false, primary: primaryDir === dir });
        }
        return rows;
      })();
      const disabledDirs = (data && data.settings && Array.isArray(data.settings.disabledSkillDirs))
        ? data.settings.disabledSkillDirs : [];
      const [proQuery, setProQuery] = useState('');
      const [proResults, setProResults] = useState(null);
      const [proRoute, setProRoute] = useState(null);
      const [proBusy, setProBusy] = useState(false);
      const [dragSource, setDragSource] = useState(-1);
      const [dragPro, setDragPro] = useState(-1);
      const [dragOver, setDragOver] = useState('');
      const [secretValue, setSecretValue] = useState('');
      const [secretRevealed, setSecretRevealed] = useState(false);
      const [secretBusy, setSecretBusy] = useState(false);
      const [secretStatus, setSecretStatus] = useState('');
      const [secretEditing, setSecretEditing] = useState('');
      const [secretList, setSecretList] = useState([]);
      const [registryRepo, setRegistryRepo] = useState('');
      const [registryBusy, setRegistryBusy] = useState(false);
      const [scanResults, setScanResults] = useState({});
      const [scanBusy, setScanBusy] = useState('');
      const [installBusy, setInstallBusy] = useState('');
      const [notice, setNotice] = useState('');
      const [panelOpen, setPanelOpen] = useState(true);
      const [healthBusy, setHealthBusy] = useState(false);
      const [healthReport, setHealthReport] = useState(null);
      const [hoverIndex, setHoverIndex] = useState(null);
      const [controlBusy, setControlBusy] = useState(false);
      const [maintenanceReport, setMaintenanceReport] = useState(null);
      const [convertText, setConvertText] = useState('');
      const [convertTarget, setConvertTarget] = useState('skill-md');
      const [convertResult, setConvertResult] = useState(null);
      const [improveReport, setImproveReport] = useState(null);

      const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          const res = await fetch('/skill-pilot/data', { cache: 'no-store' });
          const json = await res.json();
          if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
          setData(json);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const loadUsage = useCallback(async (nextRange) => {
        setUsageBusy(true);
        try {
          const res = await fetch(`/skill-pilot/usage?range=${nextRange}`, { cache: 'no-store' });
          const json = await res.json();
          if (res.ok && json.ok) setUsage(json);
        } catch {
          /* charts are optional */
        } finally {
          setUsageBusy(false);
        }
      }, []);
      useEffect(() => { loadUsage(range); }, [range, loadUsage]);

      const post = useCallback(async (path, body) => {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        });
        const json = await res.json();
        if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
        return json;
      }, []);

      const toggleSkill = useCallback(async (skill, enabled) => {
        setBusyName(skill.name);
        setError('');
        try {
          setData(await post('/skill-pilot/skill', { name: skill.name, enabled }));
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusyName('');
        }
      }, [post]);

      const pinSkill = useCallback(async (skill, pin) => {
        setBusyName(skill.name);
        setError('');
        try {
          setData(await post('/skill-pilot/skill', { name: skill.name, pin }));
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusyName('');
        }
      }, [post]);

      const toggleBundle = useCallback(async (bundle) => {
        setBusyName(`bundle:${bundle.name}`);
        setError('');
        try {
          const json = await post('/skill-pilot/plugin', { name: bundle.name, enabled: !bundle.enabled });
          if (json.snapshot) setData(json.snapshot);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusyName('');
        }
      }, [post]);

      const saveSettings = useCallback(async (patch) => {
        setModeBusy(true);
        setError('');
        try {
          setData(await post('/skill-pilot/settings', patch));
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setModeBusy(false);
        }
      }, [post]);

      const toggleSelect = useCallback((name) => {
        setSelected((prev) => (prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]));
      }, []);

      const bulk = useCallback(async (patch) => {
        if (!selected.length) return;
        setBulkBusy(true);
        setError('');
        try {
          setData(await post('/skill-pilot/bulk', { names: selected, ...patch }));
          setSelected([]);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBulkBusy(false);
        }
      }, [post, selected]);

      const loadDetail = useCallback(async (name) => {
        setDetail((prev) => {
          if (prev[name] && !prev[name].error) return { ...prev, [name]: null };
          return { ...prev, [name]: { loading: true } };
        });
        try {
          const res = await fetch(`/skill-pilot/skill/detail?name=${encodeURIComponent(name)}`, { cache: 'no-store' });
          const json = await res.json();
          if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
          setDetail((prev) => ({ ...prev, [name]: { content: json.content, meta: json } }));
        } catch (err) {
          setDetail((prev) => ({ ...prev, [name]: { error: String((err && err.message) || err) } }));
        }
      }, []);

      const exportConfig = useCallback(async () => {
        setIoBusy(true);
        try {
          const res = await fetch('/skill-pilot/export', { cache: 'no-store' });
          const json = await res.json();
          if (typeof document === 'undefined') return;
          const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = 'skill-pilot-export.json';
          anchor.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setIoBusy(false);
        }
      }, []);

      const importConfig = useCallback(async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        setIoBusy(true);
        setError('');
        try {
          const text = await file.text();
          const json = JSON.parse(text);
          setData(await post('/skill-pilot/import', json));
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setIoBusy(false);
          event.target.value = '';
        }
      }, [post]);

      const groupAction = useCallback(async (payload) => {
        setGroupBusy(true);
        setError('');
        try {
          setData(await post('/skill-pilot/groups', payload));
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setGroupBusy(false);
        }
      }, [post]);

      const saveGroup = useCallback(async () => {
        if (!groupName.trim() || selected.length === 0) return;
        await groupAction({ action: 'save', name: groupName.trim(), members: selected });
        setGroupName('');
      }, [groupName, selected, groupAction]);

      const searchOnline = useCallback(async () => {
        const keyword = onlineQuery.trim();
        if (!keyword) return;
        setOnlineBusy(true);
        setError('');
        try {
          const res = await fetch(`/skill-pilot/online?q=${encodeURIComponent(keyword)}&limit=6`, { cache: 'no-store' });
          const json = await res.json();
          if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
          setOnlineResults(json.results || []);
        } catch (err) {
          setError(String((err && err.message) || err));
          setOnlineResults([]);
        } finally {
          setOnlineBusy(false);
        }
      }, [onlineQuery]);

      const indexRegistry = useCallback(async () => {
        const repo = registryRepo.trim();
        if (!repo) return;
        setRegistryBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/registry', { action: 'index', repo });
          if (!json.ok) throw new Error(json.error || 'index failed');
          setRegistryRepo('');
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setRegistryBusy(false);
        }
      }, [registryRepo, post, load]);

      const scanOnline = useCallback(async (item) => {
        const repo = item.repo;
        if (!repo) return;
        setScanBusy(repo);
        setError('');
        try {
          const json = await post('/skill-pilot/security/scan', { repo, path: item.path || '' });
          if (!json.ok) throw new Error(json.error || 'scan failed');
          setScanResults((prev) => ({ ...prev, [repo]: json.result }));
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setScanBusy('');
        }
      }, [post]);

      const installOnline = useCallback(async (item) => {
        if (!item.repo) return;
        setInstallBusy(item.repo);
        setError('');
        setNotice('');
        try {
          let json = await post('/skill-pilot/install', { repo: item.repo, path: item.path || '' });
          if (json.blocked === 'medium' && window.confirm(`安全预检风险 medium（${json.scan ? json.scan.score : '?'} 分）。仍要安装吗？`)) {
            json = await post('/skill-pilot/install', { repo: item.repo, path: item.path || '', confirm: true });
          } else if (json.blocked === 'high' && window.confirm(`安全预检风险 HIGH（${json.scan ? json.scan.score : '?'} 分），可能包含危险命令。仍要安装？`)) {
            json = await post('/skill-pilot/install', { repo: item.repo, path: item.path || '', force: true });
          } else if (json.blocked === 'exists' && window.confirm(`技能 ${json.name} 已存在，覆盖安装？`)) {
            json = await post('/skill-pilot/install', { repo: item.repo, path: item.path || '', overwrite: true });
          }
          if (!json.ok) throw new Error(json.error || json.blocked || 'install failed');
          setNotice(`已安装 ${json.name} → ${json.dir}${json.risk ? `（预检 ${json.risk}）` : ''}`);
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setInstallBusy('');
        }
      }, [post, load]);

      const rollbackInstalled = useCallback(async (name) => {
        if (!window.confirm(`回滚已安装技能 ${name}？`)) return;
        setInstallBusy(name);
        setError('');
        try {
          const json = await post('/skill-pilot/install/rollback', { name });
          if (!json.ok) throw new Error(json.error || 'rollback failed');
          setNotice(`已回滚 ${name}（${json.restored ? '恢复备份' : '删除'}）`);
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setInstallBusy('');
        }
      }, [post, load]);

      const indexSearchResults = useCallback(async () => {
        const repos = [...new Set((onlineResults || []).map((item) => item.repo).filter(Boolean))].slice(0, 3);
        if (!repos.length) return;
        setRegistryBusy(true);
        setError('');
        try {
          let indexed = 0;
          for (const repo of repos) {
            const json = await post('/skill-pilot/registry', { action: 'index', repo });
            if (json.ok) indexed += json.indexed || 0;
          }
          setNotice(`已索引 ${indexed} 个技能条目`);
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setRegistryBusy(false);
        }
      }, [onlineResults, post, load]);

      const undoAction = useCallback(async () => {
        setError('');
        setNotice('');
        try {
          const json = await post('/skill-pilot/action/undo', {});
          if (!json.ok) throw new Error(json.error || 'undo failed');
          setNotice(json.text || '已撤销上一步');
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, [post, load]);

      const crawlRegistry = useCallback(async () => {
        setRegistryBusy(true);
        setError('');
        setNotice('');
        try {
          const json = await post('/skill-pilot/registry/crawl', { limitRepos: 3 });
          if (!json.ok) throw new Error(json.error || 'crawl failed');
          setNotice(`已爬取 ${json.repos.length} 个仓库；索引总计 ${json.total} 条`);
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setRegistryBusy(false);
        }
      }, [post, load]);

      const runResearchRoute = useCallback(async () => {
        const keyword = proQuery.trim();
        if (!keyword) return;
        setProBusy(true);
        setError('');
        try {
          const response = await fetch(`/skill-pilot/research/route?q=${encodeURIComponent(keyword)}`, { cache: 'no-store' });
          const json = await response.json();
          if (!json.ok) throw new Error(json.error || 'route failed');
          setProRoute(json);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setProBusy(false);
        }
      }, [proQuery]);

      const runProSearch = useCallback(async () => {
        const keyword = proQuery.trim();
        if (!keyword) return;
        setProBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/pro/search', { query: keyword, limit: 6 });
          if (!json.ok) throw new Error(json.error || 'pro search failed');
          setProResults(json.results || []);
          if (json.cached) setNotice('知识缓存命中（未请求网络）');
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setProBusy(false);
        }
      }, [proQuery, post]);

      const crawlSkillsSh = useCallback(async () => {
        setRegistryBusy(true);
        setError('');
        setNotice('');
        try {
          const json = await post('/skill-pilot/registry/skills-sh', { limit: 2000, enrich: 20 });
          if (!json.ok) throw new Error(json.error || 'skills.sh crawl failed');
          setNotice(`skills.sh 索引完成：新增 ${json.indexed} 条，总计 ${json.total} 条`);
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setRegistryBusy(false);
        }
      }, [post, load]);

      const loadSecrets = useCallback(async () => {
        try {
          const response = await fetch('/skill-pilot/secrets', { cache: 'no-store' });
          const json = await response.json();
          if (json.ok) setSecretList(json.entries || []);
        } catch { /* credentials are optional */ }
      }, []);

      useEffect(() => { loadSecrets(); }, [loadSecrets]);

      const openSecret = useCallback(async (secretName) => {
        setSecretEditing(secretName);
        setSecretValue('');
        setSecretRevealed(false);
        setSecretStatus('');
        try {
          const response = await fetch('/skill-pilot/secrets/reveal', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: secretName }),
          });
          const json = await response.json();
          if (json.ok && json.value) {
            setSecretValue(json.value);
            setSecretStatus('已加载；点 👁 显示/隐藏');
          } else {
            setSecretStatus('未配置，粘贴后保存');
          }
        } catch {
          setSecretStatus('读取失败，可直接粘贴保存');
        }
      }, []);

      const toggleSecret = useCallback(async () => {
        if (secretValue) {
          setSecretRevealed(!secretRevealed);
          return;
        }
        setSecretBusy(true);
        setSecretStatus('');
        try {
          const response = await fetch('/skill-pilot/secrets/reveal', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: secretEditing }),
          });
          const json = await response.json();
          if (!json.ok) throw new Error(json.error || '未配置');
          setSecretValue(json.value || '');
          setSecretRevealed(true);
        } catch (err) {
          setSecretStatus(String((err && err.message) || err));
        } finally {
          setSecretBusy(false);
        }
      }, [secretValue, secretRevealed, secretEditing]);

      const saveSecret = useCallback(async () => {
        if (!secretEditing) return;
        setSecretBusy(true);
        setSecretStatus('');
        try {
          const json = await post('/skill-pilot/secrets', { name: secretEditing, value: secretValue });
          if (!json.ok) throw new Error(json.error || 'save failed');
          setSecretStatus(json.saved ? '已加密保存' : '已清除');
          setSecretRevealed(false);
          setSecretValue('');
          await loadSecrets();
        } catch (err) {
          setSecretStatus(String((err && err.message) || err));
        } finally {
          setSecretBusy(false);
        }
      }, [secretEditing, secretValue, post, loadSecrets]);

      const clearSecret = useCallback(async () => {
        if (!secretEditing) return;
        setSecretBusy(true);
        setSecretStatus('');
        try {
          const json = await post('/skill-pilot/secrets', { name: secretEditing, value: '' });
          if (!json.ok) throw new Error(json.error || 'clear failed');
          setSecretValue('');
          setSecretRevealed(false);
          setSecretStatus('已清除');
          await loadSecrets();
        } catch (err) {
          setSecretStatus(String((err && err.message) || err));
        } finally {
          setSecretBusy(false);
        }
      }, [secretEditing, post, loadSecrets]);

      const testSecret = useCallback(async () => {
        if (!secretEditing) return;
        setSecretBusy(true);
        setSecretStatus('');
        try {
          const json = await post('/skill-pilot/secrets/test', { name: secretEditing });
          if (!json.ok) throw new Error(json.error || 'test failed');
          setSecretStatus(json.login ? `连接成功：${json.login}` : '连接成功');
        } catch (err) {
          setSecretStatus(String((err && err.message) || err));
        } finally {
          setSecretBusy(false);
        }
      }, [secretEditing, post]);

      const secretEditor = (secretName) => (secretEditing === secretName
        ? h('div', { style: { ...S.toolbar, marginTop: 6, paddingTop: 6, borderTop: `1px dashed ${COLORS.border}` } },
            h('input', {
              type: secretRevealed ? 'text' : 'password',
              style: { ...S.search, maxWidth: 300 },
              value: secretValue,
              placeholder: '粘贴 token（可留空）',
              onChange: (event) => setSecretValue(event.target.value),
            }),
            h('button', { style: S.ghost, disabled: secretBusy, onClick: toggleSecret },
              secretRevealed ? '🙈 隐藏' : '👁 显示'),
            h('button', { style: S.ghost, disabled: secretBusy, onClick: saveSecret }, '加密保存'),
            secretName === 'github' ? h('button', { style: S.ghost, disabled: secretBusy, onClick: testSecret }, '测试') : null,
            h('button', { style: S.ghost, disabled: secretBusy, onClick: clearSecret }, '清除'),
            h('button', { style: S.ghost, onClick: () => setSecretEditing('') }, '关闭'),
            h('span', { style: { fontSize: 10.5, color: COLORS.sub } }, secretStatus || ''))
        : null);

      const clearCache = useCallback(async () => {
        try {
          await post('/skill-pilot/cache/clear', {});
          setNotice('知识缓存已清空');
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, [post, load]);

      const [interopBusy, setInteropBusy] = useState(false);
      const [interopReport, setInteropReport] = useState(null);

      const runInteropScan = useCallback(async () => {
        setInteropBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/interop/scan', {});
          if (!json.ok) throw new Error(json.error || 'scan failed');
          setInteropReport(json);
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setInteropBusy(false);
        }
      }, [post, load]);

      const runDiagnose = useCallback(async () => {
        setHealthBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/diagnose', { limit: 40 });
          if (!json.ok) throw new Error(json.error || 'diagnose failed');
          setHealthReport(json.report);
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setHealthBusy(false);
        }
      }, [post, load]);

      const saveSources = useCallback(async (sources) => {
        await saveSettings({ onlineSources: sources });
      }, [saveSettings]);

      const currentSources = useCallback(
        () => (data && data.settings && Array.isArray(data.settings.onlineSources) ? data.settings.onlineSources : []),
        [data],
      );

      const updateSource = useCallback(async (name, patch) => {
        const sources = currentSources().map((source) => (source.name === name ? { ...source, ...patch } : source));
        await saveSources(sources);
      }, [currentSources, saveSources]);

      const removeSource = useCallback(async (name) => {
        await saveSources(currentSources().filter((source) => source.name !== name));
      }, [currentSources, saveSources]);

      const reorderSources = useCallback(async (from, to) => {
        const list = [...currentSources()];
        if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return;
        const [moved] = list.splice(from, 1);
        list.splice(to, 0, moved);
        const next = list.map((source, index) => ({ ...source, priority: (list.length - index) * 10 }));
        await saveSources(next);
      }, [currentSources, saveSources]);

      const enrichRegistry = useCallback(async () => {
        setRegistryBusy(true);
        setError('');
        setNotice('');
        try {
          const json = await post('/skill-pilot/registry/enrich', { limit: 20 });
          if (!json.ok) throw new Error(json.error || 'enrich failed');
          setNotice(`已补全 ${json.enriched} 条描述（候选 ${json.total} 条）`);
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setRegistryBusy(false);
        }
      }, [post, load]);

      const submitSource = useCallback(async () => {
        if (!sourceForm) return;
        const name = sourceForm.name.trim().slice(0, 40);
        const url = sourceForm.url.trim();
        if (!name || !/^https?:\/\//i.test(url)) {
          setError('来源名称和 http(s) URL 都必填');
          return;
        }
        const sources = [...currentSources(), {
          name,
          kind: 'web',
          url,
          enabled: true,
          priority: Number(sourceForm.priority) || 5,
        }];
        await saveSources(sources);
        if (sourceForm.token && sourceForm.token.trim()) {
          await post('/skill-pilot/secrets', { name: `source:${name}`, value: sourceForm.token.trim() });
          await loadSecrets();
        }
        setSourceForm(null);
        setError('');
      }, [sourceForm, currentSources, saveSources, post, loadSecrets]);

      const rollbackPlugin = useCallback(async () => {        setIoBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/plugin/rollback', {});
          if (json.snapshot) setData(json.snapshot);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setIoBusy(false);
        }
      }, [post]);

      const resetStats = useCallback(async () => {        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm('清空所有技能加载统计？开关和置顶不受影响。')) return;
        setBusyName('reset');
        setError('');
        try {
          setData(await post('/skill-pilot/reset-stats', {}));
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusyName('');
        }
      }, [post]);

      const skills = data ? data.skills : [];
      const filtered = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        return skills.filter((skill) => {
          if (filter === 'on' && !skill.enabled) return false;
          if (filter === 'off' && skill.enabled) return false;
          if (filter === 'pin' && !skill.pin) return false;
          if (!keyword) return true;
          const haystack = `${skill.name} ${skill.description} ${skill.whenToUse} ${skill.source}`.toLowerCase();
          return haystack.includes(keyword);
        });
      }, [skills, query, filter]);

      const filteredGroups = useMemo(() => {
        const visible = new Set(filtered.map((skill) => skill.name));
        const groups = (data && data.categories) || [];
        return groups.map((group) => ({
          ...group,
          skills: (group.skills || []).filter((name) => visible.has(name)),
        })).filter((group) => group.skills.length && (categoryFilter === 'all' || group.key === categoryFilter));
      }, [data, filtered, categoryFilter]);
      const skillByName = useMemo(() => new Map(filtered.map((skill) => [skill.name, skill])), [filtered]);
      const bundleGroups = useMemo(() => {
        const labels = { core: '核心运行时', experimental: '实验功能', local: '本地 / 第三方', other: '其他' };
        const groups = new Map();
        for (const bundle of (data && data.bundles) || []) {
          const text = `${bundle.name} ${bundle.title || ''}`.toLowerCase();
          const key = /dsh-base|web-app|agent|session|model/.test(text) ? 'core'
            : /experimental/.test(text) ? 'experimental'
              : /local|@local|mascot|voice|memory/.test(text) ? 'local' : 'other';
          if (!groups.has(key)) groups.set(key, { key, label: labels[key], bundles: [] });
          groups.get(key).bundles.push(bundle);
        }
        return [...groups.values()];
      }, [data]);

      const counts = data ? data.counts : { total: 0, enabled: 0, pinned: 0, loads: 0 };
      const settings = data && data.settings
        ? data.settings
        : { autonomy: 'standard', allowPluginControl: false };
      const activeMode = MODES.find((mode) => mode.id === settings.autonomy) || MODES[2];

      const togglePause = useCallback(async () => {
        setControlBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/pause', { paused: !(settings.paused === true) });
          if (!json.ok) throw new Error(json.error || 'pause failed');
          setNotice(json.paused ? '已暂停所有自动动作（手动检索仍可用）' : '已恢复自动动作');
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setControlBusy(false);
        }
      }, [settings.paused, post, load]);

      const runMaintenance = useCallback(async (apply) => {
        setControlBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/maintenance/scan', { apply: apply === true });
          if (!json.ok) throw new Error(json.error || 'maintenance failed');
          setMaintenanceReport(json);
          setNotice(apply ? `维护完成：修复 ${json.repaired}，禁用 ${json.disabled}` : `扫描完成：${json.checked} 个，异常 ${json.broken}`);
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setControlBusy(false);
        }
      }, [post, load]);

      const runConvert = useCallback(async () => {
        setControlBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/convert', { content: convertText, target: convertTarget });
          if (!json.ok) throw new Error(json.error || 'convert failed');
          setConvertResult(json);
          setNotice(`转换完成：${json.sourceFormat || 'skill-md'} → ${json.target || convertTarget}`);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setControlBusy(false);
        }
      }, [convertText, post]);

      const runImprove = useCallback(async () => {
        setControlBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/self-improve', { apply: false });
          if (!json.ok) throw new Error(json.error || 'self-improve failed');
          setImproveReport(json);
          setNotice('自改进分析完成');
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setControlBusy(false);
        }
      }, [post]);

      const runQuick = useCallback(async () => {        setQuickBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/scout', { query: quickQuery, limit: 5 });
          if (!json.ok) throw new Error(json.error || 'scout failed');
          setQuickResult(json);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setQuickBusy(false);
        }
      }, [quickQuery, post]);

      const applyCategory = useCallback(async () => {
        if (!customCategory.trim() || !selected.length) return;
        try {
          const json = await post('/skill-pilot/categories', { names: selected, category: customCategory.trim() });
          if (!json.ok) throw new Error(json.error || 'category failed');
          setNotice(`已把 ${selected.length} 个技能归入「${customCategory.trim()}」`);
          setCustomCategory('');
          setCategoryFilter('all');
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, [customCategory, selected, post, load]);

      const resetCategories = useCallback(async () => {
        try {
          const json = await post('/skill-pilot/categories', { reset: true });
          if (!json.ok) throw new Error(json.error || 'reset failed');
          setNotice('已恢复自动分类');
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, [post, load]);

      const deleteCategory = useCallback(async (name) => {
        try {
          const json = await post('/skill-pilot/categories', { delete: name });
          if (!json.ok) throw new Error(json.error || 'delete failed');
          setNotice(`已删除自定义分类「${name}」`);
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, [post, load]);

      const scanResources = useCallback(async () => {
        setControlBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/resources/scan', { path: resourcePath });
          if (!json.ok) throw new Error(json.error || 'scan failed');
          setResourcePlan(json);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setControlBusy(false);
        }
      }, [resourcePath, post]);

      const copyResources = useCallback(async () => {
        if (!resourceAck) return;
        setControlBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/resources/copy', { path: resourcePath, confirm: true });
          if (!json.ok) throw new Error(json.error || 'copy failed');
          setNotice(`资源已复制到 ${json.target}（${json.count} 个文件）`);
          setResourcePlan(null);
          setResourceAck(false);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setControlBusy(false);
        }
      }, [resourcePath, resourceAck, post]);

      const loadMetrics = useCallback(async () => {
        try {
          const json = await post('/skill-pilot/metrics', {});
          if (json.ok) setMetrics(json);
        } catch { /* optional */ }
      }, [post]);

      const runBenchmark = useCallback(async () => {
        setControlBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/benchmark/run', { limit: 60 });
          if (!json.ok) throw new Error(json.error || 'benchmark failed');
          setBenchmarkReport(json);
          await loadMetrics();
          setNotice(`真实库基准：${json.total} 条，Hit@1 ${(json.hit1Rate * 100).toFixed(1)}%`);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setControlBusy(false);
        }
      }, [post, loadMetrics]);

      const runTaskBenchmark = useCallback(async () => {
        setControlBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/benchmark/tasks', {});
          if (!json.ok) throw new Error(json.error || 'task benchmark failed');
          setTaskReport(json);
          setNotice(`任务基准：${json.passed}/${json.total}（${(json.passRate * 100).toFixed(1)}%）`);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setControlBusy(false);
        }
      }, [post]);

      const saveTeamPolicy = useCallback(async () => {
        try {
          const policy = JSON.parse(teamPolicyText);
          const json = await post('/skill-pilot/team/policy', { policy });
          if (!json.ok) throw new Error(json.error || 'policy failed');
          setNotice('团队策略已应用');
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, [teamPolicyText, post, load]);

      const clearTeamPolicy = useCallback(async () => {
        try {
          const json = await post('/skill-pilot/team/policy', { clear: true });
          if (!json.ok) throw new Error(json.error || 'clear failed');
          setTeamPolicyText('');
          setNotice('团队策略已清除');
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, [post, load]);

      const loadTeamAudit = useCallback(async () => {
        try {
          const json = await post('/skill-pilot/team/audit', {});
          if (json.ok) setTeamInfo(json);
        } catch { /* optional */ }
      }, [post]);

      const loadPlatform = useCallback(async () => {
        try {
          const json = await post('/skill-pilot/platform', {});
          if (json.ok) setPlatformReport(json);
        } catch { /* optional */ }
      }, [post]);

      const loadMarket = useCallback(async () => {
        try {
          const json = await post('/skill-pilot/market/status', {});
          if (json.ok) setMarketReport(json);
        } catch { /* optional */ }
      }, [post]);

      const loadAlerts = useCallback(async () => {
        try {
          const json = await post('/skill-pilot/alerts', {});
          if (json.ok) setAlerts(json);
        } catch { /* optional */ }
      }, [post]);

      const createBackup = useCallback(async () => {
        try {
          const json = await post('/skill-pilot/backup/create', { label: 'manual' });
          if (!json.ok) throw new Error(json.error || 'backup failed');
          setNotice(`备份已创建：${json.name}`);
          await loadBackups();
        } catch (err) { setError(String((err && err.message) || err)); }
      }, [post]);

      const loadBackups = useCallback(async () => {
        try {
          const json = await post('/skill-pilot/backup/list', {});
          if (json.ok) setBackups(json.backups || []);
        } catch { /* optional */ }
      }, [post]);

      const restoreBackup = useCallback(async (name) => {
        try {
          const json = await post('/skill-pilot/backup/restore', { name });
          if (!json.ok) throw new Error(json.error || 'restore failed');
          setNotice(`已恢复备份：${name}`);
          await load();
          await loadBackups();
        } catch (err) { setError(String((err && err.message) || err)); }
      }, [post, load, loadBackups]);

      const runPerf = useCallback(async () => {
        try {
          const json = await post('/skill-pilot/benchmark/perf', {});
          if (!json.ok) throw new Error(json.error || 'perf failed');
          setPerfReport(json);
          setNotice(`性能基准：检索 p95 ${json.retrieve.p95}ms · 扫描 ${json.scan.ms}ms · 快照 ${json.snapshot.ms}ms`);
        } catch (err) { setError(String((err && err.message) || err)); }
      }, [post]);

      const runAb = useCallback(async () => {        setControlBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/self-improve/ab', { apply: false });
          if (!json.ok) throw new Error(json.error || 'A/B failed');
          setAbReport(json);
          setNotice(json.best ? `A/B 建议阈值 ${json.best.threshold}（覆盖 ${json.best.coverage} / 精确 ${json.best.precision}）` : json.reason || 'A/B 无建议');
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setControlBusy(false);
        }
      }, [post]);

      const packageMcp = useCallback(async () => {        setControlBusy(true);
        setError('');
        try {
          const payload = convertResult && convertResult.ir
            ? { ir: convertResult.ir }
            : { content: convertText, path: '' };
          const json = await post('/skill-pilot/mcp/package', payload);
          if (!json.ok) throw new Error(json.error || 'package failed');
          setMcpReport(json);
          setNotice(`MCP 工程已生成：${json.dir}（语法 ${json.syntaxOk ? 'OK' : 'FAIL'}，冒烟 ${json.smokeOk ? 'OK' : 'FAIL'}）`);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setControlBusy(false);
        }
      }, [convertResult, convertText, post]);

      const checkUpdates = useCallback(async () => {        setControlBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/install/updates', {});
          if (!json.ok) throw new Error(json.error || 'updates failed');
          setUpdatesReport(json);
          setNotice(`更新检查：${json.count} 个已安装，可更新 ${(json.updates || []).filter((item) => item.updateAvailable).length} 个`);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setControlBusy(false);
        }
      }, [post]);

      const updateSkill = useCallback(async (name) => {
        setControlBusy(true);
        setError('');
        try {
          const json = await post('/skill-pilot/install/update', { name });
          if (!json.ok) throw new Error(json.error || json.blocked || 'update failed');
          setNotice(json.upToDate ? `${name} 已是最新` : `${name} 已更新${json.verified ? '并验证' : ''}`);
          await checkUpdates();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setControlBusy(false);
        }
      }, [post, checkUpdates]);

      let SECTIONS = [
        { id: 'sec-status', label: '运行状态', group: '运行' },
        { id: 'sec-health', label: '健康', group: '运行' },
        { id: 'sec-metrics', label: '运行指标', group: '运行' },
        { id: 'sec-convert', label: '格式转换', group: '能力' },
        { id: 'sec-improve', label: '自改进', group: '能力' },
        { id: 'sec-search', label: '检索工作台', group: '能力' },
        { id: 'sec-localdirs', label: '本机技能目录', group: '配置' },
        { id: 'sec-sources', label: '来源与凭据', group: '配置' },
        { id: 'sec-team', label: '团队与迁移', group: '配置' },
        { id: 'sec-mode', label: '决策模式', group: '配置' },
        { id: 'sec-catalog', label: '目录压缩', group: '配置' },
        { id: 'sec-groups', label: '分组', group: '配置' },
        { id: 'sec-decisions', label: '决策日志', group: '观察' },
        { id: 'sec-interop', label: '互操作', group: '观察' },
        { id: 'sec-bundles', label: 'Bundles / 插件', group: '扩展' },
        { id: 'sec-stats', label: '使用统计', group: '观察' },
        { id: 'sec-audit', label: '审计日志', group: '观察' },
      ];
      const LITE_SECTIONS = new Set(['sec-status', 'sec-search', 'sec-localdirs', 'sec-sources', 'sec-mode']);
      if (LITE) SECTIONS = SECTIONS.filter((section) => LITE_SECTIONS.has(section.id));
      const jumpTo = (id) => {        setActiveSection(id);
        if (typeof document === 'undefined') return;
        const target = document.getElementById(id);
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      };
      const scrollRaf = useRef(0);
      const onContentScroll = useCallback(() => {
        if (scrollRaf.current) return;
        const schedule = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
        scrollRaf.current = schedule(() => {
          scrollRaf.current = 0;
          const root = contentRef.current;
          if (!root) return;
          const top = root.getBoundingClientRect().top;
          let current = '';
          for (const section of SECTIONS) {
            const el = typeof document !== 'undefined' ? document.getElementById(section.id) : null;
            if (!el) continue;
            if (el.getBoundingClientRect().top - top <= 80) current = section.id;
          }
          if (current) setActiveSection(current);
        });
      }, []);

      useEffect(() => {
        const onResize = () => {
          if (typeof window !== 'undefined') setNarrow(window.innerWidth < 900);
        };
        onResize();
        if (typeof window !== 'undefined') window.addEventListener('resize', onResize);
        return () => { if (typeof window !== 'undefined') window.removeEventListener('resize', onResize); };
      }, []);

      useEffect(() => {
        if (contentRef.current) contentRef.current.scrollTop = 0;
      }, [activeGroup]);

      const scanLocalSkills = useCallback(async (dir, remember = false) => {
        setLocalBusy(true);
        try {
          const target = String(dir || '').trim();
          const body = target
            ? { onlyPath: target, ...(remember ? { extraDir: target, remember: true } : {}) }
            : { onlyPrimary: true };
          const json = await post('/skill-pilot/interop/scan', body);
          if (!json.ok) throw new Error(json.error || 'scan failed');
          const count = Array.isArray(json.skills) ? json.skills.length : 0;
          setLocalSkills({ count, scope: json.scope || target });
          setNotice(`扫描到 ${count} 个技能 · ${json.scope || target || '主默认目录'}`);
          if (remember) await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setLocalBusy(false);
        }
      }, [post, load]);

      const discoverDirs = useCallback(async (root) => {
        setDiscoverBusy(true);
        try {
          const json = await post('/skill-pilot/skills/discover', root ? { root } : {});
          if (!json.ok) throw new Error(json.error || 'discover failed');
          setDiscoverCandidates(json.candidates || []);
          setDiscoverSelected((json.candidates || []).filter((item) => item.skills > 0).map((item) => item.path));
          setDiscoverRoot(json.root || 'known-platform');
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setDiscoverBusy(false);
        }
      }, [post]);

      const discoverInPickedScope = useCallback(async () => {
        try {
          const picked = await post('/skill-pilot/fs/pick-dir', {});
          if (!picked.ok || !picked.path) { if (picked.error) setError(picked.error); return; }
          await discoverDirs(picked.path);
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, [post, discoverDirs]);

      const addDiscovered = useCallback(async () => {
        if (!discoverSelected.length) { setNotice('请先勾选要添加的目录'); return; }
        setDiscoverBusy(true);
        try {
          const json = await post('/skill-pilot/skills/discover/add', { dirs: discoverSelected });
          if (!json.ok) throw new Error(json.error || 'add failed');
          setDiscoverCandidates([]);
          setDiscoverSelected([]);
          setNotice(`已添加 ${json.added.length} 个目录${json.skipped && json.skipped.length ? `（跳过 ${json.skipped.length} 个重复）` : ''} · ${json.aiSkills} 个技能可被 AI 使用`);
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setDiscoverBusy(false);
        }
      }, [discoverSelected, post, load]);

      const pickNativeDir = useCallback(async () => {        setNativeBusy(true);
        try {
          const json = await post('/skill-pilot/fs/pick-dir', {});
          if (json.error) throw new Error(`${json.error}；可在输入框手动填写目录`);
          if (!json.ok && !json.canceled) throw new Error(json.error || '原生选择失败');
          if (json.ok && json.path) {
            setCustomRoot(json.path);
            await scanLocalSkills(json.path, true);
          } else {
            setNotice('已取消选择');
          }
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setNativeBusy(false);
        }
      }, [post, scanLocalSkills]);

      const saveDirs = useCallback(async (next) => {        try {
          const json = await post('/skill-pilot/settings', { extraSkillDirs: next });
          if (!json.ok) throw new Error(json.error || 'save failed');
          setEditingDir(-1);
          setEditingDirValue('');
          setNotice('目录已更新');
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, [post, load]);

      const patchSettings = useCallback(async (partial) => {
        try {
          const json = await post('/skill-pilot/settings', partial);
          if (!json.ok) throw new Error(json.error || 'save failed');
          setNotice('目录设置已更新');
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, [post, load]);

      const removeDirRow = useCallback(async (dir) => {
        if (dir.primary) { setNotice('主默认目录不可删除，请先把其他目录设为主默认'); return; }
        if (allDirs.length <= 1) { setNotice('至少保留一个技能目录'); return; }
        if (dir.isDefault) {
          await patchSettings({ disabledSkillDirs: [...disabledDirs, dir.path] });
        } else {
          await saveDirs(addedDirs.filter((item) => item !== dir.path));
        }
      }, [allDirs, disabledDirs, patchSettings, saveDirs, addedDirs]);

      const setPrimaryRow = useCallback(async (dir) => {
        await patchSettings({ primarySkillDir: dir.path });
      }, [patchSettings]);

      const goLocalSkills = useCallback(() => {
        setActiveGroup('配置');
        setTimeout(() => jumpTo('sec-localdirs'), 0);
      }, [jumpTo]);

      const dismissOnboard = useCallback(() => {
        setOnboardDismissed(true);
        try { if (typeof localStorage !== 'undefined') localStorage.setItem('skill-pilot-onboard', '1'); } catch { /* ignore */ }
      }, []);

      const sourceRows = useMemo(() => {
        const online = (settings.onlineSources || []).map((source) => ({
          key: `online:${source.name}`,
          name: source.name,
          detail: source.url || source.kind || '内置',
          secret: source.name === 'GitHub' ? 'github' : `source:${source.name}`,
        }));
        const pro = (settings.proSources || []).map((source) => ({
          key: `pro:${source.name}`,
          name: source.name,
          detail: `专业源 · ${source.kind}`,
          secret: `source:${source.name}`,
        }));
        return [...online, ...pro];
      }, [settings.onlineSources, settings.proSources]);

      const updateProSource = async (name, patch) => {
        const next = (settings.proSources || []).map((source) => (
          source.name === name ? { ...source, ...patch } : source
        ));
        await saveSettings({ proSources: next });
      };

      const reorderProSource = async (from, to) => {
        const list = [...(settings.proSources || [])];
        if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return;
        const [moved] = list.splice(from, 1);
        list.splice(to, 0, moved);
        const next = list.map((source, index) => ({ ...source, priority: (list.length - index) * 10 }));
        await saveSettings({ proSources: next });
      };
      const series = usage ? usage.series : [];
      const maxLoads = Math.max(1, ...series.map((point) => point.loads));
      const maxToggles = Math.max(1, ...series.map((point) => point.toggles));
      const stepX = series.length > 1 ? 600 / (series.length - 1) : 0;
      const linePoints = series
        .map((point, index) => `${8 + index * stepX},${118 - (point.loads / maxLoads) * 96}`)
        .join(' ');
      const togglePoints = series
        .map((point, index) => `${8 + index * stepX},${118 - (point.toggles / maxToggles) * 96}`)
        .join(' ');
      const topSkills = usage ? usage.top : [];
      const maxTop = Math.max(1, ...topSkills.map((row) => row.count));

      const metric = (label, value, target) => h('div', {
        key: label,
        style: { ...S.metric, cursor: target ? 'pointer' : 'default' },
        title: target ? '点击跳转' : undefined,
        onClick: target ? () => jumpTo(target) : undefined,
      },
        h('span', { style: S.metricValue }, String(value)),
        h('span', { style: S.metricLabel }, label));

      const panel = h('div', { style: { ...S.page, maxWidth: 'none', padding: 0 } },
        h('div', { style: { ...S.head, marginBottom: 12 } },
          h('div', null,
            h('h2', { style: S.title }, '技能领航员'),
            h('p', { style: S.sub }, '让技能对你“消失”：自动检索、加载、获取、维护与适配；全程可暂停、可解释、可回滚。'),
          ),
          h('button', { style: S.ghost, onClick: load }, loading ? '刷新中…' : '刷新状态'),
        ),

        h('section', { id: 'sec-status', style: S.hero },
          h('div', { style: S.heroRow },
            h('div', null,
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('span', { style: S.statusPill(settings.paused === true) }, settings.paused ? '已暂停' : '运行中'),
                h('span', { style: S.chip('ok') }, `决策模式 ${activeMode.label}`),
                data && data.interop ? h('span', { style: S.chip('') }, `外部能力 ${data.interop.count}`) : null,
              ),
              h('h2', { style: { ...S.heroTitle, marginTop: 10 } },
                settings.paused ? '自动动作已冻结' : '自主能力已就绪'),
              h('p', { style: S.heroSub },
                settings.paused
                  ? '暂停只冻结自动加载/安装/维护，手动检索仍然可用；点“恢复”回到原设置。'
                  : '需要能力时会自己检索、选择、加载；缺能力时按预算与白名单获取，失败自动回退。'),
              h('div', { style: { ...S.toolbar, marginTop: 12 } },
                h('input', {
                  style: { ...S.search, maxWidth: 520 },
                  placeholder: '试试：帮我把这份飞书表格导成 Excel',
                  value: quickQuery,
                  onChange: (event) => setQuickQuery(event.target.value),
                  onKeyDown: (event) => { if (event.key === 'Enter' && quickQuery.trim()) runQuick(); },
                }),
                h('button', { style: S.primaryBtn, disabled: quickBusy || !quickQuery.trim(), onClick: runQuick },
                  quickBusy ? '检索中…' : '快速检索'),
                h('button', { style: S.ghost, onClick: goLocalSkills }, '本机技能'),
              ),
              quickResult
                ? h('div', { style: { ...S.toolbar, marginTop: 8 } },
                    h('span', { style: S.chip(quickResult.action === 'use' ? 'ok' : '') }, `${quickResult.action} · ${quickResult.confidence}`),
                    (quickResult.candidates || []).slice(0, 3).map((item) =>
                      h('span', { key: item.name, style: S.chip('') }, item.name)))
                : null,
              (!onboardDismissed && data && (data.installs || []).length === 0)
                ? h('div', {
                    style: {
                      marginTop: 14, border: `1px dashed ${COLORS.border}`, borderRadius: 12,
                      padding: '12px 14px', background: 'rgba(79,140,255,0.06)',
                    },
                  },
                    h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, '第一次使用？从这三步开始'),
                    h('div', { style: { ...S.hint, marginTop: 4 } },
                      '1）先看看本机已有哪些技能；2）用上方输入框描述任务；3）缺能力时再去在线找。'),
                    h('div', { style: { ...S.toolbar, marginTop: 8 } },
                      h('button', { style: S.primaryBtn, onClick: goLocalSkills }, '查找本机技能'),
                      h('button', { style: S.ghost, onClick: () => { setActiveGroup('能力'); setSearchTab('online'); setTimeout(() => jumpTo('sec-search'), 0); } }, '在线找技能'),                      h('button', { style: S.ghost, onClick: dismissOnboard }, '以后再说')))
                : null,
            ),
            h('div', { style: S.toolbar },
              h('button', {
                style: settings.paused ? S.primaryBtn : S.dangerBtn,
                disabled: controlBusy,
                onClick: togglePause,
              }, settings.paused ? '恢复自动' : '暂停全部自动动作'),
            ),
          ),
          h('div', { style: S.metricGrid },
            metric('技能总数', counts.total, 'sec-catalog'),
            metric('已启用', counts.enabled, 'sec-catalog'),
            metric('累计加载', counts.loads, 'sec-stats'),
            metric('已安装', data && data.installs ? data.installs.length : 0, 'sec-sources'),
            metric('知识缓存', data && data.cacheCount !== undefined ? data.cacheCount : 0, 'sec-pro'),
            metric('今日动作预算', settings.actionBudget !== undefined ? settings.actionBudget : 3, 'sec-mode'),
          ),
        ),

        h('div', { style: S.chips },
          h('span', { style: S.chip('') }, h('span', { style: S.dot('') }), `技能 ${counts.total}`),
          h('span', { style: S.chip('ok') }, `开启 ${counts.enabled}`),
          h('span', { style: S.chip('') }, `关闭 ${counts.total - counts.enabled}`),
          h('span', { style: S.chip('') }, `置顶 ${counts.pinned}`),
          h('span', { style: S.chip('') }, `决策 ${data && data.decisions ? data.decisions.length : 0}`),
        ),

        h('div', { id: 'sec-search', style: S.card },
          h('div', { style: S.cardHead },
            h('h3', { style: S.cardTitle }, '检索工作台'),
            h('span', { style: S.hint }, LITE ? '本地技能 / 在线找技能，切换不丢状态' : '技能 / 在线 / 专业 三合一，切换不丢状态'),
          ),
          h('div', { style: S.seg },
            (LITE ? [['skills', '技能'], ['online', '在线技能']] : [['skills', '技能'], ['online', '在线技能'], ['pro', '专业检索']]).map(([id, label]) =>
              h('button', { key: id, style: S.segBtn(searchTab === id), onClick: () => setSearchTab(id) }, label))),
        ),

        h('div', { id: 'sec-online', style: { ...S.card, display: searchTab === 'online' ? 'block' : 'none' } },
          h('div', { style: S.cardHead },
            h('h3', { style: S.cardTitle }, '在线找技能'),
            h('span', { style: S.hint }, '显式联网 · 结果不可信 · 不自动安装'),
          ),
          h('div', { style: S.toolbar },
            h('input', {
              style: S.search, placeholder: '描述你缺的能力，例如：PDF 表单填写 / PowerPoint 生成',
              value: onlineQuery, onChange: (event) => setOnlineQuery(event.target.value),
            }),
            h('button', { style: S.ghost, disabled: onlineBusy || !onlineQuery.trim(), onClick: searchOnline },
              onlineBusy ? '搜索中…' : '搜索'),
          ),
          h('div', { style: { ...S.toolbar, marginTop: 8 } },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: COLORS.sub } },
              h('input', {
                type: 'checkbox', checked: settings.securityScanDefault !== false,
                onChange: (event) => saveSettings({ securityScanDefault: event.target.checked }),
              }),
              '下载/安装前安全预检（默认开，可关）'),
            LITE ? null : h('input', {
              style: { ...S.priorityInput, width: 180, padding: '3px 8px', fontSize: 11.5 },
              placeholder: 'owner/repo 建技能级索引',
              value: registryRepo, onChange: (event) => setRegistryRepo(event.target.value),
            }),
            LITE ? null : h('button', { style: S.ghost, disabled: registryBusy || !registryRepo.trim(), onClick: indexRegistry },
              registryBusy ? '索引中…' : '索引仓库'),
            LITE ? null : h('button', {
              style: S.ghost,
              disabled: registryBusy || !(onlineResults || []).some((item) => item.repo),
              onClick: indexSearchResults,
            }, '把搜索结果加入索引'),
            LITE ? null : h('button', { style: S.ghost, disabled: registryBusy, onClick: crawlRegistry }, '爬取在线注册表'),
            LITE ? null : h('button', { style: S.ghost, disabled: registryBusy, onClick: crawlSkillsSh }, '抓取 skills.sh'),
            LITE ? null : h('button', { style: S.ghost, disabled: registryBusy, onClick: enrichRegistry }, '补全描述'),
            LITE ? null : h('span', { style: S.hint }, `已索引 ${(data && data.onlineRegistry) || 0} 个技能`),
          ),
          h('div', { style: { ...S.toolbar, marginTop: 8 } },
            h('span', { style: S.hint }, '来源的启用、优先级、Token 统一在「来源与凭据」管理，避免两处配置互相覆盖。'),
            h('button', { style: S.ghost, onClick: () => jumpTo('sec-sources') }, '去来源与凭据'),
          ),
          h('p', { style: S.hint },
            'GitHub 默认作为内置来源；自定义来源用 {q} 占位（例：https://skills.sh/search?q={q}），优先级越大越先搜。'),
          h('p', { style: S.hint },
            '安全预检是静态启发式：只覆盖已知危险模式（命令执行、网络下载、凭据读取、文件写入、编码执行等），不能保证 100% 安全；medium/high 需人工确认，安装后仍建议审阅正文与资源，并可用下方回滚。'),
          notice ? h('div', { style: { fontSize: 11.5, color: COLORS.ok } }, notice) : null,
          onlineResults === null
            ? null
            : onlineResults.length === 0
              ? h('div', { style: S.empty }, '没有找到结果')
              : h('div', { style: S.grid }, onlineResults.map((item) =>
                  h('div', { key: `${item.source}:${item.name}:${item.url}`, style: S.bundleCard },
                    h('div', { style: S.badgeRow },
                      h('span', { style: S.badge('') }, item.source || 'unknown'),
                      item.stars ? h('span', { style: S.hint }, `★ ${item.stars}`) : null,
                      h('span', { style: { marginLeft: 'auto', fontSize: 10.5, color: COLORS.sub } }, `优先级 ${item.priority}`),
                    ),
                    h('span', { style: S.bundleName }, item.name),
                    h('p', { style: S.cardDesc }, item.description || '（无描述）'),
                    item.repo ? h('div', { style: S.badgeRow },
                      h('span', { style: S.badge('') }, item.repo),
                      scanResults[item.repo]
                        ? h('span', { style: S.badge(scanResults[item.repo].risk === 'low' ? 'ok' : '') },
                            `安全预检：${scanResults[item.repo].risk}（${scanResults[item.repo].score} 分）`)
                        : h('span', { style: S.badge('') }, settings.securityScanDefault !== false ? '未预检' : '预检已关'),
                    ) : null,
                    item.install ? h('div', { style: { fontSize: 11, color: COLORS.sub, wordBreak: 'break-all' } }, item.install) : null,
                    item.url ? h('a', { href: item.url, target: '_blank', rel: 'noreferrer', style: { fontSize: 11, color: COLORS.brand, wordBreak: 'break-all' } }, item.url) : null,
                    item.sourceUrl
                      ? h('div', { style: { fontSize: 10.5, color: COLORS.sub, wordBreak: 'break-all' } },
                          `来源 ${item.sourceUrl}${item.fetchedAt ? ` · 抓取 ${new Date(item.fetchedAt).toLocaleDateString('zh-CN')}` : ''}${item.stale ? ' · ⚠ 可能过期' : ''}`)
                      : null,
                    item.repo ? h('div', { style: S.cardFoot },
                      settings.securityScanDefault !== false
                        ? h('button', { style: S.ghost, disabled: scanBusy === item.repo, onClick: () => scanOnline(item) },
                            scanBusy === item.repo ? '预检中…' : '安全预检')
                        : null,
                      settings.securityScanDefault !== false && scanResults[item.repo] && scanResults[item.repo].findings && scanResults[item.repo].findings.length
                        ? h('span', { style: { fontSize: 10.5, color: COLORS.sub } }, `发现 ${scanResults[item.repo].findings.length} 项`)
                        : null,
                      h('button', {
                        style: S.ghost, disabled: installBusy === item.repo,
                        onClick: () => installOnline(item),
                      }, installBusy === item.repo ? '安装中…' : '安装'),
                    ) : null,
                  ))),
          (data && data.installs && data.installs.length)
            ? h('div', { style: { marginTop: 10 } },
                h('div', { style: S.hint }, `已安装 ${data.installs.length} 个（目录：${data.installRoot}）`),
                h('div', { style: S.grid }, data.installs.map((entry) =>
                  h('div', { key: `${entry.name}:${entry.at}`, style: S.bundleCard },
                    h('span', { style: S.bundleName }, entry.name),
                    h('span', { style: S.hint }, `${entry.repo || 'unknown'} · 预检 ${entry.risk || 'unchecked'}`),
                    h('div', { style: S.cardFoot },
                      h('button', {
                        style: S.linkDanger, disabled: installBusy === entry.name,
                        onClick: () => rollbackInstalled(entry.name),
                      }, installBusy === entry.name ? '回滚中…' : '回滚'),
                    ),
                  ))))
            : null,
        ),

        h('div', { id: 'sec-pro', style: { ...S.card, display: searchTab === 'pro' ? 'block' : 'none' } },
          h('div', { style: S.cardHead },
            h('h3', { style: S.cardTitle }, '专业检索'),
            h('span', { style: S.hint }, `研报 / 行情 / 官方文档 · 缓存 ${data ? data.cacheCount || 0 : 0} 条`),
          ),
          h('div', { style: S.toolbar },
            h('input', {
              style: S.search, placeholder: '例如：贵州茅台最新研报 / Array.map 文档',
              value: proQuery, onChange: (event) => setProQuery(event.target.value),
            }),
            h('button', { style: S.ghost, disabled: proBusy || !proQuery.trim(), onClick: runResearchRoute }, '路由'),
            h('button', { style: S.ghost, disabled: proBusy || !proQuery.trim(), onClick: runProSearch }, '专业检索'),
            h('button', { style: S.ghost, onClick: clearCache }, '清空缓存'),
          ),
          proRoute
            ? h('div', { style: { fontSize: 11.5, color: COLORS.sub, marginTop: 6 } },
                `路由：${proRoute.label} · ${proRoute.needsExternal ? '建议外部检索' : '本地优先'}`
                + (proRoute.sources && proRoute.sources.length ? ` · 专业源 ${proRoute.sources.join(', ')}` : '')
                + (proRoute.policy ? ` · ${proRoute.policy}` : ''))
            : null,
          proResults === null
            ? h('div', { style: S.hint }, '先「路由」判断要不要查、查哪类源，再「专业检索」。')
            : proResults.length === 0
              ? h('div', { style: S.empty }, '没有结果')
              : h('div', { style: S.grid }, proResults.map((item, index) =>
                  h('div', { key: `${index}:${item.title}`, style: S.bundleCard },
                    h('div', { style: S.badgeRow },
                      h('span', { style: S.badge('') }, item.source || 'source'),
                    ),
                    h('span', { style: S.bundleName }, item.title),
                    h('p', { style: S.cardDesc }, item.description || ''),
                    item.url ? h('a', {
                      href: item.url, target: '_blank', rel: 'noreferrer',
                      style: { fontSize: 11, color: COLORS.brand, wordBreak: 'break-all' },
                    }, item.url) : null,
                  ))),
        ),

        h('div', { id: 'sec-localdirs', style: S.card },
          h('div', { style: S.cardHead },
            h('h3', { style: S.cardTitle }, '本机技能目录'),
            h('span', { style: S.hint }, '扫描默认目录 / 自定义目录 / 已添加目录；只读，不执行脚本'),
          ),
          h('div', { style: { margin: '4px 0 8px' } },
            h('div', { style: { ...S.hint, fontWeight: 600 } }, '技能目录（至少保留一个；● 为主默认）'),
            allDirs.map((dir) => {
              const customIndex = dir.isDefault ? -1 : addedDirs.indexOf(dir.path);
              return h('div', { key: dir.path, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 11.5, borderBottom: `1px dashed ${COLORS.border}` } },
                h('button', {
                  style: { border: 0, background: 'transparent', cursor: 'pointer', fontSize: 13, color: dir.primary ? COLORS.brand : COLORS.sub, padding: 0 },
                  title: '设为主默认',
                  onClick: () => setPrimaryRow(dir),
                }, dir.primary ? '●' : '○'),
                editingDir === customIndex && customIndex >= 0
                  ? h('input', {
                      style: { ...S.search, flex: 1 },
                      value: editingDirValue,
                      onChange: (event) => setEditingDirValue(event.target.value),
                    })
                  : h('span', { style: { flex: 1, color: COLORS.sub, wordBreak: 'break-all' } },
                      `📁 ${dir.path}${dir.primary ? '（主默认）' : ''}${dir.isDefault ? '' : ' · 自定义'}${dir.exists === false ? '（不存在）' : ''}`),
                customIndex >= 0 && editingDir === customIndex
                  ? h('button', {
                      style: S.ghost,
                      disabled: !editingDirValue.trim(),
                      onClick: () => saveDirs(addedDirs.map((item, i) => (i === customIndex ? editingDirValue.trim() : item))),
                    }, '保存')
                  : (customIndex >= 0
                    ? h('button', {
                        style: S.ghost,
                        onClick: () => { setEditingDir(customIndex); setEditingDirValue(dir.path); },
                      }, '编辑')
                    : null),
                customIndex >= 0 && editingDir === customIndex
                  ? h('button', { style: S.ghost, onClick: () => { setEditingDir(-1); setEditingDirValue(''); } }, '取消')
                  : h('button', {
                      style: S.ghost,
                      disabled: allDirs.length <= 1 || dir.primary,
                      title: dir.primary ? '主默认目录不可删除' : '',
                      onClick: () => removeDirRow(dir),
                    }, '移除'));
            }),
            h('div', { style: { ...S.toolbar, marginTop: 4 } },
              h('button', { style: S.ghost, onClick: () => patchSettings({ disabledSkillDirs: [] }) }, '恢复默认目录'),
              h('span', { style: S.hint }, '移除=从列表隐藏且不再扫描；默认目录可用「恢复默认目录」找回'),
            ),
          ),
          h('div', { style: { ...S.toolbar, marginTop: 4 } },
            h('button', { style: S.primaryBtn, disabled: discoverBusy, onClick: () => discoverDirs() },
              discoverBusy ? '扫描中…' : '发现技能目录'),
            h('button', { style: S.ghost, disabled: nativeBusy, onClick: pickNativeDir },
              nativeBusy ? '请在弹出的窗口选择…' : '浏览并添加目录'),
            h('input', {
              style: { ...S.search, maxWidth: 240 },
              placeholder: '或手动输入目录后回车添加',
              value: customRoot,
              onChange: (event) => setCustomRoot(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter' && customRoot.trim()) scanLocalSkills(customRoot, true); },
            }),
            h('span', { style: S.hint },
              localSkills
                ? `最近扫描：${localSkills.count} 个 · ${localSkills.scope || '主默认目录'}`
                : '发现=列出平台/插件目录供勾选；添加后其中的技能可被 AI 使用'),
          ),
          discoverCandidates.length
            ? h('div', { style: { marginTop: 8, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '8px 10px' } },
                h('div', { style: { ...S.hint, fontWeight: 600, marginBottom: 4 } },
                  `发现 ${discoverCandidates.length} 个候选目录（勾选后添加，添加后其中的技能可被 AI 使用）`),
                h('div', { style: { ...S.toolbar, marginBottom: 4 } },
                  h('button', { style: S.ghost, onClick: () => setDiscoverSelected(discoverCandidates.map((item) => item.path)) }, '全选'),
                  h('button', { style: S.ghost, onClick: () => setDiscoverSelected([]) }, '清空'),
                  h('button', { style: S.ghost, onClick: discoverInPickedScope }, '选择文件夹范围…'),
                  h('button', { style: S.primaryBtn, disabled: discoverBusy || discoverSelected.length === 0, onClick: addDiscovered },
                    `添加选中（${discoverSelected.length}）`)),
                discoverCandidates.map((item) =>
                  h('label', { key: item.path, style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 2px', borderBottom: `1px dashed ${COLORS.border}`, fontSize: 11.5, cursor: 'pointer' } },
                    h('input', {
                      type: 'checkbox',
                      checked: discoverSelected.includes(item.path),
                      onChange: () => setDiscoverSelected((prev) => prev.includes(item.path)
                        ? prev.filter((entry) => entry !== item.path)
                        : [...prev, item.path]),
                    }),
                    h('span', { style: { flex: 1, color: COLORS.sub, wordBreak: 'break-all' } },
                      `📁 ${item.path} · ${item.kind} · ${item.platform} · ${item.skills} 个技能`))))
            : null,
        ),

        h('div', { id: 'sec-sources', style: S.card },
          h('div', { style: S.cardHead },
            h('h3', { style: S.cardTitle }, '来源与凭据'),
            h('span', { style: S.hint }, '统一管理检索网址与其 Token（无 token 留空）· AES 加密'),
          ),
          h('div', { style: { ...S.hint, marginBottom: 6 } }, '拖动 ⠿ 或 ↑↓ 排序；越靠上优先级越高。'),
          (settings.onlineSources || []).map((source, index) => {
            const secretName = source.name === 'GitHub' ? 'github' : `source:${source.name}`;
            const configured = secretList.some((entry) => entry.name === secretName);
            const key = `online:${index}`;
            return h('div', {
              key: source.name,
              onDragOver: (event) => { event.preventDefault(); setDragOver(key); },
              onDragLeave: () => setDragOver(''),
              onDrop: () => { reorderSources(dragSource, index); setDragSource(-1); setDragOver(''); },
              style: {
                ...S.sourceCard,
                borderTop: dragOver === key ? `2px solid ${COLORS.brand}` : `1px solid ${COLORS.border}`,
                opacity: dragSource === index ? 0.55 : 1,
              },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('span', {
                  draggable: true,
                  style: { fontSize: 13, color: COLORS.sub, cursor: 'grab' },
                  onDragStart: (event) => { event.dataTransfer.setData('text/plain', 'source'); setDragSource(index); },
                }, '⠿'),
                h('strong', { style: { fontSize: 12 } }, source.name),
                h('span', { style: S.badge('') }, source.kind === 'github' ? '内置' : '自定义'),
                h('span', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                  h('button', { style: S.ghost, onClick: () => openSecret(secretName) }, configured ? 'Token ✓' : 'Token'),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 } },
                    h('input', {
                      type: 'checkbox', checked: source.enabled !== false,
                      onChange: () => updateSource(source.name, { enabled: !(source.enabled !== false) }),
                    }),
                    '启用'),
                  h('input', {
                    type: 'number', min: 0, max: 100, style: S.priorityInput, value: source.priority,
                    title: '优先级',
                    onChange: (event) => updateSource(source.name, { priority: Number(event.target.value) }),
                  }),
                  h('button', { style: S.linkDanger, title: '上移', disabled: index === 0, onClick: () => reorderSources(index, index - 1) }, '↑'),
                  h('button', { style: S.linkDanger, title: '下移', disabled: index === (settings.onlineSources || []).length - 1, onClick: () => reorderSources(index, index + 1) }, '↓'),
                  source.kind === 'github' ? null : h('button', { style: S.linkDanger, title: '删除', onClick: () => removeSource(source.name) }, '×')),
              ),
              h('div', { style: S.sourceMeta }, source.name === 'GitHub' ? '内置 GitHub Search' : (source.url || source.kind || '')),
              secretEditor(secretName),
            );
          }),
          (settings.proSources || []).map((source, index) => {
            const secretName = `source:${source.name}`;
            const configured = secretList.some((entry) => entry.name === secretName);
            const key = `pro:${index}`;
            return h('div', {
              key,
              onDragOver: (event) => { event.preventDefault(); setDragOver(key); },
              onDragLeave: () => setDragOver(''),
              onDrop: async () => { await reorderProSource(dragPro, index); setDragPro(-1); setDragOver(''); },
              style: {
                ...S.sourceCard,
                borderTop: dragOver === key ? `2px solid ${COLORS.brand}` : `1px solid ${COLORS.border}`,
                opacity: dragPro === index ? 0.55 : 1,
              },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('span', {
                  draggable: true,
                  style: { fontSize: 13, color: COLORS.sub, cursor: 'grab' },
                  onDragStart: (event) => { event.dataTransfer.setData('text/plain', 'pro'); setDragPro(index); },
                }, '⠿'),
                h('strong', { style: { fontSize: 12 } }, source.name),
                h('span', { style: S.badge('') }, '专业源'),
                h('span', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                  h('button', { style: S.ghost, onClick: () => openSecret(secretName) }, configured ? 'Token ✓' : 'Token'),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 } },
                    h('input', {
                      type: 'checkbox', checked: source.enabled !== false,
                      onChange: () => updateProSource(source.name, { enabled: !(source.enabled !== false) }),
                    }),
                    '启用'),
                  h('button', { style: S.linkDanger, title: '上移', disabled: index === 0, onClick: () => reorderProSource(index, index - 1) }, '↑'),
                  h('button', { style: S.linkDanger, title: '下移', disabled: index === (settings.proSources || []).length - 1, onClick: () => reorderProSource(index, index + 1) }, '↓')),
              ),
              h('div', { style: S.sourceMeta }, `专业源 · ${source.kind}`),
              secretEditor(secretName),
            );
          }),
          h('div', { style: { ...S.hint, marginTop: 4 } }, '点行内「Token」在该行下方编辑；网址不需要 token 就留空。'),
          h('div', { style: S.hint }, secretStatus || 'Token 仅用于对应网址请求，不进入日志/审计/模型上下文。'),
          sourceForm
            ? h('div', { style: { ...S.toolbar, marginTop: 8 } },
                h('input', {
                  style: { ...S.priorityInput, width: 120, padding: '3px 8px', fontSize: 11.5 },
                  placeholder: '名称，如 Skills.sh',
                  value: sourceForm.name,
                  onChange: (event) => setSourceForm({ ...sourceForm, name: event.target.value }),
                }),
                h('input', {
                  style: { ...S.priorityInput, width: 260, padding: '3px 8px', fontSize: 11.5 },
                  placeholder: 'https://site/search?q={q}',
                  value: sourceForm.url,
                  onChange: (event) => setSourceForm({ ...sourceForm, url: event.target.value }),
                }),
                h('input', {
                  style: { ...S.priorityInput, width: 170, padding: '3px 8px', fontSize: 11.5 },
                  type: sourceTokenRevealed ? 'text' : 'password', placeholder: 'Token（可留空）',
                  value: sourceForm.token || '',
                  onChange: (event) => setSourceForm({ ...sourceForm, token: event.target.value }),
                }),
                h('button', {
                  style: S.ghost,
                  title: sourceTokenRevealed ? '隐藏 Token' : '显示 Token',
                  onClick: () => setSourceTokenRevealed(!sourceTokenRevealed),
                }, sourceTokenRevealed ? '🙈 隐藏' : '👁 显示'),
                h('input', {
                  type: 'number', min: 0, max: 100, style: S.priorityInput,
                  value: sourceForm.priority,
                  onChange: (event) => setSourceForm({ ...sourceForm, priority: Number(event.target.value) }),
                }),
                h('button', { style: S.ghost, onClick: submitSource }, '保存来源'),
                h('button', { style: S.ghost, onClick: () => setSourceForm(null) }, '取消'))
            : h('div', { style: { ...S.toolbar, marginTop: 8 } },
                h('button', { style: S.ghost, onClick: () => setSourceForm({ name: '', url: '', priority: 5, token: '' }) }, '＋ 添加网址')),
          h('label', { style: { ...S.switchRow, marginTop: 10, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox', checked: settings.useSkillsSh !== false,
              onChange: (event) => saveSettings({ useSkillsSh: event.target.checked }),
            }),
            h('span', null,
              h('span', { style: S.modeLabel }, '使用 skills.sh 公开种子'),
              h('span', { style: S.modeDesc }, '关闭后只从 GitHub 构建我们自己的索引（skills.sh 仅作为公开种子之一）。')),
          ),
        ),

        h('div', { id: 'sec-mode', style: S.card },
          h('div', { style: S.cardHead },
            h('h3', { style: S.cardTitle }, '决策模式'),
            h('span', { style: S.hint }, '决定谁来找技能、谁来改开关'),
          ),
          h('p', { style: S.hint },
            '越往下 AI 越主动，注入的 token 也越多；「人工」下 Host 完全不注入。模式只能在这里切换，AI 不能自己改。'),
          MODES.map((mode, index) => h('label', {
            key: mode.id,
            style: index === 0 ? { ...S.modeRow, borderTop: 'none' } : S.modeRow,
          },
            h('input', {
              type: 'radio', name: 'skill-pilot-autonomy', style: S.radio,
              checked: settings.autonomy === mode.id, disabled: modeBusy,
              onChange: () => { if (settings.autonomy !== mode.id) saveSettings({ autonomy: mode.id }); },
            }),
            h('span', null,
              h('span', { style: S.modeLabel }, mode.label),
              h('span', { style: S.modeDesc }, mode.desc)),
          )),
          h('label', { style: { ...S.switchRow, cursor: settings.autonomy === 'full' ? 'pointer' : 'not-allowed' } },
            h('input', {
              type: 'checkbox', style: S.radio,
              checked: settings.allowPluginControl === true,
              disabled: settings.autonomy !== 'full' || modeBusy,
              onChange: (event) => saveSettings({ allowPluginControl: event.target.checked }),
            }),
            h('span', null,
              h('span', { style: S.modeLabel }, '允许 AI 管理插件'),
              h('span', { style: S.modeDesc }, '仅在「完全自主」下可勾选；插件开关是 profile 级，影响所有会话。')),
          ),
          h('label', { style: { ...S.switchRow, cursor: settings.autonomy === 'full' ? 'pointer' : 'not-allowed', marginTop: 10 } },
            h('input', {
              type: 'checkbox', style: S.radio,
              checked: settings.autoAcquire === true,
              disabled: settings.autonomy !== 'full' || modeBusy,
              onChange: (event) => saveSettings({ autoAcquire: event.target.checked }),
            }),
            h('span', null,
              h('span', { style: S.modeLabel }, '允许 AI 自动获取低风险技能'),
              h('span', { style: S.modeDesc }, '仅在「完全自动」+ 预检 low 时自动安装；medium/high 仍只提议。')),
          ),
          h('label', { style: { ...S.switchRow, cursor: settings.autonomy === 'full' ? 'pointer' : 'not-allowed', marginTop: 10 } },
            h('input', {
              type: 'checkbox', style: S.radio,
              checked: settings.autoDisableBroken === true,
              disabled: settings.autonomy !== 'full' || modeBusy,
              onChange: (event) => saveSettings({ autoDisableBroken: event.target.checked }),
            }),
            h('span', null,
              h('span', { style: S.modeLabel }, '自诊断发现坏技能时自动关闭'),
              h('span', { style: S.modeDesc }, '仅在「完全自动」模式生效；会写审计，可随时再启用。')),
          ),
          h('label', { style: { ...S.switchRow, cursor: 'pointer', marginTop: 10 } },
            h('input', {
              type: 'checkbox', style: S.radio,
              checked: settings.autoEnable === true,
              disabled: settings.autonomy === 'manual' || modeBusy,
              onChange: (event) => saveSettings({ autoEnable: event.target.checked }),
            }),
            h('span', null,
              h('span', { style: S.modeLabel }, '允许 AI 启用技能（独立授权）'),
              h('span', { style: S.modeDesc }, '开启后，即使处于「标准」模式，AI 也可把需要的技能打开；关闭不可用。')),
          ),
          h('label', { style: { ...S.switchRow, cursor: 'pointer', marginTop: 10 } },
            h('input', {
              type: 'checkbox', style: S.radio,
              checked: settings.dryRun === true,
              disabled: modeBusy,
              onChange: (event) => saveSettings({ dryRun: event.target.checked }),
            }),
            h('span', null,
              h('span', { style: S.modeLabel }, 'dry-run：自动获取只给计划'),
              h('span', { style: S.modeDesc }, '开启后 AI 只返回安装计划与风险，不下载/不落盘，适合先观察。')),
          ),
          h('div', { style: { ...S.writeRow, marginTop: 10 } },
            h('span', { style: S.modeLabel }, '信任仓库 owner'),
            h('input', {
              style: { ...S.priorityInput, width: 220, padding: '3px 8px', fontSize: 11.5 },
              placeholder: 'anthropics, microsoft（逗号分隔）',
              value: (settings.trustedOwners || []).join(', '),
              disabled: modeBusy,
              onChange: (event) => saveSettings({
                trustedOwners: event.target.value.split(/[,\s]+/).filter(Boolean),
              }),
            }),
            h('span', { style: S.hint }, '白名单 owner 的 medium 风险技能可自动装；high 永不自动'),
          ),
          h('div', { style: { ...S.writeRow, marginTop: 10 } },
            h('span', { style: S.modeLabel }, '自动动作预算 / 会话'),
            h('input', {
              type: 'number', min: 0, max: 20, style: S.priorityInput,
              value: settings.actionBudget === undefined ? 3 : settings.actionBudget,
              disabled: modeBusy,
              onChange: (event) => saveSettings({ actionBudget: Number(event.target.value) }),
            }),
            h('span', { style: S.hint }, 'AI 自动安装类动作每会话上限；用完只提议'),
          ),
          h('div', { style: { ...S.writeRow, marginTop: 10 } },
            h('span', { style: S.modeLabel }, '闲置自动禁用（天）'),
            h('input', {
              type: 'number', min: 0, max: 365, style: S.priorityInput,
              value: settings.idleDisableDays === undefined ? 0 : settings.idleDisableDays,
              disabled: modeBusy,
              onChange: (event) => saveSettings({ idleDisableDays: Number(event.target.value) }),
            }),
            h('span', { style: S.hint }, '0=关闭；闲置技能在启用检索无匹配时仍会被找回，可自动启用'),
          ),
          h('label', { style: { ...S.switchRow, cursor: 'pointer', marginTop: 10 } },
            h('input', {
              type: 'checkbox', style: S.radio,
              checked: settings.nudges !== false,
              disabled: modeBusy,
              onChange: (event) => saveSettings({ nudges: event.target.checked }),
            }),
            h('span', null,
              h('span', { style: S.modeLabel }, '上下文主动提示'),
              h('span', { style: S.modeDesc }, '识别 PDF/Excel/PPT/飞书等任务时贴一条可用技能提示（每会话最多 2 条）。')),
          ),
        ),

        h('div', { id: 'sec-skills', style: { ...S.card, display: searchTab === 'skills' ? 'block' : 'none' } },
          h('div', { style: S.cardHead },
            h('h3', { style: S.cardTitle }, '技能'),
            h('div', { style: S.toolbar },
              h('input', {
                style: S.search, placeholder: '搜索名称 / 描述 / 适用场景', value: query,
                onChange: (event) => setQuery(event.target.value),
              }),
              h('span', { style: S.seg },
                [['all', '全部'], ['on', '开启'], ['off', '关闭'], ['pin', '置顶']].map(([id, label]) =>
                  h('button', { key: id, style: S.segBtn(filter === id), onClick: () => setFilter(id) }, label)),
              ),
            ),
          ),
          h('div', { style: { ...S.toolbar, marginTop: 8 } },
            h('span', { style: S.hint }, 'AI 分类：'),
            h('button', {
              style: S.chip(categoryFilter === 'all' ? 'ok' : ''),
              onClick: () => setCategoryFilter('all'),
            }, `全部 ${filtered.length}`),
            ((data && data.categories) || []).map((group) =>
              h('button', {
                key: group.key,
                style: S.chip(categoryFilter === group.key ? 'ok' : ''),
                onClick: () => setCategoryFilter(group.key),
              }, `${group.label} ${group.skills.length}`)),
            h('button', { style: S.ghost, onClick: resetCategories }, '恢复自动分类'),
          ),
          h('div', { style: { ...S.toolbar, marginTop: 6 } },
            h('input', {
              style: { ...S.search, maxWidth: 200 },
              placeholder: '自定义分类名',
              value: customCategory,
              onChange: (event) => setCustomCategory(event.target.value),
            }),
            h('button', {
              style: S.ghost,
              disabled: !customCategory.trim() || selected.length === 0,
              onClick: applyCategory,
            }, selected.length ? `归入自定义（${selected.length}）` : '归入自定义'),
          ),
          h('div', { style: { ...S.toolbar, marginTop: 8 } },
            h('button', { style: S.ghost, onClick: () => setSelected(filtered.map((skill) => skill.name)) }, '全选'),
            h('button', { style: S.ghost, onClick: () => setSelected([]) }, '清空选择'),
            h('button', {
              style: S.ghost, disabled: bulkBusy || selected.length === 0,
              onClick: () => bulk({ enabled: true }),
            }, selected.length ? `批量开启 (${selected.length})` : '批量开启'),
            h('button', {
              style: S.ghost, disabled: bulkBusy || selected.length === 0,
              onClick: () => bulk({ enabled: false }),
            }, '批量关闭'),
            h('button', {
              style: S.ghost, disabled: bulkBusy || selected.length === 0,
              onClick: () => bulk({ pin: true }),
            }, '批量置顶'),
            h('button', {
              style: S.ghost, disabled: bulkBusy || selected.length === 0,
              onClick: () => bulk({ pin: false }),
            }, '取消置顶'),
          ),
          loading && !data
            ? h('div', { style: S.empty }, '读取中…')
            : filtered.length === 0
              ? h('div', { style: S.empty }, '没有匹配的技能')
              : h('div', null, filteredGroups.map((group) =>
                  h('div', { key: group.key, style: { marginTop: 10 } },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 6px' } },
                      h('strong', { style: { fontSize: 12 } }, group.label),
                      h('span', { style: S.badge('') }, String(group.skills.length)),
                      h('button', { style: S.ghost, onClick: () => setCategoryFilter(group.key) }, '只看此组'),
                      group.custom ? h('button', { style: S.linkDanger, onClick: () => deleteCategory(group.key) }, '删除分类') : null,
                    ),
                    h('div', { style: S.grid }, group.skills.map((name) => {
                      const skill = skillByName.get(name);
                      if (!skill) return null;
                      return h(SkillRow, {
                        key: skill.name, skill, busy: busyName === skill.name,
                        selected: selected.includes(skill.name), onSelect: toggleSelect,
                        onToggle: toggleSkill, onPin: pinSkill,
                        onDetail: loadDetail, detail: detail[skill.name],
                      });
                    }))))),
          h('div', { style: S.hint },
            `显示 ${filtered.length} / ${skills.length} 个。置顶技能在 skill_scout 打分时 +4；关闭状态写入 ${data ? data.storeDir : '…'}/state.json。`),
          error ? h('div', { style: S.err }, error) : null,
        ),

        h('div', { id: 'sec-stats', style: S.card },
          h('div', { style: S.cardHead },
            h('h3', { style: S.cardTitle }, '使用统计'),
            h('div', { style: S.toolbar },
              h('span', { style: S.seg },
                [['1d', '1 天'], ['7d', '7 天'], ['30d', '30 天']].map(([id, label]) =>
                  h('button', { key: id, style: S.segBtn(range === id), onClick: () => setRange(id) }, label)),
              ),
              h('button', { style: S.ghost, onClick: resetStats, disabled: busyName === 'reset' }, '清空统计'),
            ),
          ),
          usage
            ? h('div', { style: S.chartWrap },
                h('div', { style: S.legend },
                  h('span', null, h('span', { style: S.legendDot(COLORS.brand) }), `加载 ${usage.totals.loads}`),
                  h('span', null, h('span', { style: S.legendDot(COLORS.ok) }), `开关操作 ${usage.totals.toggles}`),
                  h('span', null, h('span', { style: S.legendDot(COLORS.sub) }), `AI 自动加载 ${usage.totals.autos}`),
                ),
                h('div', { style: { ...S.legend, marginTop: 4 } },
                  usage.totals.lastLoadAt ? `上次加载：${relTime(usage.totals.lastLoadAt)}` : '还没有加载记录',
                  ' · ',
                  usage.totals.lastToggleAt ? `上次开关：${relTime(usage.totals.lastToggleAt)}` : '还没有开关记录',
                  usage.totals.auditCount !== undefined ? ` · 审计 ${usage.totals.auditCount} 条` : '',
                ),
                h('div', { style: S.chartBox },
                  h('svg', {
                    viewBox: '0 0 620 132',
                    style: S.chartSvg,
                    preserveAspectRatio: 'none',
                    onMouseMove: (event) => {
                      if (!series.length) return;
                      const rect = event.currentTarget.getBoundingClientRect();
                      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
                      setHoverIndex(Math.round(ratio * (series.length - 1)));
                    },
                    onMouseLeave: () => setHoverIndex(null),
                  },
                    [0, 1, 2, 3].map((line) =>
                      h('line', {
                        key: line, x1: 8, x2: 612, y1: 22 + line * 32, y2: 22 + line * 32,
                        stroke: COLORS.border, strokeWidth: 1,
                      })),
                    h('polyline', {
                      points: linePoints, fill: 'none', stroke: COLORS.brand, strokeWidth: 2,
                      strokeLinejoin: 'round', strokeLinecap: 'round',
                    }),
                    h('polyline', {
                      points: togglePoints, fill: 'none', stroke: COLORS.ok, strokeWidth: 1.6,
                      strokeDasharray: '4 3', strokeLinejoin: 'round', strokeLinecap: 'round',
                    }),
                    series.map((point, index) =>
                      h('circle', {
                        key: index, cx: 8 + index * stepX, cy: 118 - (point.loads / maxLoads) * 96,
                        r: 2.4, fill: COLORS.brand,
                      })),
                    hoverIndex !== null && series[hoverIndex]
                      ? h('line', {
                          key: 'hover-line', x1: 8 + hoverIndex * stepX, x2: 8 + hoverIndex * stepX,
                          y1: 8, y2: 122, stroke: COLORS.sub, strokeWidth: 1, strokeDasharray: '3 3',
                        })
                      : null,
                    hoverIndex !== null && series[hoverIndex]
                      ? h('circle', {
                          key: 'hover-load', cx: 8 + hoverIndex * stepX,
                          cy: 118 - (series[hoverIndex].loads / maxLoads) * 96,
                          r: 4, fill: COLORS.brand,
                        })
                      : null,
                    hoverIndex !== null && series[hoverIndex]
                      ? h('circle', {
                          key: 'hover-toggle', cx: 8 + hoverIndex * stepX,
                          cy: 118 - (series[hoverIndex].toggles / maxToggles) * 96,
                          r: 3.5, fill: COLORS.ok,
                        })
                      : null,
                    h('text', { x: 8, y: 128, fontSize: 9, fill: COLORS.sub }, series[0] ? series[0].date.slice(5) : ''),
                    h('text', { x: 566, y: 128, fontSize: 9, fill: COLORS.sub },
                      series.length ? series[series.length - 1].date.slice(5) : ''),
                  ),
                  hoverIndex !== null && series[hoverIndex]
                    ? h('div', {
                        style: {
                          ...S.chartTip,
                          left: `clamp(60px, ${((8 + hoverIndex * stepX) / 620) * 100}%, calc(100% - 60px))`,
                          transform: hoverIndex >= series.length - 2
                            ? 'translateX(-100%)'
                            : hoverIndex <= 1 ? 'translateX(0)' : 'translateX(-50%)',
                        },
                      },
                        h('div', null, series[hoverIndex].date),
                        `加载 ${series[hoverIndex].loads} · 开关 ${series[hoverIndex].toggles} · 自动 ${series[hoverIndex].auto}`)
                    : null,
                ),
                h('div', { style: { ...S.legend, marginTop: 12 } }, '技能加载 Top 10'),
                topSkills.length === 0
                  ? h('div', { style: S.empty }, '这个区间还没有加载记录')
                  : topSkills.map((row) =>
                      h('div', { key: row.name, style: S.barRow },
                        h('span', { style: S.barName }, row.name),
                        h('span', { style: S.barTrack },
                          h('span', { style: S.barFill((row.count / maxTop) * 100) })),
                        h('span', { style: S.barCount }, String(row.count)),
                      )),
              )
            : h('div', { style: S.empty }, usageBusy ? '读取中…' : '暂无数据'),
          h('div', { style: { ...S.toolbar, marginTop: 12 } },
            h('button', { style: S.ghost, onClick: exportConfig, disabled: ioBusy }, '导出配置'),
            h('label', { style: { ...S.ghost, display: 'inline-flex', alignItems: 'center' } },
              '导入配置',
              h('input', {
                type: 'file', accept: '.json,application/json', style: { display: 'none' },
                onChange: importConfig,
              }),
            ),
          ),
        ),
      );

      const GROUP_OF_ID = Object.fromEntries(SECTIONS.map((section) => [section.id, section.group]));
      GROUP_OF_ID['sec-online'] = '能力';
      GROUP_OF_ID['sec-pro'] = '能力';
      GROUP_OF_ID['sec-skills'] = '能力';
      const visibleChildren = (panel.props.children || []).filter((child) => {
        const id = child && child.props && child.props.id;
        if (!id) return activeGroup === '运行';
        if (LITE && !LITE_SECTIONS.has(id) && !['sec-online', 'sec-pro', 'sec-skills'].includes(id)) return false;
        if (GROUP_OF_ID[id]) return GROUP_OF_ID[id] === activeGroup;
        return activeGroup === '运行';
      });
      const visiblePanel = h('div', { style: { ...S.page, maxWidth: 'none', padding: 0 } }, visibleChildren);
      const groupSections = (panel.props.children || [])
        .map((child) => child && child.props && child.props.id)
        .filter((id) => id && GROUP_OF_ID[id] === activeGroup && SECTIONS.some((section) => section.id === id))
        .map((id) => SECTIONS.find((section) => section.id === id));

      return h('div', { style: S.host },
        h('div', { style: S.card },
          h('div', { style: S.cardHead },
            h('h2', { style: S.title }, '技能领航员'),
            h('span', { style: S.hint }, '弹窗管理界面 · 视野更大'),
          ),
          h('p', { style: S.hint }, '点击打开管理面板；关闭后可在这里重新打开。'),
          h('button', { style: S.ghost, onClick: () => setPanelOpen(true) }, '打开管理面板'),
        ),
        panelOpen
          ? h('div', { style: S.modalOverlay, role: 'dialog', 'aria-modal': 'true' },
              h('div', { style: S.modal },
                h('div', { style: S.modalBar },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
                    h('span', {
                      style: {
                        width: 26, height: 26, borderRadius: 8,
                        background: `linear-gradient(135deg, ${COLORS.brand}, #a855f7)`,
                        display: 'inline-block', flex: 'none',
                      },
                    }),
                    h('div', null,
                      h('strong', { style: { fontSize: 14, letterSpacing: -0.1, display: 'block' } }, '技能领航员'),
                      h('span', { style: { fontSize: 10.5, color: COLORS.sub } }, '能力控制台 · 固定窗口'),
                    ),
                    h('span', { style: S.statusPill(settings.paused === true) }, settings.paused ? '已暂停' : '运行中'),
                  ),
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                    h('button', {
                      style: settings.paused ? S.primaryBtn : S.ghost,
                      disabled: controlBusy,
                      onClick: togglePause,
                    }, settings.paused ? '恢复' : '暂停'),
                    h('button', { style: S.ghost, onClick: () => (onClose ? onClose() : setPanelOpen(false)) }, '关闭'),
                  ),
                ),
                h('div', { style: { ...S.modalContent, flexDirection: 'column', alignItems: 'stretch', overflow: 'hidden' } },
                  h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 } },
                    (LITE ? ['运行', '能力', '配置'] : ['运行', '能力', '配置', '观察', '扩展']).map((group) =>
                      h('button', {
                        key: group,
                        style: {
                          ...S.ghost,
                          background: activeGroup === group ? COLORS.brand : 'transparent',
                          color: activeGroup === group ? '#fff' : COLORS.sub,
                          border: `1px solid ${activeGroup === group ? COLORS.brand : COLORS.border}`,
                        },
                        onClick: () => {
                          setActiveGroup(group);
                          const first = SECTIONS.find((section) => section.group === group);
                          if (first) setActiveSection(first.id);
                        },
                      }, group))),
                  h('div', { style: { display: 'flex', gap: 16, alignItems: 'stretch', flex: 1, minHeight: 0, width: '100%', overflow: 'hidden' } },
                    h('nav', {
                      style: { ...S.sideNav, width: narrow ? 128 : 180, maxHeight: '100%', overflow: 'auto', flex: 'none' },
                      'aria-label': '技能领航员分区导航',
                    },
                      groupSections.map((section) =>
                        h('button', {
                          key: section.id,
                          style: {
                            ...S.sideBtn,
                            background: activeSection === section.id ? COLORS.brand : 'transparent',
                            color: activeSection === section.id ? '#fff' : COLORS.sub,
                            fontWeight: activeSection === section.id ? 600 : 400,
                          },
                          'aria-current': activeSection === section.id ? 'true' : undefined,
                          onClick: () => jumpTo(section.id),
                        }, section.label))),
                    h('div', { ref: contentRef, onScroll: onContentScroll, style: { flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', paddingRight: 4 } }, visiblePanel),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    function SkillPilotOverview() {
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [inlineOpen, setInlineOpen] = useState(false);
      useEffect(() => {
        let alive = true;
        fetch('/skill-pilot/data', { cache: 'no-store' })
          .then((res) => res.json())
          .then((json) => { if (alive && json && json.ok) setData(json); })
          .catch((err) => { if (alive) setError(String((err && err.message) || err)); });
        return () => { alive = false; };
      }, []);
      const openPanel = () => {
        setInlineOpen(true);
      };
      if (inlineOpen) {
        return h(PanelBoundary, null, h(SkillPilotSettings, { onClose: () => setInlineOpen(false) }));
      }
      const counts = (data && data.counts) || {};
      const settings = (data && data.settings) || {};
      const external = data && data.interop ? data.interop.count : 0;
      const autonomy = String(settings.autonomy || 'standard');
      const saveAutonomy = async (value) => {
        try {
          const res = await fetch('/skill-pilot/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ autonomy: value }),
          });
          const json = await res.json();
          if (!json.ok) throw new Error(json.error || 'save failed');
          setData((prev) => (prev ? { ...prev, settings: { ...prev.settings, autonomy: value } } : prev));
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      };
      return h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('h2', { style: S.title }, '技能领航员'),
          h('span', { style: S.badge('ok') }, 'AI 能力管家'),
        ),
        h('p', { style: S.hint }, '自动检索、加载、获取、维护技能；这里是核心状态，需要完整控制台时再打开管理面板。'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginTop: 12 } },
          h('div', { style: S.metric }, h('div', { style: S.metricLabel }, '技能'), h('div', { style: S.metricValue }, String(counts.total || 0))),
          h('div', { style: S.metric }, h('div', { style: S.metricLabel }, '已启用'), h('div', { style: S.metricValue }, String(counts.enabled || 0))),
          h('div', { style: S.metric }, h('div', { style: S.metricLabel }, '本地发现'), h('div', { style: S.metricValue }, String(external || 0))),
          h('div', { style: S.metric }, h('div', { style: S.metricLabel }, '决策模式'), h('div', { style: S.metricValueSmall }, String(settings.autonomy || 'standard'))),
        ),
        h('div', { style: { ...S.hint, marginTop: 12 } },
          LITE ? '核心能力：能力地图 / 自动检索 / 缺口获取 / 安装校验' : '核心能力：能力地图 / 自动检索 / 缺口获取 / 安装校验 / 健康维护 / 备份审计'),
        h('div', { style: { marginTop: 12 } },
          h('div', { style: { ...S.hint, fontWeight: 600, marginBottom: 6 } }, 'AI 自主程度（AGI 程度）'),
          h('div', { style: S.toolbar },
            [['manual', '人工'], ['suggest', '建议'], ['standard', '标准'], ['full', '完全']].map(([value, label]) =>
              h('button', {
                key: value,
                style: {
                  ...S.ghost,
                  background: autonomy === value ? COLORS.brand : 'transparent',
                  color: autonomy === value ? '#fff' : COLORS.sub,
                  border: `1px solid ${autonomy === value ? COLORS.brand : COLORS.border}`,
                },
                onClick: () => saveAutonomy(value),
              }, label)),
          ),
          h('div', { style: { ...S.hint, marginTop: 4 } },
            autonomy === 'full'
              ? '完全自主：低风险技能可自动安装；medium/high 仍只提议，不会绕过安全底线。'
              : '人工=只给建议；建议=可提示；标准=可自动加载；完全=可自动安装低风险技能。'),
        ),
        h('div', { style: { ...S.toolbar, marginTop: 12 } },
          h('button', { style: S.primaryBtn, onClick: openPanel }, '打开管理面板'),
          h('button', { style: S.ghost, onClick: () => { fetch('/skill-pilot/data', { cache: 'no-store' }).then((r) => r.json()).then((json) => { if (json && json.ok) setData(json); }).catch(() => {}); } }, '刷新摘要'),
          error ? h('span', { style: S.hint }, `摘要读取失败：${error}`) : null,
        ),
      );
    }

    function SkillPilotQuickOpen() {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        const check = () => {
          if (typeof window !== 'undefined' && window.location && window.location.hash === '#skill-pilot') {
            setOpen(true);
          }
        };
        check();
        if (typeof window !== 'undefined') window.addEventListener('hashchange', check);
        return () => { if (typeof window !== 'undefined') window.removeEventListener('hashchange', check); };
      }, []);
      if (!open) return null;
      return h('div', { style: { position: 'fixed', inset: 0, zIndex: 2147483000 } },
        h(SafeSettings, {
          onClose: () => {
            setOpen(false);
            if (typeof window !== 'undefined' && window.location.hash === '#skill-pilot') {
              window.history.replaceState(null, '', window.location.pathname + window.location.search);
            }
          },
        }));
    }

    function OpenSkillPilotButton() {
      return h('div', { style: { padding: '2px 0' } },
        h('button', {
          style: {
            border: '1px solid #2f6feb', background: '#1f6feb', color: '#fff',
            borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer',
          },
          onClick: () => {
            if (typeof window !== 'undefined' && window.location) window.location.hash = '#skill-pilot';
          },
        }, '打开技能领航员'));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'skill-pilot', order: 24, label: '技能领航员',
        }, SkillPilotOverview));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'skill-pilot-quick-open', order: 60,
        }, SkillPilotQuickOpen));
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview', key: 'open_skill_pilot',
        }, OpenSkillPilotButton));
      },
    };
  },
});

