// 从 DSH 的模型目录里挑一个**现在真的能用**的 provider。
//
// 为什么需要这层（2026-10-27 15:24 的真实故障）：
//   bridge 的 config.json 写着 `provider: deepseek-official`，而同一个 app 起来的两台
//   dsh web 实例，可用 provider 并不一样：后起的那个实例只暴露 `deepseek-account`。
//   于是重启 DSH 之后，每一条消息都 `session/model-unavailable`，QQ 上只剩
//   「agent 处理出错：(含敏感信息，已隐藏)」——写死 provider 的代价是一整个静默停机。
//
// 规则（保守）：配置里的优先；它不在目录里时，挑**确实有这个模型**的那个；
// 再不行退回第一个可用 provider；目录为空/形状不认识就原样返回配置值。
export function pickProvider(catalog, preferred, model) {
  const want = String(preferred ?? '').trim();
  const modelId = String(model ?? '').trim();
  const providers = Array.isArray(catalog?.routableProviders)
    ? catalog.routableProviders.map((p) => String(p ?? '').trim()).filter(Boolean)
    : [];
  if (!providers.length) return want;
  if (want && providers.includes(want)) return want;
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  for (const provider of providers) {
    const group = groups.find((g) => g && String(g.id) === provider);
    const models = Array.isArray(group?.models) ? group.models : [];
    if (models.some((m) => m && String(m.id) === modelId)) return provider;
  }
  return providers[0];
}
