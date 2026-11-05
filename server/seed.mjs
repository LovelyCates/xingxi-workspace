export function seed(store) {
  if (store.spaces().length) return;
  const work = store.createSpace({
    name: '造一座知识花园',
    kind: 'work',
    description: '示例项目 · 从零散灵感，到有出处的项目知识。',
  });
  const source = store.ingest(work.id, {
    title: '示例 · 知识花园产品讨论',
    origin: 'example',
    body: `这是虚构的示例项目资料，不代表使用者的真实信息。
产品目标：让项目资料沉淀为可追溯、可持续更新的知识花园。
本地优先：原始资料和记忆存储在本机，只有调用模型时发送必要片段。
信息分三层：不可变原始资料、可编辑知识条目、检索与关系索引。
任何结论必须保留来源摘录，未经确认的模型提炼保留为候选。
工作项目与陪伴空间各自独立，检索不能跨空间混入资料。
星图用于探索概念关系；星册用于阅读、编辑和查看出处。
星历记录记忆的创建与修订；星工坊负责导入资料和对话设定。
对话应延续未完成的话题，同时允许用户纠正已经过时的记忆。
MCP 提供检索、资料入库和持久会话接口；客户端需要保留会话 ID。
待研究：何时需要向量检索，以及长文档分段如何不丢失上下文。
首版决定：先做好单用户本机运行与可靠引用，再扩展协作功能。
验收标准：一份资料能从导入、提炼、确认走到有引用的对话。`,
  });
  const specs = [
    ['知识花园', 'concept', '产品目标：让项目资料沉淀为可追溯、可持续更新的知识花园。'],
    ['本地优先', 'decision', '本地优先：原始资料和记忆存储在本机，只有调用模型时发送必要片段。'],
    ['三层知识结构', 'concept', '信息分三层：不可变原始资料、可编辑知识条目、检索与关系索引。'],
    ['每条结论都有出处', 'decision', '任何结论必须保留来源摘录，未经确认的模型提炼保留为候选。'],
    ['空间边界', 'decision', '工作项目与陪伴空间各自独立，检索不能跨空间混入资料。'],
    ['星图与星册', 'concept', '星图用于探索概念关系；星册用于阅读、编辑和查看出处。'],
    ['沿时间生长', 'concept', '星历记录记忆的创建与修订；星工坊负责导入资料和对话设定。'],
    ['话题的连续性', 'concept', '对话应延续未完成的话题，同时允许用户纠正已经过时的记忆。'],
    [
      '让 Agent 接上记忆',
      'concept',
      'MCP 提供检索、资料入库和持久会话接口；客户端需要保留会话 ID。',
    ],
    ['检索的下一步', 'question', '待研究：何时需要向量检索，以及长文档分段如何不丢失上下文。'],
    ['先完成一个闭环', 'decision', '首版决定：先做好单用户本机运行与可靠引用，再扩展协作功能。'],
    ['如何判断有效', 'question', '验收标准：一份资料能从导入、提炼、确认走到有引用的对话。'],
  ];
  const entries = specs.map(([title, kind, body]) => {
    const e = store.propose(work.id, {
      title,
      kind,
      body,
      evidence: [{ sourceId: source.id, quote: body }],
    });
    return store.updateEntry(work.id, e.id, { revision: e.revision, status: 'accepted' });
  });
  [
    [0, 1, '采用'],
    [0, 2, '组织为'],
    [2, 3, '要求'],
    [1, 4, '约束'],
    [2, 5, '呈现为'],
    [5, 6, '记录于'],
    [8, 4, '遵循'],
    [8, 7, '支持'],
    [2, 9, '待研究'],
    [0, 10, '范围'],
    [10, 11, '验证于'],
    [7, 3, '依据'],
  ].forEach(([a, b, label]) =>
    store.relate(work.id, { fromId: entries[a].id, toId: entries[b].id, label }),
  );
  const companion = store.createSpace({
    name: '日常的回声',
    kind: 'companion',
    description: '示例陪伴空间 · 留住一起聊过的小事，也给新的故事留白。',
  });
  const cs = store.ingest(companion.id, {
    title: '示例 · 一次傍晚的闲聊',
    origin: 'example',
    body: '这是虚构的对话示例，不是使用者的真实经历。\n用户：忙了一天，我喜欢先随便聊几句，再考虑要不要解决问题。\n用户：回复可以短一点，像聊天一样，不用每次都列清单。\n用户：今天终于把搁置很久的草稿整理完了。\n用户：下次我们可以继续聊怎么安排周末的独处时间。',
  });
  [
    ['先聊聊，再想办法', 'preference', '我喜欢先随便聊几句，再考虑要不要解决问题。'],
    ['自然的聊天节奏', 'preference', '回复可以短一点，像聊天一样，不用每次都列清单。'],
    ['完成搁置的草稿', 'experience', '今天终于把搁置很久的草稿整理完了。'],
    ['一个未完的话题', 'agreement', '下次我们可以继续聊怎么安排周末的独处时间。'],
  ].forEach(([title, kind, quote]) => {
    const e = store.propose(companion.id, {
      title,
      kind,
      body: quote,
      evidence: [{ sourceId: cs.id, quote }],
    });
    store.updateEntry(companion.id, e.id, { revision: 1, status: 'accepted' });
  });
}
