// 人格卡按仿真模式取用（src/role-card.js）的离线单测。
// 保证：模式标记能被正确识别与剥离、未标记的老卡片行为不变、真实人格卡可用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { findRecallSection, parseRecallSections, parseRoleSections, pickRecallSections, recallSectionIndex, roleCharStats, roleSectionReport, selectRoleText } from '../src/role-card.js';

const CARD = [
  '# 角色卡：测试',
  '',
  '## 一、你是谁',
  '- 你是群里的测试角色。',
  '',
  '## 二、分条方式 〔一代〕',
  '- 想分条就用空格分隔；想沉默就输出 [SILENT]。',
  '',
  '## 三、发言方式 〔二代〕',
  '- 用 qq_send_message 的数组分条，潜水走 qq_mark_read。',
  '',
  '## 四、说话风格',
  '- 简短、口语化。',
].join('\n');

test('模式标记能被识别，未标记的小节两种模式都注入', () => {
  const sections = parseRoleSections(CARD);
  const byHeading = Object.fromEntries(sections.filter((s) => s.heading).map((s) => [s.heading, s.mode]));
  assert.equal(byHeading['一、你是谁'], 'all');
  assert.equal(byHeading['二、分条方式'], 'v1');
  assert.equal(byHeading['三、发言方式'], 'v2');
  assert.equal(byHeading['四、说话风格'], 'all');
});

test('按模式筛选：只保留公共小节 + 该模式专属小节', () => {
  const v1 = selectRoleText(CARD, 'v1');
  const v2 = selectRoleText(CARD, 'v2');
  // 公共内容两边都有
  for (const text of [v1, v2]) {
    assert.match(text, /你是群里的测试角色/);
    assert.match(text, /简短、口语化/);
  }
  // 专属内容互不串场
  assert.match(v1, /空格分隔/);
  assert.doesNotMatch(v1, /qq_send_message/);
  assert.match(v2, /qq_send_message/);
  assert.doesNotMatch(v2, /\[SILENT\]/);
});

