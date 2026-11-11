const NOTES = [
  {
    id: "note-architecture",
    identifier: "NOTE-1",
    title: "插件架构",
    subtitle: "声明式贡献 + 沙箱 iframe",
    resourceType: "note",
    text: "请总结插件架构：声明式贡献与沙箱 iframe 的边界。",
  },
  {
    id: "note-security",
    identifier: "NOTE-2",
    title: "沙箱安全",
    subtitle: "无同源、严格 CSP、postMessage 白名单",
    resourceType: "note",
    text: "请检查插件视图的沙箱安全约束。",
  },
  {
    id: "note-testing",
    identifier: "NOTE-3",
    title: "测试清单",
    subtitle: "协议、权限、路径穿越",
    resourceType: "note",
    text: "请补充插件宿主的安全测试。",
  },
];

export function readNotes(query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return NOTES;
  return NOTES.filter(
    (note) =>
      note.title.toLowerCase().includes(normalized) ||
      note.subtitle.toLowerCase().includes(normalized) ||
      note.text.toLowerCase().includes(normalized),
  );
}
