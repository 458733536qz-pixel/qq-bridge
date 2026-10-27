// 模型 provider 选择的回归：配置优先、目录兜底。
//
// 背景：2026-10-27 15:24，重启 DSH 后实例只暴露 deepseek-account，而配置写着
// deepseek-official —— 每条消息 session/model-unavailable，QQ 上只剩
// 「agent 处理出错：(含敏感信息，已隐藏)」。这条 bug 不会抛异常、不会让进程退出，
// 只会让她静默失联，所以必须有测试钉住。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickProvider } from '../src/provider-pick.js';

const catalog = (providers, groups) => ({ routableProviders: providers, groups, failures: [] });

test('配置的 provider 在目录里：原样用它', () => {
  const c = catalog(['deepseek-official', 'deepseek-account'], []);
  assert.equal(pickProvider(c, 'deepseek-official', 'deepseek-flash'), 'deepseek-official');
});

test('配置的 provider 不在目录里：挑真的带这个模型的那个', () => {
  const c = catalog(['deepseek-account', 'other-provider'], [
    { id: 'deepseek-account', models: [{ id: 'deepseek-v4-pro' }] },
    { id: 'other-provider', models: [{ id: 'deepseek-flash' }] },
  ]);
  assert.equal(pickProvider(c, 'deepseek-official', 'deepseek-flash'), 'other-provider');
});

test('实际故障复现：只有 deepseek-account 时必须换过去', () => {
  const c = catalog(['deepseek-account'], [
    { id: 'deepseek-account', models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] },
  ]);
  assert.equal(pickProvider(c, 'deepseek-official', 'deepseek-flash'), 'deepseek-account');
});

test('目录里没有带该模型的 provider：退回第一个可用 provider', () => {
  const c = catalog(['a', 'b'], [{ id: 'a', models: [{ id: 'x' }] }, { id: 'b', models: [{ id: 'y' }] }]);
  assert.equal(pickProvider(c, 'official', 'deepseek-flash'), 'a');
});

test('目录为空/形状不认识：原样返回配置值（不要瞎猜）', () => {
  assert.equal(pickProvider(null, 'deepseek-official', 'deepseek-flash'), 'deepseek-official');
  assert.equal(pickProvider({}, 'deepseek-official', 'deepseek-flash'), 'deepseek-official');
  assert.equal(pickProvider(catalog([], []), 'deepseek-official', 'deepseek-flash'), 'deepseek-official');
  assert.equal(pickProvider(catalog(['p'], null), 'deepseek-official', 'deepseek-flash'), 'p');
});