test('注入文本里不再残留模式标记', () => {
  assert.doesNotMatch(selectRoleText(CARD, 'v1'), /〔一代〕|〔二代〕/);
  assert.doesNotMatch(selectRoleText(CARD, 'v2'), /〔一代〕|〔二代〕/);
  // 标题保留但已清洗
  assert.match(selectRoleText(CARD, 'v2'), /## 三、发言方式\n/);
});

test('多种标记写法都认（[v1] / （reserved2） / 2 代）', () => {
  const card = [
    '## A [v1]', '- a',
    '## B （reserved2）', '- b',
    '## C 〔2 代〕', '- c',
    '## D [一代]', '- d',
  ].join('\n');
  const v1 = selectRoleText(card, 'v1');
  const v2 = selectRoleText(card, 'v2');
  assert.match(v1, /- a/); assert.match(v1, /- d/);
  assert.doesNotMatch(v1, /- b/); assert.doesNotMatch(v1, /- c/);
  assert.match(v2, /- b/); assert.match(v2, /- c/);
  assert.doesNotMatch(v2, /- a/); assert.doesNotMatch(v2, /- d/);
});

test('没有模式标记的老卡片：两种模式都完整注入（向后兼容）', () => {
  const legacy = '# 老卡\n\n- 性格：傲娇\n- 说话风格：简短';
  assert.equal(selectRoleText(legacy, 'v1'), legacy);
  assert.equal(selectRoleText(legacy, 'v2'), legacy);
});

test('标题之外的内容（前言）不受影响', () => {
  const card = '开头一句话\n\n## X 〔一代〕\n- x\n\n## Y\n- y';
  assert.match(selectRoleText(card, 'v2'), /开头一句话/);
  assert.doesNotMatch(selectRoleText(card, 'v2'), /- x/);
  assert.match(selectRoleText(card, 'v2'), /- y/);
});

test('统计与小节报告可用于控制台预览', () => {
  const stats = roleCharStats(CARD);
  assert.ok(stats.v1Only > 0 && stats.v2Only > 0, '应能统计出两代各自专属的字符数');
  assert.ok(stats.v1 < stats.total && stats.v2 < stats.total, '筛选后应短于原文');
  assert.notEqual(stats.v1, stats.v2, '两代内容不同，长度不应相等');
  const report = roleSectionReport(CARD, 'v1');
  const v2Section = report.find((r) => r.heading === '三、发言方式');
  assert.equal(v2Section.injected, false, '二代专属小节在一代下应标为不注入');
  const common = report.find((r) => r.heading === '一、你是谁');
  assert.equal(common.injected, true);
});

test('真实人格卡可用，且筛选不丢公共内容', () => {
  const file = new URL('../roles/小鲸鱼.md', import.meta.url);
  const raw = fs.readFileSync(file, 'utf8');
  const v2 = selectRoleText(raw, 'v2');
  const v1 = selectRoleText(raw, 'v1');
  assert.ok(v2.length > 0 && v1.length > 0);
  // 人设部分两种模式都必须保留
  for (const text of [v1, v2]) {
    assert.match(text, /小鲸鱼/);
    assert.match(text, /AI 味|去 AI 味/);
  }
  // 二代注入的文本里不应再出现一代的分条机制
  assert.doesNotMatch(v2, /空格分隔（例如|\[SILENT\]/);
});

// ── 「核心约束 + 按需召回」──────────────────────────────────────────────
const RECALL = [
  '# 召回文件',
  '',
  '## 〔触发: 照片|长相|自拍〕 外形与样子',
  '- 冷白皮，脸很小。',
  '',
  '## 〔触发: 生气|吵架|哄〕 生气详解',
  '- 回复变短，语气变冷。',
  '',
  '## 〔触发: 帮我|查一下〕 小秘书',
  '- 结论先说。',
].join('\n');

test('召回小节：标题里的触发词被拆开，普通标题结束小节', () => {
  const sections = parseRecallSections(RECALL);
  assert.deepEqual(sections.map((s) => s.title), ['外形与样子', '生气详解', '小秘书']);
  assert.deepEqual(sections[0].triggers, ['照片', '长相', '自拍']);
  assert.equal(sections[1].body, '- 回复变短，语气变冷。');
  // 一级标题只是分隔，不会变成召回小节
  assert.ok(!sections.some((s) => s.title === '召回文件'));
});

test('召回：按关键词命中，没命中就什么都不带', () => {
  const hit = pickRecallSections(RECALL, '给我看下照片呗');
  assert.deepEqual(hit.picked, ['外形与样子']);
  assert.match(hit.text, /冷白皮/);
  const miss = pickRecallSections(RECALL, '今天天气不错');
  assert.equal(miss.text, '');
  assert.deepEqual(miss.picked, []);
  // 空消息不乱召回
  assert.equal(pickRecallSections(RECALL, '   ').text, '');
});

test('召回：更长的触发词优先，limit 生效', () => {
  const two = pickRecallSections(RECALL, '你帮我查一下那个东西，顺便发张照片', { limit: 2 });
  assert.equal(two.picked.length, 2, 'limit=2 应最多两节');
  assert.equal(two.picked[0], '小秘书', '更具体/更长的触发词应先命中');
  const one = pickRecallSections(RECALL, '你帮我查一下那个东西，顺便发张照片', { limit: 1 });
  assert.deepEqual(one.picked, ['小秘书']);
});

test('召回：超预算时截断并留下「用 section 看全」的提示', () => {
  const long = ['## 〔触发: 长文〕 很长的一节', '- ' + '字'.repeat(600)].join('\n');
  const picked = pickRecallSections(long, '来点长文', { maxChars: 300 });
  assert.deepEqual(picked.picked, ['很长的一节']);
  assert.ok(picked.text.length < 420, '应被预算截住');
  assert.match(picked.text, /qq_get_prompt/);
});

test('召回目录与按名字取节（精确 / 包含 / 触发词）', () => {
  const index = recallSectionIndex(RECALL);
  assert.deepEqual(index.map((s) => s.title), ['外形与样子', '生气详解', '小秘书']);
  assert.ok(index.every((s) => s.chars > 0 && s.triggers.length > 0));
  assert.equal(findRecallSection(RECALL, '外形与样子').title, '外形与样子');
  assert.equal(findRecallSection(RECALL, '生气').title, '生气详解');
  assert.equal(findRecallSection(RECALL, '吵架').title, '生气详解');
  assert.equal(findRecallSection(RECALL, '不存在的一节'), null);
});

test('真实人格卡：core 与 recall 可解析，核心明显短于整卡', () => {
  const coreFile = new URL('../roles/鱼小冷.core.md', import.meta.url);
  const recallFile = new URL('../roles/鱼小冷.recall.md', import.meta.url);
  const fullFile = new URL('../roles/鱼小冷.md', import.meta.url);
  const core = fs.readFileSync(coreFile, 'utf8');
  const recall = fs.readFileSync(recallFile, 'utf8');
  const full = fs.readFileSync(fullFile, 'utf8');
  assert.ok(core.length > 1000, '核心卡不应为空');
  assert.ok(core.length < full.length * 0.45, `核心应明显短于整卡（core=${core.length} full=${full.length}）`);
  const sections = parseRecallSections(recall);
  assert.ok(sections.length >= 6, '召回细节应拆成多节');
  for (const section of sections) {
    assert.ok(section.triggers.length > 0, `${section.title} 缺触发词`);
    assert.ok(section.body.length <= 1600, `${section.title} 太长（${section.body.length}）`);
  }
  // 核心卡里的关键硬约束必须还在
  for (const must of ['球球', '不要客服腔', '不编造', '不查岗']) {
    assert.match(core, new RegExp(must.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `核心卡缺「${must}」`);
  }
  // 召回要能被常见话术命中
  assert.ok(pickRecallSections(recall, '你长什么样，发张照片').picked.length > 0);
  assert.ok(pickRecallSections(recall, '你是不是生气了').picked.length > 0);
});

test('关键约束不丢：V3.0 的硬规则都能在 core 或 recall 里找到', () => {
  const core = fs.readFileSync(new URL('../roles/鱼小冷.core.md', import.meta.url), 'utf8');
  const recall = fs.readFileSync(new URL('../roles/鱼小冷.recall.md', import.meta.url), 'utf8');
  const bag = `${core}\n${recall}`;
  const rules = [
    ['被问 AI 要诚实', /必须诚实回答|诚实回答/],
    ['不许冒充现实真人', /不冒充现实中的真人|不装作现实里的真人/],
    ['不编造经历/结果', /不编造|不能编造/],
    ['不假装发过东西', /不假装|不能假装/],
    ['不要客服腔', /客服腔|我理解你的感受/],
    ['不用动漫傲娇腔', /动漫傲娇|本小姐/],
    ['不用括号写动作', /不用括号|不使用括号/],
    ['不限字数（别强制短）', /不限字数|不限制字数/],
    ['不每轮固定两条', /固定发两条|固定发送两条/],
    ['不每条都追问', /不每条结尾追问|不要每次最后提问/],
    ['允许没意义的对话', /允许没意义的对话|没有实际意义/],
    ['冷静期/生气不翻旧账', /不翻旧账/],
    ['好感度不编数值', /不主动播报|不能凭空编造/],
    ['办事正事优先', /正事优先/],
  ];
  const missing = rules.filter(([, re]) => !re.test(bag)).map(([label]) => label);
  assert.deepEqual(missing, [], `这些硬规则在 core/recall 里找不到：${missing.join('、')}`);
});
